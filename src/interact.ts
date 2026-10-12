// Agent → operator questions. The agent emits :::ASK blocks (see system
// prompt); the bot renders each as a message with inline-keyboard buttons
// and forwards the tapped/typed answer back into the same opencode session.
import { randomBytes } from "node:crypto";

export interface AskQuestion {
  question: string;
  options: string[];
}

const ASK_RE = /:::ASK\s*\n([\s\S]*?)\n:::/g;
const MAX_BLOCKS = 3;
const MAX_OPTIONS = 6;

export function parseAskBlocks(text: string): AskQuestion[] {
  const questions: AskQuestion[] = [];
  ASK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASK_RE.exec(text)) !== null && questions.length < MAX_BLOCKS) {
    const body = match[1];
    let question = "";
    const options: string[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^Q\s*:/i.test(line)) {
        question = line.replace(/^Q\s*:\s*/i, "").trim();
      } else if (/^[-*•]\s+/.test(line)) {
        if (options.length < MAX_OPTIONS) options.push(line.replace(/^[-*•]\s+/, "").trim().slice(0, 80));
      } else if (!question) {
        question = line.slice(0, 200);
      }
    }
    if (question) questions.push({ question: question.slice(0, 300), options });
  }
  return questions;
}

/** Remove ASK blocks from the text shown in chat (they're rendered as buttons). */
export function stripAskBlocks(text: string): string {
  ASK_RE.lastIndex = 0;
  return text.replace(ASK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface PendingAnswer {
  chatId: number;
  sessionId?: string;
  question: string;
  option?: string;
  createdAt: number;
}

const PENDING_TTL_MS = 30 * 60 * 1000;

/** Registry mapping short callback tokens → pending answers. */
export class PendingQuestions {
  private pending = new Map<string, PendingAnswer>();

  add(answer: PendingAnswer): string {
    this.sweep();
    const token = randomBytes(6).toString("hex");
    this.pending.set(token, answer);
    return token;
  }

  take(token: string): PendingAnswer | undefined {
    const found = this.pending.get(token);
    if (found) this.pending.delete(token);
    if (found && Date.now() - found.createdAt > PENDING_TTL_MS) return undefined;
    return found;
  }

    private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.pending) {
      if (now - value.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    }
  }
}
