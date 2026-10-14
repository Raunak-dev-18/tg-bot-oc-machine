// Entry point: Telegram long-polling loop + opencode brain + guardrails.
// Text messages go to opencode; photos/documents are downloaded and attached
// via `opencode run -f`; agent questions (:::ASK blocks) render as buttons.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { ensureBotConfigHome } from "./botconfig.js";
import { computeNext, describeSpec, formatNext, parseSpec } from "./cron.js";
import { loadConfig } from "./config.js";
import { PendingQuestions, parseAskBlocks, parseReactLine, parseSendBlocks, parseThinkBlocks, splitUnmarkedThinking, stripAskBlocks, stripSendBlocks } from "./interact.js";
import { loadMemoryContext, memoryPaths, readMemoryFile, rememberFact } from "./memory.js";
import { getVerboseModels, listPlainModels, listSessions, lookupModel, recallSessions, findLatestSession } from "./models.js";
import { loadSkills, skillsCatalog } from "./skills.js";
import { runOpencode, CancelledError, TimeoutError, type RunCancel } from "./opencode.js";
import { ensureServe, isServeHealthy } from "./serve.js";
import { Store } from "./store.js";
import {
  TgApi,
  chunkText,
  extractMedia,
  extractQuote,
  extractText,
  extractVoice,
  quotePrefix,
  type QuotedMessage,
  type ReplyMarkup,
} from "./telegram.js";
import { Sarvam, chunkForSpeech, cleanForSpeech, detectScriptLang, langLabel, mapToTtsLang } from "./voice.js";

const HELP_TEXT = [  "🤖 Remote machine control via opencode",
  "",
  "Send any message — it goes to opencode on this machine, which can",
  "deploy/run apps, clone repos, edit files, run shell, etc.",
  "Send 📷 photos or 📎 files too — the agent can see/read them.",
  "Ask it to browse the web like a human, or to create/edit/delete files,",
  "install things, run and deploy apps. Files it produces (screenshots,",
  "reports) are delivered back here automatically.",
  "When the agent needs a decision, you'll get tappable option buttons.",
  "Tip: reply (swipe) to any older message — mine or yours — and I'll know exactly what you mean.",
  "React to my replies (👍/👎…) — I notice and learn. I react with what I feel.",
  "",
  "Commands:",
  "/start — welcome + status",
  "/help — this help",
  "/stop — cancel the currently running task",
  "/status — bot + opencode health",
  "/new or /reset — forget conversation, start fresh session",
  "/free — list FREE models (👁 = sees images), then reply with the number",
  "/models [provider] — list models, then reply with the number",
  "/model <number|provider/model> — switch model for this chat",
  "/model — show current model",
  "/effort <minimal|low|medium|high|xhigh|max> — reasoning effort for this chat",
  "/effort — show current effort + available levels for your model",
  "/effort off — back to model default",
  "/sessions — last 10 opencode sessions by title, then reply with the number",
  "/switch <number|session-id> — continue a different session",
  "/memory — show what the agent remembers about you",
  "/remember <fact> — save something to long-term memory",
  "/recall <keywords> — search past sessions for context",
  "/skills — list installed agent skills",
  "/parallel <t1> ;; <t2> [;; t3] — run up to 3 tasks concurrently",
  "/bg <task> — run in background, chat stays free (fresh session)",
  "/jobs — list running tasks (survive bot restarts)",
  "/shot <url> [note] — open a page in the agent browser, screenshot to chat",
  "/send <absolute-path> [caption] — send any machine file to chat instantly",
  "🎤 Send a voice note — transcribed, answered by text + voice (needs SARVAM_API_KEY)",
  "/voice [hi|en|auto|off] — voice reply language (default auto-detect)",
  "/voice-ans <text> — answer in text + voice, same language as your text",
  "/say <text> — speak any text as a voice note",
  "/cron <every 30m|every 2h|daily 09:30> <task> — run a task on schedule",
  "/crons — list scheduled tasks",
  "/uncron <number|id> — delete a scheduled task",
  "/agent <name> — switch opencode agent (default: build)",
  "/exec <shell command> — run shell directly, no AI",
].join("\n");

