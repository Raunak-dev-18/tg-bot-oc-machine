// Persistent memory in the OpenClaw style, adapted to this bot:
// data/memory/MEMORY.md (curated long-term facts) + data/memory/YYYY-MM-DD.md
// (daily working notes). Loaded into new sessions; maintained by the agent.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_BUDGET = 4000;
export const DAILY_BUDGET = 2000;

export function memoryDir(dataDir: string): string {
  return path.join(dataDir, "memory");
}

function todayName(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}.md`;
}

async function readCapped(file: string, budget: number): Promise<string> {
  try {
    const raw = await readFile(file, "utf8");
    const text = raw.trim();
    if (!text) return "";
    return text.length > budget ? `${text.slice(0, budget)}\n…(truncated)` : text;
  } catch {
    return "";
  }
}

/** Build the memory context injected into fresh sessions. */
export async function loadMemoryContext(dataDir: string): Promise<string> {
  const dir = memoryDir(dataDir);
  const mem = await readCapped(path.join(dir, "MEMORY.md"), MEMORY_BUDGET);
  const today = await readCapped(path.join(dir, todayName(0)), DAILY_BUDGET);
  const yesterday = await readCapped(path.join(dir, todayName(-1)), DAILY_BUDGET);
  const parts: string[] = [];
  if (mem) parts.push(`[MEMORY.md — long-term facts]\n${mem}`);
  if (today) parts.push(`[Today's notes]\n${today}`);
  if (yesterday) parts.push(`[Yesterday's notes]\n${yesterday}`);
  return parts.join("\n\n");
}

export async function readMemoryFile(dataDir: string): Promise<string> {
  return readCapped(path.join(memoryDir(dataDir), "MEMORY.md"), 8000);
}

/** Manual `/remember <fact>` — appends a dated bullet to MEMORY.md. */
export async function rememberFact(dataDir: string, fact: string): Promise<void> {
  const dir = memoryDir(dataDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "MEMORY.md");
  const current = await readCapped(file, 100000);
  const stamp = todayName(0);
  const line = `- [${stamp}] ${fact.trim()}\n`;
  await writeFile(file, current ? `${current.replace(/\s+$/, "")}\n${line}` : `# Memory\n\n${line}`, "utf8");
}

export function memoryPaths(dataDir: string): { dir: string; memoryFile: string; todayFile: string } {
  const dir = memoryDir(dataDir);
  return { dir, memoryFile: path.join(dir, "MEMORY.md"), todayFile: path.join(dir, todayName(0)) };
}
