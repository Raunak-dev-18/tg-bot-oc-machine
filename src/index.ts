// Entry point: Telegram long-polling loop + opencode brain + guardrails.
// Text messages go to opencode; photos/documents are downloaded and attached
// via `opencode run -f`; agent questions (:::ASK blocks) render as buttons.
import { execFile } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./config.js";
import { PendingQuestions, parseAskBlocks, stripAskBlocks } from "./interact.js";
import { getVerboseModels, listPlainModels, listSessions, lookupModel } from "./models.js";
import { runOpencode } from "./opencode.js";
import { ensureServe, isServeHealthy } from "./serve.js";
import { Store } from "./store.js";
import {
  TgApi,
  chunkText,
  extractMedia,
  extractText,
  type ReplyMarkup,
} from "./telegram.js";

const HELP_TEXT = [
  "🤖 Remote machine control via opencode",
  "",
  "Send any message — it goes to opencode on this machine, which can",
  "deploy/run apps, clone repos, edit files, run shell, etc.",
  "Send 📷 photos or 📎 files too — the agent can see/read them.",
  "When the agent needs a decision, you'll get tappable option buttons.",
  "",
  "Commands:",
  "/start — welcome + status",
  "/help — this help",
  "/status — bot + opencode health",
  "/new or /reset — forget conversation, start fresh session",
  "/free — list FREE models (👁 = sees images), then /model <number>",
  "/models [provider] — list models, then /model <number>",
  "/model <number|provider/model> — switch model for this chat",
  "/model — show current model",
  "/sessions — list recent opencode sessions, then /switch <number>",
  "/switch <number|session-id> — continue a different session",
  "/agent <name> — switch opencode agent (default: build)",
  "/exec <shell command> — run shell directly, no AI",
].join("\n");

