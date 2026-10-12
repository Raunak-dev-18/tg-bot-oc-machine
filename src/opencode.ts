// Bridge between Telegram messages and opencode (`opencode run --format json`).
// Each Telegram chat maps to a persistent opencode session id so the agent
// keeps memory across messages. New chats start with an ops system prompt.
import { spawn } from "node:child_process";

export interface RunOpts {
  prompt: string;
  sessionId?: string;
  isNewSession: boolean;
  model?: string;
  agent: string;
  autoApprove: boolean;
  timeoutMs: number;
  cwd: string;
  bin: string;
  serverUrl?: string;
  /** Local file paths to attach to the message (`opencode run -f`). */
  files?: string[];
  onProgress?: (note: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  tokens?: { input: number; output: number };
  cost?: number;
  durationMs: number;
}

const OPS_SYSTEM_PREFIX = [
  "You are the brain of a Telegram remote-control bot for this Linux machine.",
  "The operator chats via Telegram; your reply is sent back as the chat reply.",
  "You CAN and SHOULD act on the machine: run shell commands, manage files,",
  "clone git repos, install deps, deploy/start/stop apps, inspect logs and processes.",
  "Working directory context is the workspace root unless told otherwise.",
  "Rules: be concise and Telegram-friendly (plain text, under ~2500 chars).",
  "No markdown tables. Confirm what you did + key output. If a task is long,",
  "do it fully and summarize. Never ask for confirmation — proceed.",
  "Only stop to ask when you are genuinely blocked on an operator decision",
  "(which option, missing credential/value, ambiguous target).",
  "Files may be attached to the request; read them with your file tools when relevant.",
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
  // Short reminder so ongoing (pre-protocol) sessions also ask via buttons.
  const ASK_REMINDER = "\n(If you are blocked on an operator decision, ask with :::ASK blocks — Q: line plus '- ' options, max 3 per reply.)";
  const prompt = opts.isNewSession ? `${OPS_SYSTEM_PREFIX} ${opts.prompt}` : `${opts.prompt}${ASK_REMINDER}`;

  const args = ["run", "--format", "json"];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
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
        reject(new Error(`opencode timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
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
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      const text = texts.join("").trim();
      if (code === 0) {
        resolve({
          text: text || "(opencode returned no text)",
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