/** Registered "/" menu (Bot API names: lowercase letters, digits, underscores only). */
const COMMAND_MENU: { command: string; description: string }[] = [
  { command: "start", description: "Welcome + status" },
  { command: "help", description: "All commands" },
  { command: "stop", description: "Cancel the running task" },
  { command: "new", description: "Fresh session" },
  { command: "reset", description: "Fresh session" },
  { command: "status", description: "Bot + server health" },
  { command: "free", description: "List free models" },
  { command: "models", description: "List models" },
  { command: "model", description: "Switch or show model" },
  { command: "effort", description: "Reasoning effort level" },
  { command: "sessions", description: "List recent sessions" },
  { command: "switch", description: "Jump to a session" },
  { command: "memory", description: "Show long-term memory" },
  { command: "remember", description: "Save a fact" },
  { command: "recall", description: "Search past sessions" },
  { command: "skills", description: "List agent skills" },
  { command: "parallel", description: "Run tasks concurrently" },
  { command: "bg", description: "Background task" },
  { command: "jobs", description: "List running tasks" },
  { command: "cron", description: "Schedule a task" },
  { command: "crons", description: "List scheduled tasks" },
  { command: "uncron", description: "Delete a scheduled task" },
  { command: "agent", description: "Switch agent" },
  { command: "exec", description: "Run shell directly" },
  { command: "shot", description: "Screenshot a webpage" },
  { command: "send", description: "Send a machine file" },
  { command: "voice", description: "Voice reply settings" },
  { command: "voice_ans", description: "Answer in text + voice" },
  { command: "say", description: "Speak text aloud" },
];

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

  // Drop-in skills (hermes/openclaw style): catalog injected into fresh sessions.
  const skillsDir =
    process.env.SKILLS_DIR ??
    [path.join(process.cwd(), "skills"), path.join(config.dataDir, "..", "skills")].find((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    }) ??
    path.join(process.cwd(), "skills");
  const skills = await loadSkills(skillsDir);
  const skillsText = skillsCatalog(skills, skillsDir);
  console.log(`[bot] skills: ${skills.length ? skills.map((s) => s.name).join(", ") : "none"} (${skillsDir})`);

  // Isolated opencode config (browser MCP etc.) — applies to serve + runs below.
  const botHome = await ensureBotConfigHome({
    configHome: config.opencodeConfigHome,
    workDir: config.workDir,
    dataDir: config.dataDir,
  });
  process.env.XDG_CONFIG_HOME = botHome.dir;
  console.log(`[bot] opencode config home: ${botHome.dir}`);

  if (config.sarvamKey) {
    console.log(`[bot] voice: enabled (Sarvam STT+TTS, model ${config.sarvamTtsModel})`);
  } else {
    console.log("[bot] voice: disabled (set SARVAM_API_KEY to enable voice notes)");
  }
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
  try {
    await api.setMyCommands(COMMAND_MENU);
    console.log(`[bot] registered ${COMMAND_MENU.length} slash commands`);
  } catch (err) {
    console.error(`[bot] command menu registration failed: ${(err as Error).message}`);
  }

  const { serverUrl } = await ensureServe({
    bin: config.opencodeBin,
    cwd: config.workDir,
    port: config.servePort,
    enabled: config.autoServe,
  });
  // Explicit OPENCODE_SERVER_URL wins over the auto-started server.
  let attachUrl = config.serverUrl ?? serverUrl;
  if (attachUrl) console.log(`[bot] opencode runs will --attach ${attachUrl}`);

  // HTTP health endpoint for deployments / uptime pingers (keeps 24/7 hosts honest).
  let healthServer: Server | undefined;
  if (config.healthPort > 0) {
    healthServer = createServer(async (req, res) => {
      if (req.url !== "/" && req.url !== "/healthz") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const healthy = attachUrl ? await isServeHealthy(attachUrl) : true;
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: healthy,
          bot: "tg-control-bot",
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          opencodeServer: attachUrl ?? "direct",
        }),
      );
    });
    healthServer.listen(config.healthPort, "0.0.0.0", () =>
      console.log(`[health] listening on :${config.healthPort}`),
    );
    healthServer.on("error", (err) => {
      // Port clash (e.g. a stale instance) must never kill the bot.
      console.error(`[health] cannot listen on :${config.healthPort}: ${(err as Error).message}`);
      try {
        healthServer?.close();
      } catch {
        /* ignore */
      }
      healthServer = undefined;
    });
  }

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
  const busyChats = new Set<number>();  /** In-flight opencode runs per chat (for /stop cancellation). */
  const running = new Map<number, RunCancel[]>();

  function trackRun(chatId: number): RunCancel {
    const ctrl: RunCancel = { killed: false };
    const list = running.get(chatId) ?? [];
    list.push(ctrl);
    running.set(chatId, list);
    return ctrl;
  }

  function untrackRun(chatId: number, ctrl: RunCancel): void {
    const list = (running.get(chatId) ?? []).filter((c) => c !== ctrl);
    if (list.length > 0) running.set(chatId, list);
    else running.delete(chatId);
  }

  function stopChat(chatId: number): boolean {
    const list = running.get(chatId) ?? [];
    if (list.length === 0) return false;
    running.delete(chatId);
    for (const ctrl of list) {
      ctrl.killed = true;
      try {
        ctrl.proc?.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      setTimeout(() => {
        try {
          ctrl.proc?.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 3000).unref?.();
    }
    return true;
  }
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log("[bot] shutting down…");
    try {
      healthServer?.close();
    } catch {
      /* ignore */
    }
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

  /** Synthesize one speech chunk and send it (opus voice note, mp3 fallback). */
  async function sendVoiceChunk(
    chatId: number,
    sarvam: Sarvam,
    text: string,
    ttsLang: string,
    replyTo?: number,
  ): Promise<void> {
    try {
      const opus = await sarvam.synthesize(text, ttsLang, "opus");
      await api.sendVoiceData(chatId, opus.audio, `reply-${Date.now()}.ogg`, "audio/ogg", undefined, replyTo);
    } catch (err) {
      // Sarvam-side errors (key/quota/text) won't heal by retrying as mp3.
      if ((err as Error).message.startsWith("Sarvam ")) throw err;
      const mp3 = await sarvam.synthesize(text, ttsLang, "mp3");
      await api.sendVoiceData(chatId, mp3.audio, `reply-${Date.now()}.mp3`, "audio/mpeg", undefined, replyTo);
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

  /**
   * Send with Telegram-native formatting when it fits one bubble (HTML with
   * plain-text fallback), plain chunked otherwise (HTML can't span chunks safely).
   */
  async function sendFormatted(chatId: number, text: string, replyTo?: number): Promise<void> {
    if (text.length <= 3900) {
      try {
        await api.sendHtml(chatId, text, replyTo);
        return;
      } catch {
        /* fall through to plain chunked */
      }
    }
    await sendReply(chatId, text, replyTo);
  }

  /** Live "still working" status bubble, edited as the run progresses.
   * Doubles as the streaming surface: once answer text flows, the bubble
   * shows it live (Telegram has no true streaming API — message edits at a
   * safe cadence are the standard approximation). */
  function makeStatus(chatId: number, replyTo: number | undefined) {
    let id: number | undefined;
    let lastBubble = "";
    let lastEditAt = 0;
    let lastStreamEditAt = 0;
    let activity = "warming up…";
    let streamed = "";
    const fmt = (sec: number) =>
      sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
    async function edit(text: string): Promise<boolean> {
      if (id === undefined || text === lastBubble) return false;
      lastBubble = text;
      try {
        await api.editMessage(chatId, id, text);
        return true;
      } catch {
        id = undefined; // message gone — stop trying
        return false;
      }
    }
    return {
      note(text: string) {
        activity = text.slice(0, 120);
      },
      stream(text: string) {
        streamed = text;
      },
      async start() {
        try {
          id = (await api.sendMessage(chatId, "⏳ Working on it…", replyTo)).message_id;
          lastBubble = "⏳ Working on it…";
        } catch {
          id = undefined;
        }
      },
      async tick(startedAt: number) {
        if (id === undefined) return;
        const now = Date.now();
        if (streamed) {
          if (now - lastStreamEditAt < 1500) return;
          lastStreamEditAt = now;
          const head = streamed.slice(0, 3900);
          await edit(head + (streamed.length > 3900 ? "\n… (streaming)" : "") + " ▍");
          return;
        }
        const elapsed = Math.round((now - startedAt) / 1000);
        if (elapsed - lastEditAt < 45) return;
        lastEditAt = elapsed;
        await edit(`⏳ Still working… (${fmt(elapsed)})\n${activity}`);
      },
      async done() {
        if (id !== undefined) {
          const target = id;
          id = undefined;
          await api.deleteMessage(chatId, target);
        }
      },
    };
  }

  /** Shared pipeline: prompt (+optional files) → opencode → reply + ASK buttons.
   * Long tasks are chained: a chunk that hits the time limit auto-continues in
   * the same session (up to maxChunks) instead of erroring. */
  interface ChainedResult {
    text: string;
    sessionId?: string;
    tokens?: { input: number; output: number };
    cost?: number;
    chunks: number;
    partial: boolean;
  }

  async function runChained(opts: {
    prompt: string;
    sessionId?: string;
    isNewSession: boolean;
    model?: string;
    agent: string;
    variant?: string;
    autoApprove: boolean;
    timeoutMs: number;
    maxChunks: number;
    cwd: string;
    bin: string;
    serverUrl?: string;
    files?: string[];
    outboxDir?: string;
    agentVenv?: string;
    memoryDir?: string;
    memory?: string;
    skills?: string;
    cancel?: RunCancel;
    runStartedAt: number;
    excludeSessions: string[];
    onProgress?: (note: string) => void;
    onText?: (cumulative: string) => void;
  }): Promise<ChainedResult> {
    let prompt = opts.prompt;
    let sessionId = opts.sessionId;
    let isNew = opts.isNewSession;
    let combined = "";
    let tokens: { input: number; output: number } | undefined;
    let cost: number | undefined;
    for (let n = 1; n <= opts.maxChunks; n++) {
      try {
        const r = await runOpencode({
          prompt,
          sessionId,
          isNewSession: isNew,
          model: opts.model,
          agent: opts.agent,
          variant: opts.variant,
          autoApprove: opts.autoApprove,
          timeoutMs: opts.timeoutMs,
          cwd: opts.cwd,
          bin: opts.bin,
          serverUrl: opts.serverUrl,
          files: n === 1 ? opts.files : undefined,
          outboxDir: opts.outboxDir,
          agentVenv: opts.agentVenv,
          memoryDir: opts.memoryDir,
          memory: opts.memory,
          skills: opts.skills,
          cancel: opts.cancel,
          onProgress: opts.onProgress,
          onText: (c) => opts.onText?.(combined + c),
        });
        if (r.text.trim()) combined += (combined ? "\n" : "") + r.text.trim();
        tokens = r.tokens ?? tokens;
        cost = r.cost ?? cost;
        if (r.sessionId) sessionId = r.sessionId;
        return { text: combined.trim(), sessionId, tokens, cost, chunks: n, partial: false };
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        if (err.partialText.trim()) combined += (combined ? "\n" : "") + err.partialText.trim();
        if (err.sessionId) sessionId = err.sessionId;
        if (n >= opts.maxChunks) {
          // Out of chunks: deliver everything produced so far instead of erroring.
          if (combined.trim()) {
            return { text: combined.trim(), sessionId, tokens, cost, chunks: n, partial: true };
          }
          throw err;
        }
        if (!sessionId && opts.serverUrl) {
          await new Promise((r) => setTimeout(r, 5000));
          sessionId =
            (await findLatestSession({
              serverUrl: opts.serverUrl,
              cwd: opts.cwd,
              sinceMs: opts.runStartedAt,
              exclude: opts.excludeSessions,
            })) ?? sessionId;
        }
        opts.onProgress?.(`continuing… (part ${n + 1} — previous step hit the time limit)`);
        const tail = combined.trim().slice(-500);
        prompt =
            `Continue EXACTLY where you left off — do not restart, do not summarize, just keep working on the original task. ` +
            `The last part of what you produced so far (already delivered, do not repeat it):\n${tail || "(no output yet)"}`;
        isNew = false;
      }
    }
    throw new Error("unreachable");
  }

  async function forwardToOpencode(
    chatId: number,
    replyTo: number | undefined,
    prompt: string,
    files?: string[],
    reactTo?: number,
    opts?: { background?: boolean; jobId?: string; maxChunks?: number },
  ): Promise<string> {
    const background = opts?.background ?? false;
    if (!background && busyChats.has(chatId)) {
      await api.sendMessage(chatId, "⏳ Still working on the previous request — please wait.", replyTo);
      return "";
    }
    if (!background) busyChats.add(chatId);
    const status = makeStatus(chatId, replyTo);
    await status.start();
    const typingTimer = setInterval(() => void api.sendChatAction(chatId, "typing"), 4000);
    let statusTick: NodeJS.Timeout | undefined;
    const progressTimer = { lastNote: 0 };
    const outboxBefore = new Set<string>(await readdir(config.outboxDir).catch(() => [] as string[]));
    await refreshServe();
    const ctrl = trackRun(chatId);
    const chatKey = String(chatId);
    const state = store.getChat(chatKey);
    // Persisted before the run so a bot restart can resume it (/jobs).
    const jobId =
      opts?.jobId ??
      (() => {
        const id = `r${randomBytes(3).toString("hex")}`;
        store.addRun({
          id,
          chatId,
          replyTo,
          prompt: prompt.slice(0, 4000),
          files,
          sessionId: state.sessionId,
          label: prompt.slice(0, 60),
          background,
          createdAt: new Date().toISOString(),
        });
        return id;
      })();
    try {
      await api.sendChatAction(chatId, "typing");
      const t0 = Date.now();
      statusTick = setInterval(() => void status.tick(t0), 2000);
      const isNewSession = !state.sessionId;
      const memPaths = memoryPaths(config.dataDir);
      const sharedRun = {
        model: state.model ?? config.model,
        agent: state.agent ?? config.agent,
        variant: state.effort,
        autoApprove: config.autoApprove,
        timeoutMs: config.timeoutMs,
        maxChunks: opts?.maxChunks ?? config.maxChunks,
        cwd: config.workDir,
        bin: config.opencodeBin,
        serverUrl: attachUrl,
        outboxDir: config.outboxDir,
        agentVenv: path.join(config.dataDir, ".agent-venv", "bin", "python"),
        // Skills catalog is small — inject every turn so ongoing sessions keep it.
        skills: skillsText,
        memoryDir: memPaths.dir,
        cancel: ctrl,
        runStartedAt: t0,
        excludeSessions: state.sessionId ? [state.sessionId] : [],
        onProgress: (note: string) => {
          status.note(note);
          const now = Date.now();
          if (now - progressTimer.lastNote > 20_000) {
            progressTimer.lastNote = now;
            console.log(`[opencode] chat ${chatId}: ${note}`);
          }
        },
        onText: (cumulative: string) => status.stream(cumulative),
      };
      const runOnce = async (p: string, sid: string | undefined, fresh: boolean, fileList?: string[]) =>
        runChained({
          ...sharedRun,
          prompt: p,
          // Background runs get a FRESH session: sharing the chat's live session
          // across concurrent runs would interleave messages and corrupt it.
          // Memory + skills still inject (new-session path), so context survives.
          sessionId: background ? undefined : sid,
          isNewSession: background ? true : fresh,
          files: fileList,
          memory: fresh ? await loadMemoryContext(config.dataDir) : undefined,
        });
      let result = await runOnce(prompt, state.sessionId, isNewSession, files);
      const isEmpty = (text: string) =>
        stripSendBlocks(stripAskBlocks(parseReactLine(text).cleaned)).trim() === "" &&
        parseAskBlocks(text).length === 0 &&
        parseSendBlocks(text).length === 0;
      if (isEmpty(result.text)) {
        // Transient empty reply (free models flake) — one retry in the same session.
        console.warn(`[opencode] chat ${chatId}: empty reply, retrying once…`);
        status.note("empty reply — retrying…");
        const retrySession = result.sessionId ?? (background ? undefined : state.sessionId);
        result = await runOnce(
          `Your previous reply came back empty. Please answer the original request now:\n\n${prompt}`,
          retrySession,
          !retrySession,
        );
        if (isEmpty(result.text)) {
          throw new Error("The model returned an empty reply twice — try /new for a fresh session, /model to switch, or rephrase.");
        }
      }
      if (result.sessionId) store.setChat(chatKey, { ...state, sessionId: result.sessionId });
      const secs = Math.round((Date.now() - t0) / 1000);
      const chunkNote = result.chunks > 1 ? ` (${result.chunks} parts${result.partial ? ", cut short" : ""})` : "";
      console.log(`[opencode] chat ${chatId}: done in ${secs}s${chunkNote}, session ${result.sessionId ?? "?"}, ${result.text.length} chars`);

      const reacted = parseReactLine(result.text);
      const tagged = parseThinkBlocks(reacted.cleaned);
      const unmarked = splitUnmarkedThinking(tagged.cleaned);
      const thinking = [tagged.thinking, unmarked.thinking].filter(Boolean).join("\n\n").slice(0, 3000);
      const questions = parseAskBlocks(unmarked.cleaned);
      const sends = parseSendBlocks(unmarked.cleaned);
      const body = stripSendBlocks(stripAskBlocks(unmarked.cleaned));
      const footer =
        result.tokens || result.cost !== undefined
          ? `\n\n— done in ${secs}s${chunkNote}${result.tokens ? ` · tokens ${result.tokens.input}in/${result.tokens.output}out` : ""}${result.cost !== undefined ? ` · $${result.cost.toFixed(4)}` : ""}`
          : `\n\n— done in ${secs}s${chunkNote}`;
      if (body) await sendFormatted(chatId, body + (questions.length > 0 ? "" : footer), replyTo);
      if (thinking) {
        await api.sendHtml(
          chatId,
          `💭 <b>Thinking</b>\n<blockquote expandable>${TgApi.escapeHtml(thinking)}</blockquote>`,
          undefined,
        );
      }
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
      if (reactTo !== undefined) await api.react(chatId, reactTo, reacted.emoji ?? "👍");
      return result.text;
    } catch (err) {
      if (err instanceof CancelledError) {
        console.log(`[opencode] chat ${chatId}: stopped by operator`);
        try {
          await sendReply(chatId, "⏹️ Stopped.", replyTo);
        } catch {
          /* chat may be gone; already logged */
        }
      } else {
        console.error(`[opencode] chat ${chatId}: FAILED ${(err as Error).message.slice(0, 300)}`);
        if (reactTo !== undefined) await api.react(chatId, reactTo, "👎");
        try {
          await sendReply(chatId, `❌ ${(err as Error).message.slice(0, 3000)}`, replyTo);
        } catch {
          /* chat may be gone; already logged */
        }
      }
      return "";
    } finally {
      clearInterval(typingTimer);
      if (statusTick) clearInterval(statusTick);
      await status.done();
      if (!background) busyChats.delete(chatId);
      untrackRun(chatId, ctrl);
      store.removeRun(jobId);
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

  async function handleMessage(chatId: number, replyTo: number, text: string, quote?: QuotedMessage): Promise<void> {
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

    if (cmd === "/stop") {
      if (stopChat(chatId)) {
        await api.sendMessage(chatId, "⏹️ Stopping the running task…", replyTo);
      } else {
        await api.sendMessage(chatId, "Nothing running right now.", replyTo);
      }
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
        const top = sessions.slice(0, 10);
        store.setChat(chatKey, {
          ...state,
          sessionList: top,
          pendingSelect: { kind: "session", options: top.map((s) => s.id), expiresAt: Date.now() + 180000 },
        });
        const lines = top.map((s, i) => `${i + 1}. ${s.title}\n   ${s.id}${s.id === state.sessionId ? " ← current" : ""}`);
        await api.sendChunked(chatId, `📚 Last ${top.length} sessions:\n${lines.join("\n")}\n\nJust reply with the number, or /switch <number|id>.`, replyTo);
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
        undefined,
        replyTo,
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

    if (cmd === "/skills") {
      if (skills.length === 0) {
        await api.sendMessage(chatId, "No skills installed.", replyTo);
        return;
      }
      const lines = skills.map((s) => `• ${s.name} — ${s.description}`);
      await api.sendChunked(chatId, `🛠️ Installed skills:\n${lines.join("\n")}\n\nThe agent reads the full guide when a task matches. Drop new ones in skills/<name>/SKILL.md and restart me.`, replyTo);
      return;
    }

    if (cmd === "/recall") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /recall <keywords> — searches recent session transcripts.", replyTo);
        return;
      }
      await api.sendChatAction(chatId, "typing");
      try {
        const { hits, searched, skipped } = await recallSessions({ bin: config.opencodeBin, cwd: config.workDir, query: arg, limit: 8 });
        if (hits.length === 0) {
          await api.sendMessage(chatId, `🔍 No matches for “${arg}” in ${searched} recent session(s)${skipped ? ` (${skipped} skipped)` : ""}.`, replyTo);
          return;
        }
        const lines = hits.map((h) => `📄 ${h.title} [${h.role}]\n${h.snippet}\n   (${h.sessionId})`);
        await api.sendChunked(chatId, `🔍 Recall “${arg}” — ${hits.length} hit(s) in ${searched} session(s):\n\n${lines.join("\n\n")}`, replyTo);
      } catch (err) {
        await api.sendMessage(chatId, `❌ Recall failed: ${(err as Error).message.slice(0, 500)}`, replyTo);
      }
      return;
    }

    if (cmd === "/parallel") {
      const tasks = arg.split(";;").map((t) => t.trim()).filter(Boolean).slice(0, 3);
      if (tasks.length < 2) {
        await api.sendMessage(chatId, "Usage: /parallel <task 1> ;; <task 2> [;; <task 3>]\nRuns up to 3 tasks concurrently in fresh sessions.", replyTo);
        return;
      }
      if (busyChats.has(chatId)) {
        await api.sendMessage(chatId, "⏳ Still working on the previous request — please wait.", replyTo);
        return;
      }
      busyChats.add(chatId);
      const typingTimer = setInterval(() => void api.sendChatAction(chatId, "typing"), 4000);
      const batchStatus = makeStatus(chatId, replyTo);
      let batchTick: NodeJS.Timeout | undefined;
      try {
        await refreshServe();
        await api.react(chatId, replyTo, "👀");
        await api.sendMessage(chatId, `🔀 Running ${tasks.length} tasks in parallel…`, replyTo);
        await batchStatus.start();
        const batchT0 = Date.now();
        batchTick = setInterval(() => void batchStatus.tick(batchT0), 10000);
        const chatState = store.getChat(chatKey);
        const mem = await loadMemoryContext(config.dataDir);
        const memPaths = memoryPaths(config.dataDir);
        const outboxBefore = new Set<string>(await readdir(config.outboxDir).catch(() => [] as string[]));
        const results = await Promise.all(
          tasks.map((task, i) => {
            const ctrl = trackRun(chatId);
            return runOpencode({
              prompt: `[Parallel task ${i + 1}/${tasks.length}: ${task}]\n${task}`,
              sessionId: undefined,
              isNewSession: true,
              model: chatState.model ?? config.model,
              agent: chatState.agent ?? config.agent,
              variant: chatState.effort,
              autoApprove: config.autoApprove,
              timeoutMs: config.timeoutMs,
              cwd: config.workDir,
              bin: config.opencodeBin,
              serverUrl: attachUrl,
              outboxDir: config.outboxDir,
              agentVenv: path.join(config.dataDir, ".agent-venv", "bin", "python"),
              memoryDir: memPaths.dir,
              memory: mem,
              skills: skillsText,
              cancel: ctrl,
            }).then(
              (result) => ({ ok: true as const, i, task, result }),
              (err: unknown) => ({ ok: false as const, i, task, error: (err as Error).message, cancelled: (err as Error).name === "CancelledError" }),
            ).finally(() => untrackRun(chatId, ctrl));
          }),
        );
        const sentPaths = new Set<string>();
        let lastEmoji: string | undefined;
        for (const r of results) {
          if (!r.ok) {
            await api.sendMessage(chatId, `🔀 Task ${r.i + 1}/${tasks.length}: ${r.task}\n${r.cancelled ? "⏹️ Stopped." : `❌ ${r.error.slice(0, 1000)}`}`);
            continue;
          }
          const reacted = parseReactLine(r.result.text);
          if (reacted.emoji) lastEmoji = reacted.emoji;
          const tagged = parseThinkBlocks(reacted.cleaned);
          const unmarked = splitUnmarkedThinking(tagged.cleaned);
          const questions = parseAskBlocks(unmarked.cleaned);
          const sends = parseSendBlocks(unmarked.cleaned);
          let body = stripSendBlocks(stripAskBlocks(unmarked.cleaned));
          if (!body.trim() && questions.length === 0 && sends.length === 0) {
            body = "(empty reply from the model — flaky free tier, run it again or /new)";
          }
          for (const q of questions) {
            body += `\n\n❓ ${q.question}${q.options.length > 0 ? ` (options: ${q.options.join(" / ")})` : " (reply to answer)"}`;
          }
          await sendFormatted(chatId, `🔀 Task ${r.i + 1}/${tasks.length}: ${r.task}\n\n${body}`);
          for (const s of await deliverSendFiles(chatId, sends)) sentPaths.add(s);
        }
        await deliverOutbox(chatId, await collectOutbox(outboxBefore), sentPaths);
        await api.react(chatId, replyTo, lastEmoji ?? "👍");
      } finally {
        clearInterval(typingTimer);
        if (batchTick) clearInterval(batchTick);
        await batchStatus.done();
        busyChats.delete(chatId);
      }
      return;
    }

    if (cmd === "/bg") {
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /bg <task> — runs in background, chat stays free. /jobs to list, /stop to cancel.", replyTo);
        return;
      }
      const mine = store.getRuns().filter((j) => j.chatId === chatId);
      if (mine.length >= 3) {
        await api.sendMessage(chatId, "❌ Max 3 running tasks per chat. Wait or /stop one first (see /jobs).", replyTo);
        return;
      }
      const id = `b${randomBytes(3).toString("hex")}`;
      store.addRun({
        id,
        chatId,
        replyTo,
        prompt: arg.slice(0, 4000),
        files: undefined,
        sessionId: undefined,
        label: arg.slice(0, 60),
        background: true,
        createdAt: new Date().toISOString(),
      });
      await api.sendMessage(chatId, `🛰️ Background task started (${id}). Chat stays free — I'll deliver here when done. /jobs · /stop`, replyTo);
      void forwardToOpencode(chatId, replyTo, arg, undefined, replyTo, { background: true, jobId: id }).catch((err) =>
        console.error(`[bg] ${(err as Error).message}`),
      );
      return;
    }

    if (cmd === "/jobs") {
      const mine = store.getRuns().filter((j) => j.chatId === chatId);
      if (mine.length === 0) {
        await api.sendMessage(chatId, "No running tasks. Start one with /bg <task> or just talk.", replyTo);
        return;
      }
      const age = (iso: string) => {
        const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      };
      const lines = mine.map((j) => `• [${j.id}] “${j.label}” — running ${age(j.createdAt)}${j.background ? " (bg)" : ""}`);
      await api.sendMessage(chatId, `🛰️ Running tasks:\n${lines.join("\n")}\n\nCancel with /stop.`, replyTo);
      return;
    }

    if (cmd === "/voice") {
      const state = store.getChat(chatKey);
      const current = state.voiceLang ?? "auto";
      if (!arg) {
        await api.sendMessage(
          chatId,
          `🎤 Voice replies: ${!config.sarvamKey ? "UNAVAILABLE (no SARVAM_API_KEY)" : current === "off" ? "OFF" : `ON, language ${current}`} ` +
            `(speaker: ${config.sarvamSpeaker ?? "default"} · model ${config.sarvamTtsModel})\n` +
            "Usage: /voice <hi|en|hinglish…|auto|off> — e.g. /voice hi for Hindi always.",
          replyTo,
        );
        return;
      }
      const norm = arg.toLowerCase();
      const next =
        norm === "off" ? "off"
        : norm === "on" || norm === "auto" ? "auto"
        : norm === "hindi" ? "hi-IN"
        : norm === "english" ? "en-IN"
        : norm === "hinglish" ? "hi-IN"
        : /^[a-z]{2}(-[a-z]{2})?$/.test(norm) && norm.includes("-") ? norm.split("-")[0] + "-" + norm.split("-")[1].toUpperCase()
        : /^[a-z]{2,3}$/.test(norm) ? `${norm}-IN`
        : null;
      if (!next) {
        await api.sendMessage(chatId, `Unknown language "${arg}". Try /voice hi, /voice en, /voice auto, /voice off.`, replyTo);
        return;
      }
      store.setChat(chatKey, { ...state, voiceLang: next });
      const mapped = next === "auto" || next === "off" ? next : mapToTtsLang(next);
      await api.sendMessage(
        chatId,
        next === "off"
          ? "🔇 Voice replies off — I'll answer voice notes with text only."
          : `✅ Voice replies ${next === "auto" ? "follow each note's language" : `always in ${langLabel(next)}`} (voice: ${mapped}).`,
        replyTo,
      );
      return;
    }

    if (cmd === "/voice-ans" || cmd === "/voice_ans") {
      if (!config.sarvamKey) {
        await api.sendMessage(chatId, "🎤 Voice needs SARVAM_API_KEY set where the bot runs.", replyTo);
        return;
      }
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /voice-ans <your message> — I reply in text + voice, same language.", replyTo);
        return;
      }
      const detected = detectScriptLang(arg);
      const speakLabel = langLabel(mapToTtsLang(detected));
      const prompt =
        `[Reply in ${speakLabel}] ${arg}\n` +
        `Also keep it speakable: plain sentences, no markdown/lists/URLs/emojis. Under 600 characters if possible.`;
      const spoken = await forwardToOpencode(chatId, replyTo, prompt, undefined, replyTo);
      if (!spoken.trim()) return; // error path already replied with ❌
      const cleaned = parseReactLine(stripSendBlocks(stripAskBlocks(spoken))).cleaned;
      if (!cleaned.trim()) return;
      const sarvam = new Sarvam(config.sarvamKey, config.sarvamTtsModel, config.sarvamSpeaker, config.sarvamPace);
      const ttsLang = mapToTtsLang(detected);
      const chunks = chunkForSpeech(cleaned, 900, 2);
      let target: number | undefined = replyTo;
      for (const chunk of chunks) {
        await sendVoiceChunk(chatId, sarvam, chunk, ttsLang, target);
        target = undefined;
      }
      return;
    }

    if (cmd === "/say") {
      if (!config.sarvamKey) {
        await api.sendMessage(chatId, "🎤 Voice needs SARVAM_API_KEY set where the bot runs.", replyTo);
        return;
      }
      if (!arg) {
        await api.sendMessage(chatId, "Usage: /say <text to speak>", replyTo);
        return;
      }
      const state = store.getChat(chatKey);
      const langPref = state.voiceLang && state.voiceLang !== "auto" && state.voiceLang !== "off" ? state.voiceLang : "en-IN";
      const ttsLang = mapToTtsLang(langPref);
      await api.sendChatAction(chatId, "record_voice");
      try {
        const sarvam = new Sarvam(config.sarvamKey, config.sarvamTtsModel, config.sarvamSpeaker, config.sarvamPace);
        const chunks = chunkForSpeech(arg, 900, 2);
        let target: number | undefined = replyTo;
        for (const chunk of chunks) {
          await sendVoiceChunk(chatId, sarvam, chunk, ttsLang, target);
          target = undefined;
        }
      } catch (err) {
        await api.sendMessage(chatId, `❌ Speech failed: ${(err as Error).message.slice(0, 500)}`, replyTo);
      }
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

    // Default: forward to opencode (the AI brain), with quoted context if replying.
    await forwardToOpencode(chatId, replyTo, quote ? `${quotePrefix(quote)}\n${text}` : text, undefined, replyTo);
  }

  async function handleVoice(chatId: number, replyTo: number, fileId: string, duration: number, fileSize?: number, quote?: QuotedMessage): Promise<void> {
    if (!config.sarvamKey) {
      await api.sendMessage(chatId, "🎤 Voice notes need SARVAM_API_KEY set where the bot runs. Send text meanwhile.", replyTo);
      return;
    }
    if (fileSize !== undefined && fileSize > MAX_TG_FILE_BYTES) {
      await api.sendMessage(chatId, "❌ Voice note too large (>20MB). Send a shorter one.", replyTo);
      return;
    }
    if (busyChats.has(chatId)) {
      await api.sendMessage(chatId, "⏳ Still working on the previous request — please wait.", replyTo);
      return;
    }
    const sarvam = new Sarvam(config.sarvamKey, config.sarvamTtsModel, config.sarvamSpeaker, config.sarvamPace);
    await api.sendChatAction(chatId, "record_voice");
    try {
      const file = await api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram returned no file path.");
      const saved = await api.downloadFile(file.file_path, inboxDir, `${Date.now()}-voice.oga`);
      const tr = await sarvam.transcribe(saved);
      console.log(`[voice] chat ${chatId}: (${tr.languageCode ?? "?"}) ${tr.text.slice(0, 120)}`);

      const state = store.getChat(String(chatId));
      const override =
        state.voiceLang && state.voiceLang !== "auto" && state.voiceLang !== "off" ? state.voiceLang : undefined;
      const hearLabel = langLabel(tr.languageCode);
      const speakLabel = override ? langLabel(mapToTtsLang(override)) : hearLabel;
      const prompt =
        (quote ? quotePrefix(quote) + "\n" : "") +
        `[Voice note transcribed from ${hearLabel}]: "${tr.text}"\n` +
        `Reply for SPOKEN delivery: under 600 characters, in ${speakLabel}, plain sentences a text-to-speech engine can read — ` +
        `no markdown, lists, URLs, emojis, or code. If the request needs tools or long work, do it, but keep the spoken part a short summary.`;
      const spoken = await forwardToOpencode(chatId, replyTo, prompt, [saved], replyTo);
      if ((store.getChat(String(chatId)).voiceLang ?? "auto") === "off") return; // text reply already delivered
      if (!spoken.trim()) return; // error path already replied with ❌ — never voice placeholders
      const cleaned = parseReactLine(stripSendBlocks(stripAskBlocks(spoken))).cleaned;
      if (!cleaned.trim()) return;
      const chunks = chunkForSpeech(cleaned, 900, 2);
      if (chunks.length === 0) return;
      const ttsLang = mapToTtsLang(override ?? tr.languageCode);
      let target: number | undefined = replyTo;
      for (const chunk of chunks) {
        await sendVoiceChunk(chatId, sarvam, chunk, ttsLang, target);
        target = undefined;
      }
    } catch (err) {
      await api.sendMessage(chatId, `❌ Voice failed: ${(err as Error).message.slice(0, 800)}`, replyTo);
    }
  }

  async function handleMedia(chatId: number, replyTo: number, kind: "photo" | "document", fileId: string, fileName: string, fileSize: number | undefined, caption: string, quote?: QuotedMessage): Promise<void> {
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
          ? `${quote ? quotePrefix(quote) + "\n" : ""}${caption || "What is in this image? Describe it and help with anything actionable in it."}\n(Image saved at ${saved} — open it with your Read tool to see it.)`
          : `${quote ? quotePrefix(quote) + "\n" : ""}${caption || "Review the attached file and help with it."}\n(File saved at ${saved} — read it with your Read tool.)`;
      await forwardToOpencode(chatId, replyTo, prompt, [saved], replyTo);
      if (visionNote) await api.sendMessage(chatId, visionNote.trim());
    } catch (err) {
      await api.sendMessage(chatId, `❌ Could not process attachment: ${(err as Error).message.slice(0, 1000)}`, replyTo);
    }
  }

  console.log("[bot] polling for updates…");
  let offset = store.getOffset();

  // Resume runs interrupted by a bot restart (persisted in /jobs).
  // Sequential per chat (sessions can't take concurrent writers), parallel across chats.
  const interrupted = store.getRuns();
  if (interrupted.length > 0) {
    console.log(`[bot] resuming ${interrupted.length} interrupted run(s)…`);
    const byChat = new Map<number, typeof interrupted>();
    for (const job of interrupted) {
      const list = byChat.get(job.chatId) ?? [];
      list.push(job);
      byChat.set(job.chatId, list);
    }
    void Promise.all(
      [...byChat].map(([cid, jobs]) =>
        (async () => {
          for (const job of jobs) {
            try {
              await api.sendMessage(cid, `🔄 Resuming interrupted task (${job.id}): “${job.label}”…`);
            } catch {
              /* chat may be gone */
            }
            await forwardToOpencode(cid, job.replyTo, job.prompt, job.files, undefined, {
              background: true,
              jobId: job.id,
            });
          }
        })().catch((err) => console.error(`[resume] ${(err as Error).message}`)),
      ),
    );
  }

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
          void forwardToOpencode(chatId, cb.message?.message_id, `My answer to "${answer.question}": ${answer.option ?? "(no option)"}. Continue the task with this answer.`, undefined, cb.message?.message_id);
        } else {
          await api.answerCallback(cb.id);
        }
        continue;
      }

      // Reactions to bot messages — the agent learns what you thought.
      if (update.message_reaction) {
        const mr = update.message_reaction;
        if (!isAllowed(mr.user?.id, mr.user?.username)) continue;
        const emojis = mr.new_reaction
          .filter((r) => r.type === "emoji" && r.emoji)
          .map((r) => r.emoji as string);
        if (emojis.length === 0) continue; // reaction removed — ignore
        const chatId = mr.chat.id;
        const snippet = api.sentSnippet(chatId, mr.message_id) ?? "(message not in recent cache)";
        const POSITIVE = ["👍", "❤️", "🔥", "🎉", "👏", "🥰", "💯", "❤"];
        const NEGATIVE = ["👎", "💩", "😡", "🤬", "👿", "😠"];
        const tone = emojis.some((e) => NEGATIVE.includes(e))
          ? "negative — they disliked it. Apologize briefly, ask ONE question about what to fix, and note it in memory."
          : emojis.some((e) => POSITIVE.includes(e))
            ? "positive — they liked it. Thank them in one short line and note any preference signal in memory."
            : "neutral/ambiguous — acknowledge in one short line, no fuss.";
        console.log(`[reaction] chat ${chatId} user ${mr.user?.id} ${emojis.join("")} on msg ${mr.message_id}`);
        void forwardToOpencode(
          chatId,
          undefined,
          `[Operator reaction] You received ${emojis.join(" ")} on your message: "${snippet}". Tone: ${tone} Keep it under 300 chars, no ASK blocks needed unless you're asking what to fix.`,
        ).catch((err) => console.error(`[reaction] ${(err as Error).message}`));
        continue;
      }

      // Voice notes (Sarvam STT → agent → Sarvam TTS voice reply).
      const voice = extractVoice(update);
      if (voice) {
        const chatId = voice.message.chat.id;
        if (!isAllowed(voice.message.from?.id, voice.message.from?.username)) {
          console.warn(`[auth] rejected voice from user ${voice.message.from?.id} in chat ${chatId}`);
          continue;
        }
        void api.react(chatId, voice.message.message_id, "👀");
        const voiceQuote = extractQuote(voice.message, me.id);
        void handleVoice(chatId, voice.message.message_id, voice.fileId, voice.duration, voice.fileSize, voiceQuote).catch((err) =>
          console.error(`[voice] ${(err as Error).message}`),
        );
        console.log(`[msg] chat ${chatId} voice note (${voice.duration}s)`);
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
        void api.react(chatId, media.message.message_id, "👀");
        const mediaQuote = extractQuote(media.message, me.id);
        void handleMedia(chatId, media.message.message_id, media.kind, media.fileId, media.fileName, media.fileSize, media.caption, mediaQuote).catch((err) =>
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

      void api.react(chatId, message.message_id, "👀");
      const quote = extractQuote(message, me.id);
      void handleMessage(chatId, message.message_id, text, quote).catch((err) =>
        console.error(`[msg] ${(err as Error).message}`),
      );
      console.log(
        `[msg] chat ${chatId} from user ${message.from?.id}${message.from?.username ? ` (@${message.from.username})` : ""}${quote ? ` (reply→msg ${quote.messageId})` : ""}: ${text.slice(0, 80)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).message}`);
  process.exit(1);
});
