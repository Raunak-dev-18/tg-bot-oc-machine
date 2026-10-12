// Entry point: Telegram long-polling loop + opencode brain + guardrails.
// Text messages go to opencode; photos/documents are downloaded and attached
// via `opencode run -f`; agent questions (:::ASK blocks) render as buttons.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ensureBotConfigHome } from "./botconfig.js";
import { computeNext, describeSpec, formatNext, parseSpec } from "./cron.js";
import { loadConfig } from "./config.js";
import { PendingQuestions, parseAskBlocks, parseSendBlocks, stripAskBlocks, stripSendBlocks } from "./interact.js";
import { loadMemoryContext, memoryPaths, readMemoryFile, rememberFact } from "./memory.js";
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
  "Ask it to browse the web like a human, or to create/edit/delete files,",
  "install things, run and deploy apps. Files it produces (screenshots,",
  "reports) are delivered back here automatically.",
  "When the agent needs a decision, you'll get tappable option buttons.",
  "",
  "Commands:",
  "/start — welcome + status",
  "/help — this help",
  "/status — bot + opencode health",
  "/new or /reset — forget conversation, start fresh session",
  "/free — list FREE models (👁 = sees images), then reply with the number",
  "/models [provider] — list models, then reply with the number",
  "/model <number|provider/model> — switch model for this chat",
  "/model — show current model",
  "/effort <minimal|low|medium|high|xhigh|max> — reasoning effort for this chat",
  "/effort — show current effort + available levels for your model",
  "/effort off — back to model default",
  "/sessions — list recent opencode sessions, then reply with the number",
  "/switch <number|session-id> — continue a different session",
  "/memory — show what the agent remembers about you",
  "/remember <fact> — save something to long-term memory",
  "/shot <url> [note] — open a page in the agent browser, screenshot to chat",
  "/send <absolute-path> [caption] — send any machine file to chat instantly",
  "/cron <every 30m|every 2h|daily 09:30> <task> — run a task on schedule",
  "/crons — list scheduled tasks",
  "/uncron <number|id> — delete a scheduled task",
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
  await mkdir(inboxDir, { recursive: true });
  await mkdir(config.outboxDir, { recursive: true });
  await mkdir(memoryPaths(config.dataDir).dir, { recursive: true });
  const pending = new PendingQuestions();

  // Isolated opencode config (browser MCP etc.) — applies to serve + runs below.
  const botHome = await ensureBotConfigHome({
    configHome: config.opencodeConfigHome,
    workDir: config.workDir,
    dataDir: config.dataDir,
  });
  process.env.XDG_CONFIG_HOME = botHome.dir;
  console.log(`[bot] opencode config home: ${botHome.dir}`);

  if (config.allowedUsers.size === 0 && config.allowedUsernames.size === 0) {
    console.warn(
      "⚠️  SECURITY: TELEGRAM_ALLOWED_USERS is empty — ANY Telegram user who finds this bot can execute commands on this machine. " +
        "Set TELEGRAM_ALLOWED_USERS=<your-numeric-id or @username> to lock it down. Get your id via @userinfobot.",
    );
  } else {
    console.log(
      `[auth] whitelist: ids=[${[...config.allowedUsers].join(",")}] usernames=[${[...config.allowedUsernames].join(",")}]`,
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
  let attachUrl = config.serverUrl ?? serverUrl;
  if (attachUrl) console.log(`[bot] opencode runs will --attach ${attachUrl}`);

  /** Self-heal: restart the background server if it died; fall back to direct runs. */
  async function refreshServe(): Promise<void> {
    if (!config.autoServe || config.serverUrl || !attachUrl) return;
    if (await isServeHealthy(attachUrl)) return;
    console.warn("[serve] background server lost, restarting…");
    try {
      const fresh = await ensureServe({
        bin: config.opencodeBin,
        cwd: config.workDir,
        port: config.servePort,
        enabled: true,
      });
      attachUrl = fresh.serverUrl;
      console.log(`[serve] now using ${attachUrl ?? "direct per-message runs (fallback)"}`);
    } catch (err) {
      console.error(`[serve] restart failed: ${(err as Error).message}; using direct runs`);
      attachUrl = undefined;
    }
  }

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

  function isAllowed(fromId: number | undefined, username?: string): boolean {
    if (config.allowedUsers.size === 0 && config.allowedUsernames.size === 0) return true;
    if (fromId !== undefined && config.allowedUsers.has(fromId)) return true;
    const name = (username ?? "").replace(/^@/, "").toLowerCase();
    return !!name && config.allowedUsernames.has(name);
  }

  /** Files the agent dropped into the outbox during this run. */
  async function collectOutbox(before: Set<string>): Promise<string[]> {
    try {
      const entries = await readdir(config.outboxDir);
      return entries.filter((e) => !before.has(e)).sort();
    } catch {
      return [];
    }
  }

  async function deliverOutbox(chatId: number, fresh: string[], skip?: Set<string>): Promise<void> {
    const MAX_FILES = 5;
    const MAX_BYTES = 20 * 1024 * 1024;
    let sent = 0;
    for (const name of fresh) {
      const full = path.resolve(config.outboxDir, name);
      if (skip?.has(full)) continue;
      if (sent >= MAX_FILES) {
        await api.sendMessage(chatId, `…and more file(s) left in the outbox.`);
        break;
      }
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        if (info.size > MAX_BYTES) {
          await api.sendMessage(chatId, `📎 ${name} (${Math.round(info.size / 1048576)}MB) is too large to send via Telegram.`);
          continue;
        }
        const isImage = /\.(jpe?g|png|gif|webp)$/i.test(name);
        if (isImage) await api.sendPhoto(chatId, full, `📷 ${name}`);
        else await api.sendDocument(chatId, full, `📎 ${name}`);
        sent++;
      } catch (err) {
        console.error(`[outbox] failed to send ${name}: ${(err as Error).message}`);
      }
    }
  }

  /** Explicit :::SEND blocks from the agent → photo/document messages. Returns resolved paths sent. */
  async function deliverSendFiles(chatId: number, sends: { filePath: string; caption: string }[]): Promise<Set<string>> {
    const delivered = new Set<string>();
    const MAX_BYTES = 20 * 1024 * 1024;
    for (const send of sends) {
      const full = path.resolve(send.filePath);
      try {
        const info = await stat(full);
        if (!info.isFile() || info.size > MAX_BYTES) continue;
        const name = path.basename(full);
        const caption = send.caption || `📎 ${name}`;
        if (/\.(jpe?g|png|gif|webp)$/i.test(name)) await api.sendPhoto(chatId, full, caption);
        else await api.sendDocument(chatId, full, caption);
        delivered.add(full);
      } catch (err) {
        console.error(`[send] failed for ${send.filePath}: ${(err as Error).message}`);
      }
    }
    return delivered;
  }

  /** Send a reply, falling back to a plain message if the reply target is gone. */
  async function sendReply(chatId: number, text: string, replyTo: number | undefined): Promise<void> {
    try {
      await api.sendChunked(chatId, text, replyTo);
    } catch (err) {
      if (replyTo !== undefined && /repl/i.test((err as Error).message)) {
        await api.sendChunked(chatId, text);
      } else {
        throw err;
      }
    }
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
    const outboxBefore = new Set<string>(await readdir(config.outboxDir).catch(() => [] as string[]));
    await refreshServe();
    try {
      await api.sendChatAction(chatId, "typing");
      const t0 = Date.now();
      const chatKey = String(chatId);
      const state = store.getChat(chatKey);
      const isNewSession = !state.sessionId;
      const memPaths = memoryPaths(config.dataDir);
      const result = await runOpencode({
        prompt,
        sessionId: state.sessionId,
        isNewSession,
        model: state.model ?? config.model,
        agent: state.agent ?? config.agent,
        variant: state.effort,
        autoApprove: config.autoApprove,
        timeoutMs: config.timeoutMs,
        cwd: config.workDir,
        bin: config.opencodeBin,
        serverUrl: attachUrl,
        files,
        outboxDir: config.outboxDir,
        agentVenv: path.join(config.dataDir, ".agent-venv", "bin", "python"),
        memoryDir: memPaths.dir,
        memory: isNewSession ? await loadMemoryContext(config.dataDir) : undefined,
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
      const sends = parseSendBlocks(result.text);
      const body = stripSendBlocks(stripAskBlocks(result.text));
      const footer =
        result.tokens || result.cost !== undefined
          ? `\n\n— done in ${secs}s${result.tokens ? ` · tokens ${result.tokens.input}in/${result.tokens.output}out` : ""}${result.cost !== undefined ? ` · $${result.cost.toFixed(4)}` : ""}`
          : `\n\n— done in ${secs}s`;
      if (body) await sendReply(chatId, body + (questions.length > 0 ? "" : footer), replyTo);
      const sentPaths = await deliverSendFiles(chatId, sends);
      await deliverOutbox(chatId, await collectOutbox(outboxBefore), sentPaths);

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
      try {
        await sendReply(chatId, `❌ ${(err as Error).message.slice(0, 3000)}`, replyTo);
      } catch {
        /* chat may be gone; already logged */
      }
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
      const memSize = (await readMemoryFile(config.dataDir)).length;
      const cronCount = store.getCrons().filter((j) => j.chatId === chatId).length;
      await api.sendMessage(
        chatId,
        [
          "📊 Status",
          `bot uptime: ${uptimeMin}m`,
          `workDir: ${config.workDir}`,
          `opencode server: ${attachUrl ? `${attachUrl} (${healthy ? "healthy" : "UNREACHABLE"})` : "per-message runs"}`,
          `browser MCP: ${botHome.playwrightMcpCli ? "ready ✅" : "unavailable ⚠️"}`,
          `session: ${state.sessionId ?? "none yet"}`,
          `model override: ${state.model ?? config.model ?? "(opencode default)"}`,
          `effort: ${state.effort ?? "(model default)"}`,
          `agent: ${state.agent ?? config.agent}`,
          `auto-approve: ${config.autoApprove ? "ON" : "OFF"}`,
          `memory: ${memSize} chars`,
          `scheduled tasks: ${cronCount}`,
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
        store.setChat(chatKey, {
          ...state,
          modelList: free.map((m) => m.id),
          pendingSelect: { kind: "model", options: free.map((m) => m.id), expiresAt: Date.now() + 180000 },
        });
        const lines = free.map(
          (m, i) => `${i + 1}. ${m.id}${m.vision ? " 👁" : ""}${m.contextK ? ` · ${m.contextK}k ctx` : ""}`,
        );
        await api.sendChunked(
          chatId,
          `🆓 Free models (opencode provider):\n${lines.join("\n")}\n\n👁 = can see images. Just reply with the number (e.g. 2), or /model <number|id>.`,
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
        store.setChat(chatKey, {
          ...state,
          modelList: ids,
          pendingSelect: { kind: "model", options: ids, expiresAt: Date.now() + 180000 },
        });
        const lines = ids.map((id, i) => `${i + 1}. ${id}`);
        await api.sendChunked(
          chatId,
          `🧠 Models${arg ? ` (${arg})` : ""} — ${ids.length} total:\n${lines.join("\n")}\n\nJust reply with the number, or /model <number|id>. Use /free for free ones.`,
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

    if (cmd === "/effort") {
      const state = store.getChat(chatKey);
      const effectiveModel = state.model ?? config.model;
      const info = effectiveModel
        ? await lookupModel({ bin: config.opencodeBin, cwd: config.workDir, dataDir: config.dataDir, id: effectiveModel })
        : undefined;
      const available = info?.variants ?? [];
      if (!arg) {
        await api.sendMessage(
          chatId,
          `Current effort: ${state.effort ?? "(model default)"}` +
            (effectiveModel ? `\nModel: ${effectiveModel}` : "") +
            (available.length > 0
              ? `\nAvailable levels: ${available.join(", ")}\nSet with /effort <level> (applies from your next message).`
              : `\nNo effort levels known for this model — try /effort high anyway, or pick a model from /free.`),
          replyTo,
        );
        return;
      }
      const level = arg.toLowerCase();
      if (["off", "default", "none", "auto"].includes(level)) {
        store.setChat(chatKey, { ...state, effort: undefined });
        await api.sendMessage(chatId, "✅ Effort cleared — back to model default.", replyTo);
        return;
      }
      if (available.length > 0 && !available.map((v) => v.toLowerCase()).includes(level)) {
        await api.sendMessage(chatId, `Unknown level "${arg}" for ${effectiveModel}. Available: ${available.join(", ")}`, replyTo);
        return;
      }
      const canonical = available.find((v) => v.toLowerCase() === level) ?? arg;
      store.setChat(chatKey, { ...state, effort: canonical });
      await api.sendMessage(chatId, `✅ Effort set to ${canonical} for this chat (applies from your next message).`, replyTo);
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
        store.setChat(chatKey, {
          ...state,
          sessionList: sessions.slice(0, 30),
          pendingSelect: { kind: "session", options: sessions.slice(0, 30).map((s) => s.id), expiresAt: Date.now() + 180000 },
        });
        const lines = sessions.slice(0, 30).map((s, i) => `${i + 1}. ${s.title}\n   ${s.id}${s.id === state.sessionId ? " ← current" : ""}`);
        await api.sendChunked(chatId, `📚 Recent sessions:\n${lines.join("\n")}\n\nJust reply with the number, or /switch <number|id>.`, replyTo);
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

    if (cmd === "/memory") {
      const mem = await readMemoryFile(config.dataDir);
      await api.sendChunked(chatId, mem ? `🧠 Long-term memory:\n\n${mem}` : "🧠 Memory is empty. Tell me things with /remember <fact>, or just say “remember …” and I'll file it.", replyTo);
      return;
    }

    if (cmd === "/remember") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /remember <fact to store in long-term memory>", replyTo);
        return;
      }
      await rememberFact(config.dataDir, arg);
      await api.sendMessage(chatId, "✅ Remembered.", replyTo);
      return;
    }

    if (cmd === "/send") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /send <absolute-path-on-machine> [caption]", replyTo);
        return;
      }
      const parts = arg.split(/\s+/);
      const filePath = parts[0];
      const caption = parts.slice(1).join(" ").trim();
      if (!path.isAbsolute(filePath)) {
        await api.sendMessage(chatId, "❌ Give an absolute path, e.g. /send /home/runner/workspace/data/outbox/shot.png", replyTo);
        return;
      }
      try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("not a file");
        if (info.size > 20 * 1024 * 1024) throw new Error("larger than 20MB");
        const name = path.basename(filePath);
        if (/\.(jpe?g|png|gif|webp)$/i.test(name)) await api.sendPhoto(chatId, filePath, caption || `📷 ${name}`);
        else await api.sendDocument(chatId, filePath, caption || `📎 ${name}`);
      } catch (err) {
        await api.sendMessage(chatId, `❌ Cannot send: ${(err as Error).message.slice(0, 300)}`, replyTo);
      }
      return;
    }

    if (cmd === "/shot") {      const [url, ...noteParts] = arg.split(/\s+/);
      if (!url || !/^https?:\/\//i.test(url)) {
        await api.sendMessage(chatId, "Usage: /shot <https-url> [what to check]", replyTo);
        return;
      }
      const note = noteParts.join(" ").trim();
      await forwardToOpencode(
        chatId,
        replyTo,
        `Use your playwright browser tools: navigate to ${url}, ${note || "review the page"}. ` +
          `Take a viewport screenshot and save it to ${config.outboxDir} (create the dir if needed). ` +
          `Reply with a short summary of what you see.`,
      );
      return;
    }

    if (cmd === "/cron") {
      const m = /^(every\s+\S+|daily\s+\S+)\s+([\s\S]+)$/.exec(arg);
      const specStr = m ? m[1].toLowerCase() : "";
      const task = m ? m[2].trim() : "";
      const spec = parseSpec(specStr);
      if (!spec || !task) {
        await api.sendMessage(
          chatId,
          "Usage: /cron <every 30m|every 2h|daily 09:30> <task>\nExample: /cron every 1h check my site is up and report status",
          replyTo,
        );
        return;
      }
      const mine = store.getCrons().filter((j) => j.chatId === chatId);
      if (mine.length >= 10) {
        await api.sendMessage(chatId, "❌ Max 10 scheduled tasks per chat. Remove one with /uncron first.", replyTo);
        return;
      }
      const job = {
        id: `c${randomBytes(3).toString("hex")}`,
        chatId,
        spec: specStr,
        task: task.slice(0, 1000),
        nextRun: computeNext(spec, Date.now()),
        createdAt: new Date().toISOString(),
        failures: 0,
      };
      store.addCron(job);
      await api.sendMessage(
        chatId,
        `⏰ Scheduled (${describeSpec(spec)}, id ${job.id}):\n“${job.task}”\nNext run: ${formatNext(job.nextRun)}`,
        replyTo,
      );
      return;
    }

    if (cmd === "/crons") {
      const mine = store.getCrons().filter((j) => j.chatId === chatId);
      if (mine.length === 0) {
        await api.sendMessage(chatId, "No scheduled tasks. Add one: /cron <every 30m|daily 09:30> <task>", replyTo);
        return;
      }
      const lines = mine.map(
        (j, i) => `${i + 1}. [${j.id}] ${describeSpec(parseSpec(j.spec) ?? { kind: "interval", everyMs: 3600000 })}\n   “${j.task.slice(0, 120)}”\n   next: ${formatNext(j.nextRun)}`,
      );
      await api.sendChunked(chatId, `⏰ Scheduled tasks:\n${lines.join("\n")}\n\nDelete with /uncron <number|id>.`, replyTo);
      return;
    }

    if (cmd === "/uncron") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /uncron <number|id> (see /crons).", replyTo);
        return;
      }
      const mine = store.getCrons().filter((j) => j.chatId === chatId);
      let target = mine.find((j) => j.id === arg)?.id;
      if (!target && /^\d+$/.test(arg)) target = mine[Number(arg) - 1]?.id;
      if (!target || !store.removeCron(target)) {
        await api.sendMessage(chatId, `Unknown task "${arg}". See /crons.`, replyTo);
        return;
      }
      await api.sendMessage(chatId, `🗑️ Deleted scheduled task ${target}.`, replyTo);
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

    // Bare-number reply right after /models /free /sessions → pick that option.
    if (/^\d+$/.test(text)) {
      const numState = store.getChat(chatKey);
      const sel = numState.pendingSelect;
      if (sel && Date.now() < sel.expiresAt) {
        const picked = sel.options[Number(text) - 1];
        if (!picked) {
          await api.sendMessage(chatId, `Pick 1–${sel.options.length}, or send a message to talk to the agent.`, replyTo);
          return;
        }
        if (sel.kind === "model") {
          store.setChat(chatKey, { ...numState, model: picked, pendingSelect: undefined });
          await api.sendMessage(chatId, `✅ Model set to ${picked} for this chat (applies from your next message).`, replyTo);
        } else {
          store.setChat(chatKey, { ...numState, sessionId: picked, pendingSelect: undefined });
          await api.sendMessage(chatId, `✅ Switched to session ${picked}. Your next message continues it.`, replyTo);
        }
        return;
      }
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

  // Scheduled tasks (hermes/openclaw-style cron): tick every 20s, run due jobs.
  const cronTimer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    for (const job of store.getCrons()) {
      if (job.nextRun > now) continue;
      const spec = parseSpec(job.spec);
      if (!spec) {
        console.error(`[cron] dropping job ${job.id} with bad spec`);
        store.removeCron(job.id);
        void api.sendMessage(job.chatId, `⚠️ Deleted scheduled task ${job.id}: unreadable schedule.`);
        continue;
      }
      store.updateCron(job.id, {
        nextRun: computeNext(spec, now),
        lastRun: new Date().toISOString(),
        failures: 0,
      });
      if (busyChats.has(job.chatId)) {
        console.log(`[cron] chat ${job.chatId} busy, job ${job.id} deferred to next tick`);
        continue;
      }
      console.log(`[cron] running job ${job.id} in chat ${job.chatId}`);
      void forwardToOpencode(job.chatId, undefined, `⏰ Scheduled task (${describeSpec(spec)}):\n${job.task}`).catch(
        (err) => {
          console.error(`[cron] job ${job.id} failed: ${(err as Error).message}`);
          const current = store.getCrons().find((j) => j.id === job.id);
          const failures = (current?.failures ?? 0) + 1;
          if (failures >= 5) {
            store.removeCron(job.id);
            void api.sendMessage(job.chatId, `⚠️ Deleted scheduled task ${job.id} after 5 failures.`);
          } else {
            store.updateCron(job.id, { failures });
          }
        },
      );
    }
  }, 20000);
  cronTimer.unref?.();

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
        if (!isAllowed(cb.from?.id, cb.from?.username)) {
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
        if (!isAllowed(media.message.from?.id, media.message.from?.username)) {
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

      if (!isAllowed(message.from?.id, message.from?.username)) {
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
      console.log(
        `[msg] chat ${chatId} from user ${message.from?.id}${message.from?.username ? ` (@${message.from.username})` : ""}: ${text.slice(0, 80)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
