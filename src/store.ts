// Tiny JSON-file store: per-chat opencode sessions + polling offset.
// Survives restarts; written atomically.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ChatState {
  sessionId?: string;
  model?: string;
  agent?: string;
  /** Last /free or /models listing, so /model <number> can select from it. */
  modelList?: string[];
  /** Last /sessions listing, so /switch <number> can select from it. */
  sessionList?: { id: string; title: string }[];
  /** Fresh list selection awaiting a bare-number reply ("2" picks option 2). */
  pendingSelect?: { kind: "model" | "session"; options: string[]; expiresAt: number };
  updatedAt: string;
}

export interface CronJob {
  id: string;
  chatId: number;
  spec: string;
  task: string;
  nextRun: number;
  createdAt: string;
  lastRun?: string;
  failures: number;
}

interface StoreData {
  offset?: number;
  chats: Record<string, ChatState>;
  crons: CronJob[];
}

export class Store {
  private file: string;
  private data: StoreData = { chats: {}, crons: [] };
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "bot-state.json");
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as StoreData;
      if (parsed && typeof parsed === "object" && parsed.chats) {
        this.data = { offset: parsed.offset, chats: parsed.chats, crons: parsed.crons ?? [] };
      }
    } catch {
      // First run — start empty.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist();
    }, 200);
    this.saveTimer.unref?.();
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await import("node:fs/promises").then((fs) => fs.rename(tmp, this.file));
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.persist();
  }

  getOffset(): number | undefined {
    return this.data.offset;
  }

  setOffset(offset: number): void {
    this.data.offset = offset;
    this.scheduleSave();
  }

  getChat(key: string): ChatState {
    return this.data.chats[key] ?? { updatedAt: new Date().toISOString() };
  }

  setChat(key: string, state: ChatState): void {
    this.data.chats[key] = { ...state, updatedAt: new Date().toISOString() };
    this.scheduleSave();
  }

  clearChat(key: string): void {
    delete this.data.chats[key];
    this.scheduleSave();
  }

  getCrons(): CronJob[] {
    return this.data.crons;
  }

  addCron(job: CronJob): void {
    this.data.crons.push(job);
    this.scheduleSave();
  }

  updateCron(id: string, patch: Partial<CronJob>): void {
    const job = this.data.crons.find((j) => j.id === id);
    if (job) {
      Object.assign(job, patch);
      this.scheduleSave();
    }
  }

  removeCron(id: string): boolean {
    const before = this.data.crons.length;
    this.data.crons = this.data.crons.filter((j) => j.id !== id);
    if (this.data.crons.length !== before) {
      this.scheduleSave();
      return true;
    }
    return false;
  }
}
