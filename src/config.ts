// Centralized env-based configuration. Secrets are NEVER committed —
// pass them via environment variables or the process manager.
import path from "node:path";

export interface BotConfig {
  token: string;
  allowedUsers: Set<number>;
  workDir: string;
  dataDir: string;
  outboxDir: string;
  opencodeBin: string;
  opencodeConfigHome: string;
  model: string | undefined;
  agent: string;
  autoApprove: boolean;
  timeoutMs: number;
  serverUrl: string | undefined;
  autoServe: boolean;
  servePort: number;
  pollTimeoutSec: number;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function parseAllowedUsers(raw: string | undefined): Set<number> {
  const set = new Set<number>();
  for (const part of (raw ?? "").split(/[,\s]+/)) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id !== 0) set.add(id);
  }
  return set;
}

export function loadConfig(): BotConfig {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN env var. Create a bot via @BotFather and export TELEGRAM_BOT_TOKEN=<token>.",
    );
  }

  const workspaceRoot = path.resolve(process.cwd(), "..", "..");
  const workDir = path.resolve(process.env.WORK_DIR ?? workspaceRoot);
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
  const outboxDir = path.resolve(process.env.OUTBOX_DIR ?? path.join(dataDir, "outbox"));
  const opencodeConfigHome = path.resolve(
    process.env.OPENCODE_CONFIG_HOME ?? path.join(dataDir, ".opencode-home"),
  );

  const serverUrlRaw = (process.env.OPENCODE_SERVER_URL ?? "").trim();

  return {
    token,
    allowedUsers: parseAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS),
    workDir,
    dataDir,
    outboxDir,
    opencodeConfigHome,
    opencodeBin: process.env.OPENCODE_BIN ?? "opencode",
    model: (process.env.OPENCODE_MODEL ?? "").trim() || undefined,
    agent: (process.env.OPENCODE_AGENT ?? "build").trim() || "build",
    autoApprove: parseBoolean(process.env.OPENCODE_AUTO_APPROVE, true),
    timeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? 600_000) || 600_000,
    serverUrl: serverUrlRaw || undefined,
    autoServe: parseBoolean(process.env.OPENCODE_AUTO_SERVE, true),
    servePort: Number(process.env.OPENCODE_SERVE_PORT ?? 4096) || 4096,
    pollTimeoutSec: Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 50) || 50,
  };
}
