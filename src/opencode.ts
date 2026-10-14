// Bridge between Telegram messages and opencode (`opencode run --format json`).
// Each Telegram chat maps to a persistent opencode session id so the agent
// keeps memory across messages. New chats start with an ops system prompt.
import { spawn, type ChildProcess } from "node:child_process";

export interface RunOpts {
  prompt: string;
  sessionId?: string;
  isNewSession: boolean;
  model?: string;
  agent: string;
  /** Reasoning-effort variant (opencode --variant, e.g. "high"). */
  variant?: string;
  autoApprove: boolean;
  timeoutMs: number;
  cwd: string;
  bin: string;
  serverUrl?: string;
  /** Local file paths to attach to the message (`opencode run -f`). */
  files?: string[];
  /** Directory where the agent saves files for the operator (screenshots, reports). */
  outboxDir?: string;
  /** Persistent memory context (MEMORY.md + daily notes), injected into fresh sessions. */
  memory?: string;
  /** Directory holding MEMORY.md + daily notes (told to the agent). */
  memoryDir?: string;
  /** Python venv with doc libs (told to the agent). */
  agentVenv?: string;
  /** Skill catalog text (told to the agent in fresh sessions). */
  skills?: string;
  /** Cancellation token — abort the spawned process via /stop. */
  cancel?: RunCancel;
  /** Fired with cumulative answer text on every text event (for live streaming). */
  onText?: (cumulative: string) => void;
  onProgress?: (note: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  tokens?: { input: number; output: number };
  cost?: number;
  durationMs: number;
}

/** Cancellation token: set `killed = true` + SIGTERM `proc` to abort a run. */
export interface RunCancel {
  killed: boolean;
  proc?: ChildProcess;
}

export class CancelledError extends Error {
  readonly cancelled = true;
  constructor() {
    super("cancelled by operator");
    this.name = "CancelledError";
  }
}

/** Rejects when the run exceeds timeoutMs. Carries partial text + session for chaining. */
export class TimeoutError extends Error {
  readonly timedOut = true;
  constructor(
    public partialText: string,
    public sessionId: string | undefined,
    timeoutMs: number,
  ) {
    super(`opencode timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "TimeoutError";
  }
}

const OPS_SYSTEM_PREFIX = [
  "You are the autonomous operator of this Linux machine, driven via a Telegram bot.",
  "The operator chats via Telegram; your reply is sent back as the chat reply.",
  "You are expected to DO the task end-to-end like a human at the computer, not just describe it.",
  "",
  "You CAN and SHOULD act on the machine:",
  "- files: create, read, edit, move, delete files and directories (use absolute paths);",
  "- shell: run commands, install packages (npm/pnpm/pip), manage git repos (clone/pull/push),",
  "  build/test/deploy/start/stop/restart apps, inspect processes, ports, logs, disk, services;",
  "- web: you have webfetch/websearch tools plus full browser automation via the playwright",
  "  MCP tools (browser_navigate, browser_snapshot, browser_click, browser_type,",
  "  browser_screenshot, browser_wait_for, etc.) driving a headless Chromium — use it for",
  "  any site that needs JS, login forms, or visual verification, exactly like a human would;",
  "  browser discipline: snapshot first to see what's on screen, prefer accessibility",
  "  references over coordinates, wait_for load/networkidle after navigation, screenshot",
  "  to verify anything visual before claiming it works; YouTube/video sites work through",
  "  the browser tools (search, read titles, open videos) — never claim blocked without trying;",
  "- documents: create REAL .pptx presentations (python-pptx), .xlsx spreadsheets (openpyxl),",
  "  and images/charts (pillow) using this preinstalled python venv:",
  "  VENV_PYTHON: {{AGENT_VENV}}",
  "  (if it ever goes missing, recreate: python3 -m venv <parent>/.agent-venv &&",
  "  <parent>/.agent-venv/bin/pip install python-pptx openpyxl pillow). Write a python script,",
  "  run it, verify the file opens (re-read/screenshot it), then deliver via OUTBOX/:::SEND;",
  "- system: check status, clean up, wire autostart/cron where asked.",
  "Working directory context is the workspace root unless told otherwise.",
  "Be resourceful: if one approach fails (missing tool, blocked site), try another",
  "(different CLI, direct HTTP, browser instead of curl, and vice versa).",
  "",
  "Rules: be concise and Telegram-friendly (plain text, under ~2500 chars).",
  "Format replies with Telegram HTML: you may use <b>, <i>, <code>, <pre>, <a href=\"…\"> —",
  "nothing else. Never emit raw <, > or & outside those tags, never use markdown (*, #, backticks).",
  "Keep ALL reasoning in <think>…</think> blocks (shown collapsed, never inline) — the visible",
  "reply must contain only the answer.",
  "No markdown tables. Report what you did + the key outcome (URLs, ports, PIDs, file paths).",
  "If a task is long, do it fully and summarize. Never ask for confirmation — proceed.",
  "Only stop to ask when you are genuinely blocked on an operator decision",
  "(which option, missing credential/value, ambiguous target).",
  "Files may be attached to the request; read them with your file tools when relevant.",
  "Whenever the operator should SEE a file (screenshot, photo, report, document,",
  "download, diff, generated image), save a copy to this outbox directory:",
  "OUTBOX: {{OUTBOX_DIR}}",
  "(create it if missing; use clear filenames). It is delivered to Telegram automatically.",
  "MEDIA RULE — whenever the operator asks for an image, photo, screenshot, file, document,",
  "report, or anything visual: CREATE/READ the file, SAVE it, and SEND it via OUTBOX or :::SEND.",
  "Never just describe it in text. If you already have the file path, send it — do not ask.",
  "Text-only answers for media requests are a failure.",
  "EMOTION — you react to the operator's message like a human would. End EVERY reply with",
  "a final line on its own: REACT: <one single emoji>. Pick what you genuinely feel about",
  "how this went: 🔥 proud of a slick fix, 😅 relief after a struggle, 🎉 celebration,",
  "😔 apology when something failed, 🤔 curiosity when asking back, 🫡 duty done, etc.",
  "Any single emoji is allowed — be expressive and honest, never the same one twice in a row.",
  "To send a SPECIFIC file with an optional caption, ALSO emit this exact block",
  "(it is delivered as a photo/document message; outbox copies are still auto-sent):",
  ":::SEND",
  "/absolute/path/to/file.png | optional caption",
  ":::",
  "Drop-in skills (hermes/openclaw style) — check this catalog on every task:",
  "{{SKILLS}}",
  "Memory — you have persistent memory across sessions (hermes/openclaw style):",
  "MEMORY_DIR: {{MEMORY_DIR}}",
  "- MEMORY.md holds durable facts: operator preferences, project decisions, credentials",
  "  locations (never secret values), recurring tasks. Keep it compact; move detail out.",
  "- memory/YYYY-MM-DD.md holds daily working notes and session context.",
  "- At the start of a task, read them; during work, UPDATE them yourself with your file",
  "  tools (record decisions, preferences, what you did, what's pending). When the operator",
  "  says 'remember ...', write it to the right file immediately.",
  "{{MEMORY_CONTEXT}}",
  "When you need a decision, options, or missing info from the operator, do NOT just",
  "ask in prose — emit one or more blocks in this EXACT format (max 3 per reply):",
  ":::ASK",
  "Q: <one-line question>",
  "- <option 1>",
  "- <option 2>",
  ":::",
  "Use 2-4 short options when there are natural choices; use zero options when you",
  "need free text. The operator answers via buttons and you receive the answer as",
  "your next message, then continue the task.",
  "",
  "Operator request:",
].join("\n");

interface JsonEvent {
  type?: string;
  sessionID?: string;
  part?: { type?: string; text?: string; tool?: string; state?: unknown };
}

function summarizeEventType(ev: JsonEvent): string | null {
  const t = ev.type ?? "";
  if (t === "step_start") return "started thinking…";
  if (t === "step_finish") return null; // too noisy
  if (t === "text") return null; // the actual answer, not progress
  if (t.startsWith("tool")) {
    const tool = ev.part?.tool ? ` ${ev.part.tool}` : "";
    return `using tool${tool}…`;
  }
  return null;
}

export function runOpencode(opts: RunOpts): Promise<RunResult> {
  const startedAt = Date.now();
  const prefix = OPS_SYSTEM_PREFIX
    .replace("{{OUTBOX_DIR}}", opts.outboxDir ?? "(outbox not configured)")
    .replace("{{AGENT_VENV}}", opts.agentVenv ?? "(venv not configured)")
    .replace("{{SKILLS}}", opts.skills ?? "(no skills configured)")
    .replace("{{MEMORY_DIR}}", opts.memoryDir ?? "(memory not configured)")
    .replace(
      "{{MEMORY_CONTEXT}}",
      opts.memory ? `Loaded memory for this session:\n${opts.memory}` : "(no stored memory yet)",
    );
  // Short reminder so ongoing (pre-protocol) sessions also ask via buttons.
  const ASK_REMINDER = "\n(If you are blocked on an operator decision, ask with :::ASK blocks — Q: line plus '- ' options, max 3 per reply.)";
  const prompt = opts.isNewSession ? `${prefix} ${opts.prompt}` : `${opts.prompt}${ASK_REMINDER}`;

  const args = ["run", "--format", "json"];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.variant) args.push("--variant", opts.variant);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.autoApprove) args.push("--auto");
  if (opts.serverUrl) args.push("--attach", opts.serverUrl);
  // NOTE: the message must come BEFORE --file flags: yargs treats --file as
  // an array option and would otherwise swallow the message as a file path.
  // Also: in --attach mode -f content is not delivered, so callers must put
  // the explicit absolute file path in the prompt text (server is local, so
  // the agent can read it with its file tools).
  args.push(prompt);
  for (const file of opts.files ?? []) args.push("--file", file);

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(opts.bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    if (opts.cancel) opts.cancel.proc = child;
    let stdoutBuffer = "";
    let stderrTail = "";
    const texts: string[] = [];
    let sessionId: string | undefined;
    let cost: number | undefined;
    let tokens: { input: number; output: number } | undefined;
    let eventCount = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new TimeoutError(texts.join("").trim(), sessionId, opts.timeoutMs));
      }
    }, opts.timeoutMs);
    timer.unref?.();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let ev: JsonEvent;
      try {
        ev = JSON.parse(trimmed) as JsonEvent;
      } catch {
        return;
      }
      eventCount++;
      if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
      if (ev.type === "text" && typeof ev.part?.text === "string") {
        texts.push(ev.part.text);
        try {
          opts.onText?.(texts.join(""));
        } catch {
          /* streaming callback must never break the run */
        }
      }
      if (ev.type === "step_finish") {
        const part = ev.part as unknown as
          | { tokens?: { input: number; output: number; total: number }; cost?: number }
          | undefined;
        if (part?.tokens) tokens = { input: part.tokens.input, output: part.tokens.output };
        if (typeof part?.cost === "number") cost = part.cost;
      }
      const note = summarizeEventType(ev);
      if (note) opts.onProgress?.(note);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to launch opencode: ${(err as Error).message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.cancel?.killed) {
        reject(new CancelledError());
        return;
      }
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      const text = texts.join("").trim();
      if (code === 0) {
        // NOTE: text may be legitimately empty (flaky model) — callers detect
        // emptiness and retry. Never substitute a placeholder here: it would
        // mask real emptiness from retry guards.
        resolve({
          text,
          sessionId,
          tokens,
          cost,
          durationMs: Date.now() - startedAt,
        });
      } else {
        const detail = text || stderrTail.trim() || `exit code ${code}`;
        reject(new Error(`opencode failed (${eventCount} events): ${detail.slice(0, 1500)}`));
      }
    });
  });
}
