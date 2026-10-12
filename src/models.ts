// `opencode models` / `opencode session` introspection for chat commands.
// Parses CLI output so users can browse and switch models/sessions from Telegram.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ModelInfo {
  /** Full id, e.g. "opencode/exo-free". */
  id: string;
  name: string;
  free: boolean;
  vision: boolean;
  attachment: boolean;
  contextK?: number;
  /** Reasoning-effort variants, e.g. ["minimal","low","medium","high","xhigh"]. */
  variants: string[];
}

export interface SessionInfo {
  id: string;
  title: string;
}

function runCli(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`opencode ${args[0]} failed: ${(stderr as string)?.trim() || (err as Error).message}`.slice(0, 500)));
        return;
      }
      resolve(stdout as string);
    });
  });
}

/** Parse `opencode models --verbose <provider>` output: "<id>" line + JSON block, repeated. */
export function parseVerboseModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].trim();
    const headerMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(header);
    if (!headerMatch) {
      i++;
      continue;
    }
    // Collect the following balanced-JSON block.
    let depth = 0;
    let started = false;
    const jsonLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      jsonLines.push(line);
      if (started && depth === 0) break;
    }
    i = j + 1;
    try {
      const meta = JSON.parse(jsonLines.join("\n")) as {
        name?: string;
        cost?: { input?: number; output?: number };
        capabilities?: { attachment?: boolean; input?: { image?: boolean } };
        limit?: { context?: number };
        variants?: Record<string, unknown>;
      };
      const free = (meta.cost?.input ?? -1) === 0 && (meta.cost?.output ?? -1) === 0;
      models.push({
        id: headerMatch[1],
        name: meta.name || headerMatch[1],
        free,
        vision: meta.capabilities?.input?.image === true,
        attachment: meta.capabilities?.attachment === true,
        contextK:
          typeof meta.limit?.context === "number" ? Math.round(meta.limit.context / 1000) : undefined,
        variants: meta.variants ? Object.keys(meta.variants) : [],
      });
    } catch {
      models.push({ id: headerMatch[1], name: headerMatch[1], free: false, vision: false, attachment: false, variants: [] });
    }
  }
  return models;
}

/** Parse plain `opencode models [provider]` output (one id per line). */
export function parsePlainModels(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/** Parse `opencode session list` table rows. */
export function parseSessionList(output: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const line of output.split("\n")) {
    const idMatch = /(ses_[A-Za-z0-9]+)/.exec(line);
    if (!idMatch) continue;
    const after = line.slice((idMatch.index ?? 0) + idMatch[1].length).trim();
    // Title is the text before the trailing timestamp; table columns are
    // space-separated, so strip a trailing time like "10:56 AM".
    const title = after.replace(/\s+\d{1,2}:\d{2}\s?(AM|PM)?$/i, "").trim() || "(untitled)";
    sessions.push({ id: idMatch[1], title: title.slice(0, 80) });
  }
  return sessions;
}

interface ModelsCache {
  fetchedAt: string;
  models: ModelInfo[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Verbose model metadata for a provider, cached 6h in the data dir. */
export async function getVerboseModels(opts: {
  bin: string;
  cwd: string;
  dataDir: string;
  provider: string;
}): Promise<ModelInfo[]> {
  const cacheFile = path.join(opts.dataDir, `models-${opts.provider}.json`);
  try {
    const raw = await readFile(cacheFile, "utf8");
    const cached = JSON.parse(raw) as ModelsCache;
    if (Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS && Array.isArray(cached.models)) {
      return cached.models;
    }
  } catch {
    // Cache miss — fetch fresh.
  }
  const output = await runCli(opts.bin, ["models", "--verbose", opts.provider], opts.cwd, 60_000);
  const models = parseVerboseModels(output);
  await mkdir(opts.dataDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), models } satisfies ModelsCache), "utf8");
  return models;
}

export async function listPlainModels(opts: { bin: string; cwd: string; provider?: string }): Promise<string[]> {
  const args = opts.provider ? ["models", opts.provider] : ["models"];
  const output = await runCli(opts.bin, args, opts.cwd, 60_000);
  return parsePlainModels(output);
}

export async function listSessions(opts: { bin: string; cwd: string }): Promise<SessionInfo[]> {
  const output = await runCli(opts.bin, ["session", "list"], opts.cwd, 30_000);
  return parseSessionList(output);
}

export interface RecallHit {
  sessionId: string;
  title: string;
  role: string;
  snippet: string;
}

/** Export one session's transcript (JSON). Throws on timeout/corrupt output. */
export async function exportSession(opts: { bin: string; cwd: string; id: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(opts.bin, ["export", opts.id], { cwd: opts.cwd, timeout: 25_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`export failed: ${(stderr as string)?.trim().slice(0, 200) || (err as Error).message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout as string));
      } catch {
        reject(new Error("export returned corrupt JSON"));
      }
    });
  });
}

/**
 * Cross-session recall (hermes-style): search recent transcripts for keywords.
 * Returns hits with snippets; skips sessions that fail to export.
 */
export async function recallSessions(opts: {
  bin: string;
  cwd: string;
  query: string;
  limit?: number;
}): Promise<{ hits: RecallHit[]; searched: number; skipped: number }> {
  const words = opts.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return { hits: [], searched: 0, skipped: 0 };
  const sessions = (await listSessions({ bin: opts.bin, cwd: opts.cwd })).slice(0, opts.limit ?? 6);
  const hits: RecallHit[] = [];
  let searched = 0;
  let skipped = 0;
  for (const session of sessions) {
    let data: { messages?: { info?: { role?: string }; parts?: { type?: string; text?: string }[] }[] };
    try {
      data = (await exportSession({ bin: opts.bin, cwd: opts.cwd, id: session.id })) as typeof data;
      searched++;
    } catch {
      skipped++;
      continue;
    }
    let perSession = 0;
    for (const msg of data.messages ?? []) {
      if (perSession >= 2) break;
      const role = msg.info?.role ?? "?";
      const texts = (msg.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text as string);
      const combined = texts.join("\n");
      const lower = combined.toLowerCase();
      if (!combined.trim() || !words.every((w) => lower.includes(w))) continue;
      const first = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      const snippet = combined.slice(Math.max(0, first - 120), first + 200).replace(/\s+/g, " ").trim();
      hits.push({ sessionId: session.id, title: session.title, role, snippet: snippet.slice(0, 300) });
      perSession++;
      if (hits.length >= 8) break;
    }
    if (hits.length >= 8) break;
  }
  return { hits, searched, skipped };
}

/** Look up one model id in cached verbose data (opencode provider only). */
export async function lookupModel(opts: {
  bin: string;
  cwd: string;
  dataDir: string;
  id: string;
}): Promise<ModelInfo | undefined> {
  const provider = opts.id.includes("/") ? opts.id.split("/")[0] : "opencode";
  try {
    const models = await getVerboseModels({ bin: opts.bin, cwd: opts.cwd, dataDir: opts.dataDir, provider });
    return models.find((m) => m.id === opts.id || m.id === `opencode/${opts.id}`);
  } catch {
    return undefined;
  }
}