const MAX_TG_FILE_BYTES = 20 * 1024 * 1024;

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { cwd, timeout: Math.min(timeoutMs, 300_000), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)";
      resolve({ out: out.slice(0, 15_000), code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0 });
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new TgApi(config.token);
  const store = new Store(config.dataDir);
  await store.load();
  const inboxDir = path.join(config.dataDir, "inbox");
  const pending = new PendingQuestions();

  if (config.allowedUsers.size === 0) {
    console.warn(
      "⚠️  SECURITY: TELEGRAM_ALLOWED_USERS is empty — ANY Telegram user who finds this bot can execute commands on this machine. " +
        "Set TELEGRAM_ALLOWED_USERS=<your-numeric-id> to lock it down. Get your id via @userinfobot.",
    );
  }
  if (config.autoApprove) {
    console.warn("⚠️  opencode --auto is ON: the agent may run shell/tools without confirmation. Keep the user whitelist tight.");
  }
  console.log(`[bot] workDir=${config.workDir} dataDir=${config.dataDir} token=${maskToken(config.token)}`);

  const me = await api.getMe();
  console.log(`[bot] logged in as @${me.username} (id ${me.id})`);

  const { serverUrl } = await ensureServe({
    bin: config.opencodeBin,
    cwd: config.workDir,
    port: config.servePort,
    enabled: config.autoServe,
  });
  // Explicit OPENCODE_SERVER_URL wins over the auto-started server.
  const attachUrl = config.serverUrl ?? serverUrl;
  if (attachUrl) console.log(`[bot] opencode runs will --attach ${attachUrl}`);

  const startedAt = Date.now();
  const busyChats = new Set<number>();
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("[bot] shutting down…");
    void store.flush().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function isAllowed(fromId: number | undefined): boolean {
    return config.allowedUsers.size === 0 || (fromId !== undefined && config.allowedUsers.has(fromId));
  }

  /** Shared pipeline: prompt (+optional files) → opencode → reply + ASK buttons. */
  async function forwardToOpencode(chatId: number, replyTo: number | undefined, prompt: string, files?: string[]): Promise<void> {
    if (busyChats.has(chatId)) {
      await api.sendMessage(chatId, "⏳ Still working on the previous request — please wait.", replyTo);
      return;
    }
    busyChats.add(chatId);
    const typingTimer = setInterval(() => void api.sendChatAction(chatId, "typing"), 4000);
    const progressTimer = { lastNote: 0 };
    try {
      await api.sendChatAction(chatId, "typing");
      const t0 = Date.now();
      const chatKey = String(chatId);
      const state = store.getChat(chatKey);
      const result = await runOpencode({
        prompt,
        sessionId: state.sessionId,
        isNewSession: !state.sessionId,
        model: state.model ?? config.model,
        agent: state.agent ?? config.agent,
        autoApprove: config.autoApprove,
        timeoutMs: config.timeoutMs,
        cwd: config.workDir,
        bin: config.opencodeBin,
        serverUrl: attachUrl,
        files,
        onProgress: (note) => {
          const now = Date.now();
          if (now - progressTimer.lastNote > 20_000) {
            progressTimer.lastNote = now;
            console.log(`[opencode] chat ${chatId}: ${note}`);
          }
        },
      });
      if (result.sessionId) store.setChat(chatKey, { ...state, sessionId: result.sessionId });
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`[opencode] chat ${chatId}: done in ${secs}s, session ${result.sessionId ?? "?"}, ${result.text.length} chars`);

      const questions = parseAskBlocks(result.text);
      const body = stripAskBlocks(result.text);
      const footer =
        result.tokens || result.cost !== undefined
          ? `\n\n— done in ${secs}s${result.tokens ? ` · tokens ${result.tokens.input}in/${result.tokens.output}out` : ""}${result.cost !== undefined ? ` · $${result.cost.toFixed(4)}` : ""}`
          : `\n\n— done in ${secs}s`;
      if (body) await api.sendChunked(chatId, body + (questions.length > 0 ? "" : footer), replyTo);

      for (const q of questions) {
        if (q.options.length > 0) {
          const keyboard: ReplyMarkup = {
            inline_keyboard: q.options.map((opt) => {
              const token = pending.add({ chatId, sessionId: result.sessionId, question: q.question, option: opt, createdAt: Date.now() });
              return [{ text: opt.slice(0, 40), callback_data: `q:${token}` }];
            }),
          };
          await api.sendMessage(chatId, `❓ ${q.question}`, undefined, keyboard);
        } else {
          await api.sendMessage(chatId, `❓ ${q.question}\n\n(Reply with your answer in chat.)`);
        }
      }
      if (questions.length > 0 && !body) await api.sendMessage(chatId, footer.trim());
    } catch (err) {
      console.error(`[opencode] chat ${chatId}: FAILED ${(err as Error).message.slice(0, 300)}`);
      await api.sendMessage(chatId, `❌ ${(err as Error).message.slice(0, 3000)}`, replyTo);
    } finally {
      clearInterval(typingTimer);
      busyChats.delete(chatId);
    }
  }

  async function resolveModelId(chatKey: string, raw: string): Promise<string | undefined> {
    const state = store.getChat(chatKey);
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      return state.modelList?.[idx];
    }
    if (raw.includes("/")) return raw;
    const hit = state.modelList?.find((id) => id === `opencode/${raw}` || id.endsWith(`/${raw}`));
    return hit ?? raw;
  }

  async function handleMessage(chatId: number, replyTo: number, text: string): Promise<void> {
    const chatKey = String(chatId);
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (cmd === "/start" || cmd === "/help") {
      const state = store.getChat(chatKey);
      await api.sendChunked(
        chatId,
        cmd === "/start"
          ? `👋 Hi! I'm the remote control for this machine.\nSession: ${state.sessionId ? `${state.sessionId.slice(0, 12)}…` : "none yet"}\n\n${HELP_TEXT}`
          : HELP_TEXT,
        replyTo,
      );
      return;
    }

    if (cmd === "/status") {
      const state = store.getChat(chatKey);
      const healthy = attachUrl ? await isServeHealthy(attachUrl) : true;
      const uptimeMin = Math.round((Date.now() - startedAt) / 60000);
      await api.sendMessage(
        chatId,
        [
          "📊 Status",
          `bot uptime: ${uptimeMin}m`,
          `workDir: ${config.workDir}`,
          `opencode server: ${attachUrl ? `${attachUrl} (${healthy ? "healthy" : "UNREACHABLE"})` : "per-message runs"}`,
          `session: ${state.sessionId ?? "none yet"}`,
          `model override: ${state.model ?? config.model ?? "(opencode default)"}`,
          `agent: ${state.agent ?? config.agent}`,
          `auto-approve: ${config.autoApprove ? "ON" : "OFF"}`,
        ].join("\n"),
        replyTo,
      );
      return;
    }

    if (cmd === "/new" || cmd === "/reset") {
      store.clearChat(chatKey);
      await api.sendMessage(chatId, "🔄 Session cleared. Next message starts a fresh opencode session.", replyTo);
      return;
    }

    if (cmd === "/free") {
      await api.sendChatAction(chatId, "typing");
      try {
        const models = await getVerboseModels({ bin: config.opencodeBin, cwd: config.workDir, dataDir: config.dataDir, provider: "opencode" });
        const free = models.filter((m) => m.free);
        if (free.length === 0) {
          await api.sendMessage(chatId, "No free models found for provider 'opencode'. Try /models.", replyTo);
          return;
        }
        const state = store.getChat(chatKey);
        store.setChat(chatKey, { ...state, modelList: free.map((m) => m.id) });
        const lines = free.map(
          (m, i) => `${i + 1}. ${m.id}${m.vision ? " 👁" : ""}${m.contextK ? ` · ${m.contextK}k ctx` : ""}`,
        );
        await api.sendChunked(
          chatId,
          `🆓 Free models (opencode provider):\n${lines.join("\n")}\n\n👁 = can see images. Switch with /model <number|id>.`,
          replyTo,
        );
      } catch (err) {
        await api.sendMessage(chatId, `❌ ${(err as Error).message.slice(0, 1000)}`, replyTo);
      }
      return;
    }

    if (cmd === "/models") {
      await api.sendChatAction(chatId, "typing");
      try {
        const ids = await listPlainModels({ bin: config.opencodeBin, cwd: config.workDir, provider: arg || undefined });
        if (ids.length === 0) {
          await api.sendMessage(chatId, "No models found. Try /models without args or /free.", replyTo);
          return;
        }
        const state = store.getChat(chatKey);
        store.setChat(chatKey, { ...state, modelList: ids });
        const lines = ids.map((id, i) => `${i + 1}. ${id}`);
        await api.sendChunked(
          chatId,
          `🧠 Models${arg ? ` (${arg})` : ""} — ${ids.length} total:\n${lines.join("\n")}\n\nSwitch with /model <number|id>. Use /free for free ones.`,
          replyTo,
        );
      } catch (err) {
        await api.sendMessage(chatId, `❌ ${(err as Error).message.slice(0, 1000)}`, replyTo);
      }
      return;
    }

    if (cmd === "/model") {
      const state = store.getChat(chatKey);
      if (!arg) {
        await api.sendMessage(chatId, `Current model override: ${state.model ?? config.model ?? "(opencode default)"}\nUse /free or /models to browse, then /model <number|id>.`, replyTo);
        return;
      }
      const resolved = await resolveModelId(chatKey, arg);
      if (!resolved) {
        await api.sendMessage(chatId, `Unknown model "${arg}". Use /free or /models to get a number first.`, replyTo);
        return;
      }
      store.setChat(chatKey, { ...state, model: resolved });
      await api.sendMessage(chatId, `✅ Model set to ${resolved} for this chat (applies from your next message).`, replyTo);
      return;
    }

    if (cmd === "/sessions") {
      await api.sendChatAction(chatId, "typing");
      try {
        const sessions = await listSessions({ bin: config.opencodeBin, cwd: config.workDir });
        if (sessions.length === 0) {
          await api.sendMessage(chatId, "No opencode sessions yet.", replyTo);
          return;
        }
        const state = store.getChat(chatKey);
        store.setChat(chatKey, { ...state, sessionList: sessions.slice(0, 30) });
        const lines = sessions.slice(0, 30).map((s, i) => `${i + 1}. ${s.title}\n   ${s.id}${s.id === state.sessionId ? " ← current" : ""}`);
        await api.sendChunked(chatId, `📚 Recent sessions:\n${lines.join("\n")}\n\nJump with /switch <number|id>.`, replyTo);
      } catch (err) {
        await api.sendMessage(chatId, `❌ ${(err as Error).message.slice(0, 1000)}`, replyTo);
      }
      return;
    }

    if (cmd === "/switch") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /switch <number|session-id> (see /sessions).", replyTo);
        return;
      }
      const state = store.getChat(chatKey);
      let target: string | undefined;
      if (/^\d+$/.test(arg)) {
        target = state.sessionList?.[Number(arg) - 1]?.id;
      } else if (/^ses_[A-Za-z0-9]+$/.test(arg)) {
        try {
          const sessions = await listSessions({ bin: config.opencodeBin, cwd: config.workDir });
          target = sessions.some((s) => s.id === arg) ? arg : undefined;
        } catch {
          target = undefined;
        }
      }
      if (!target) {
        await api.sendMessage(chatId, `Unknown session "${arg}". Use /sessions to get a number first.`, replyTo);
        return;
      }
      store.setChat(chatKey, { ...state, sessionId: target });
      await api.sendMessage(chatId, `✅ Switched to session ${target}. Your next message continues it.`, replyTo);
      return;
    }

    if (cmd === "/agent") {
      const state = store.getChat(chatKey);
      if (!arg) {
        await api.sendMessage(chatId, `Current agent: ${state.agent ?? config.agent}`, replyTo);
        return;
      }
      store.setChat(chatKey, { ...state, agent: arg });
      await api.sendMessage(chatId, `✅ Agent set to ${arg} for this chat.`, replyTo);
      return;
    }

    if (cmd === "/exec") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /exec <shell command>", replyTo);
        return;
      }
      if (busyChats.has(chatId)) {
        await api.sendMessage(chatId, "⏳ Still working on the previous request — please wait.", replyTo);
        return;
      }
      busyChats.add(chatId);
      try {
        await api.sendChatAction(chatId, "typing");
        const { out, code } = await runShell(arg, config.workDir, config.timeoutMs);
        const chunks = chunkText(`$ ${arg}\n(exit ${code})\n\n${out}`);
        for (let i = 0; i < chunks.length; i++) {
          await api.sendMessage(chatId, chunks[i], i === 0 ? replyTo : undefined);
        }
      } finally {
        busyChats.delete(chatId);
      }
      return;
    }

    // Default: forward to opencode (the AI brain).
    await forwardToOpencode(chatId, replyTo, text);
  }

  async function handleMedia(chatId: number, replyTo: number, kind: "photo" | "document", fileId: string, fileName: string, fileSize: number | undefined, caption: string): Promise<void> {
    if (fileSize !== undefined && fileSize > MAX_TG_FILE_BYTES) {
      await api.sendMessage(chatId, "❌ File too large for the Telegram Bot API (>20MB). Send a smaller file.", replyTo);
      return;
    }
    await api.sendChatAction(chatId, "upload_document");
    try {
      const file = await api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram returned no file path.");
      const stamped = `${Date.now()}-${fileName}`;
      const saved = await api.downloadFile(file.file_path, inboxDir, stamped);
      console.log(`[media] chat ${chatId}: saved ${kind} → ${saved}`);

      const state = store.getChat(String(chatId));
      const effectiveModel = state.model ?? config.model;
      let visionNote = "";
      if (kind === "photo" && effectiveModel) {
        const info = await lookupModel({ bin: config.opencodeBin, cwd: config.workDir, dataDir: config.dataDir, id: effectiveModel });
        if (info && !info.vision) {
          visionNote = `\n\n⚠️ Note: model ${effectiveModel} has no image input — I attached the file anyway, but switch to a 👁 model via /free for best image results.`;
        }
      }

      const prompt =
        kind === "photo"
          ? `${caption || "What is in this image? Describe it and help with anything actionable in it."}\n(Image saved at ${saved} — open it with your Read tool to see it.)`
          : `${caption || "Review the attached file and help with it."}\n(File saved at ${saved} — read it with your Read tool.)`;
      await forwardToOpencode(chatId, replyTo, prompt, [saved]);
      if (visionNote) await api.sendMessage(chatId, visionNote.trim());
    } catch (err) {
      await api.sendMessage(chatId, `❌ Could not process attachment: ${(err as Error).message.slice(0, 1000)}`, replyTo);
    }
  }

  console.log("[bot] polling for updates…");
  let offset = store.getOffset();

  while (!stopped) {
    let updates;
    try {
      updates = await api.getUpdates(offset, config.pollTimeoutSec);
    } catch (err) {
      console.error(`[poll] ${(err as Error).message}; retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      store.setOffset(offset);

      // Button taps answering agent questions.
      if (update.callback_query) {
        const cb = update.callback_query;
        if (!isAllowed(cb.from?.id)) {
          await api.answerCallback(cb.id, "⛔ Unauthorized.");
          continue;
        }
        const data = cb.data ?? "";
        if (data.startsWith("q:")) {
          const answer = pending.take(data.slice(2));
          if (!answer) {
            await api.answerCallback(cb.id, "Expired — please ask again.");
            continue;
          }
          await api.answerCallback(cb.id, `Answered: ${(answer.option ?? "").slice(0, 40)}`);
          const chatId = cb.message?.chat.id ?? answer.chatId;
          void forwardToOpencode(chatId, cb.message?.message_id, `My answer to "${answer.question}": ${answer.option ?? "(no option)"}. Continue the task with this answer.`);
        } else {
          await api.answerCallback(cb.id);
        }
        continue;
      }

      // Photos/documents (checked before text: captions would match as text).
      const media = extractMedia(update);
      if (media) {
        const chatId = media.message.chat.id;
        if (!isAllowed(media.message.from?.id)) {
          console.warn(`[auth] rejected media from user ${media.message.from?.id} in chat ${chatId}`);
          continue;
        }
        void handleMedia(chatId, media.message.message_id, media.kind, media.fileId, media.fileName, media.fileSize, media.caption).catch((err) =>
          console.error(`[media] ${(err as Error).message}`),
        );
        continue;
      }

      const extracted = extractText(update);
      if (!extracted) continue;
      const { message, text } = extracted;
      const chatId = message.chat.id;

      if (!isAllowed(message.from?.id)) {
        console.warn(`[auth] rejected message from user ${message.from?.id} in chat ${chatId}`);
        try {
          await api.sendMessage(chatId, "⛔ Unauthorized. This bot is restricted.", message.message_id);
        } catch {
          /* ignore */
        }
        continue;
      }

      void handleMessage(chatId, message.message_id, text).catch((err) =>
        console.error(`[msg] ${(err as Error).message}`),
      );
    }
  }
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
