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

export interface SendFile {
  filePath: string;
  caption: string;
}

const SEND_RE = /:::SEND\s*\n([\s\S]*?)\n:::/g;

/**
 * Explicit media sends. The agent emits:
 *   :::SEND
 *   /absolute/path/to/file.png | optional caption
 *   /absolute/path/to/report.pdf
 *   :::
 * One file per line; caption after `|` is optional.
 */
export function parseSendBlocks(text: string): SendFile[] {
  const files: SendFile[] = [];
  SEND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEND_RE.exec(text)) !== null && files.length < 5) {
    for (const rawLine of match[1].split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const [p, ...captionParts] = line.split("|");
      const filePath = p.trim();
      if (!filePath.startsWith("/")) continue;
      files.push({ filePath, caption: captionParts.join("|").trim().slice(0, 200) });
      if (files.length >= 5) break;
    }
  }
  return files;
}

/** Remove SEND blocks from the text shown in chat (they're delivered as media). */
export function stripSendBlocks(text: string): string {
  SEND_RE.lastIndex = 0;
  return text.replace(SEND_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ThinkBlock {
  thinking: string;
  cleaned: string;
}

const THINK_RE = /<(think|thinking)>([\s\S]*?)(?:<\/\1>|$)/gi;
const STRAY_THINK_RE = /<\/?think(?:ing)?>/gi;

// Protocol leakage — these tokens never belong in a visible reply.
const PROTOCOL_RE = /:::ASK|REACT:|SEND block/i;
// Infra mentions — mildly meta, weak signal on their own.
const INFRA_RE = /\boutbox\b|MEMORY\.md|SKILL\.md/i;
// "The operator says …" as an opener — quoting the user to oneself.
const QUOTE_SELF_RE = /^(the operator says|the user (says|wants|is asking))/i;
// Deliberation openers.
const DELIBERATE_RE = /^(so no task|okay,? so|i should|i need to|i('ll| will)|let me |should i|do i need|no need for|keep it (short|brief)|could |might |maybe i|not necessary)/i;

function thinkingScore(sentence: string): number {
  const s = sentence.trim();
  if (!s) return 0;
  if (PROTOCOL_RE.test(s)) return 2;
  if (QUOTE_SELF_RE.test(s)) return 2;
  if (INFRA_RE.test(s) || DELIBERATE_RE.test(s)) return 1;
  return 0;
}

function splitSentences(text: string): string[] {
  const raw =
    text.match(/[^.!?।\n]+[.!?।]+["']?|[^.!?।\n]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  // Don't split filenames: "gmaps-fixed." + "html is delivered" → rejoin when the
  // next fragment starts with a lowercase file-extension-like token.
  const EXT_RE = /^(html?|js|ts|tsx|jsx|json|md|mkd|png|jp?g|gif|webp|txt|pdf|py|sh|yml|yaml|xml|css|mp3|mp4|ogg|oga|csv|xlsx?|pptx?|doc|log)\b/;
  const out: string[] = [];
  for (const frag of raw) {
    const prev = out[out.length - 1];
    if (prev && EXT_RE.test(frag) && /[A-Za-z0-9_-]+\.$/.test(prev)) {
      out[out.length - 1] = `${prev}${frag}`;
    } else {
      out.push(frag);
    }
  }
  return out;
}

/**
 * Some models inline chain-of-thought as <think>…</think> inside text parts.
 * Extract it for the collapsible block; never show it raw.
 */
export function parseThinkBlocks(text: string): ThinkBlock {
  const parts: string[] = [];
  THINK_RE.lastIndex = 0;
  const cleaned = text.replace(THINK_RE, (_m, _tag: string, body: string) => {
    const t = body.trim();
    if (t) parts.push(t);
    return "\n";
  });
  return {
    thinking: parts.join("\n\n").slice(0, 3000),
    cleaned: cleaned.replace(STRAY_THINK_RE, "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/**
 * Unmarked thinking: some models narrate reasoning as plain leading sentences
 * ("The operator says… I should… No need for :::ASK…") with no tags.
 * If the reply OPENS with strong self-talk, move the leading deliberation run
 * into the thinking block (one short factual gap sentence tolerated).
 * Conservative: needs a strong opener and either 3+ sentences or protocol
 * leakage, and always leaves ≥1 sentence. Legit answers are never touched:
 * they don't open with self-talk, and single-sentence runs revert.
 */
export function splitUnmarkedThinking(text: string): ThinkBlock {
  const sentences = splitSentences(text);
  if (sentences.length < 2 || thinkingScore(sentences[0]) < 2) return { thinking: "", cleaned: text };
  let runEnd = 0;
  let gaps = 0;
  let hasProtocol = false;
  for (let i = 0; i < sentences.length - 1; i++) {
    const score = thinkingScore(sentences[i]);
    if (score >= 1) {
      runEnd = i + 1;
      gaps = 0;
      if (PROTOCOL_RE.test(sentences[i])) hasProtocol = true;
    } else {
      gaps++;
      if (gaps > 1) break;
    }
  }
  if (runEnd < 3 && !hasProtocol) return { thinking: "", cleaned: text };
  const thinking = sentences.slice(0, runEnd).join(" ");
  const cleaned = sentences.slice(runEnd).join(" ");
  if (!cleaned.trim()) return { thinking: "", cleaned: text };
  return { thinking: thinking.slice(0, 3000), cleaned };
}

/**
 * AI-chosen reaction. The agent ends its reply with a final line:
 *   REACT: 🔥
 * Only the LAST non-empty line counts. Returns the emoji + cleaned text.
 * (Telegram only accepts its native reaction set — invalid ones are
 * rejected by the API call, which fails silently by design.)
 */
export function parseReactLine(text: string): { emoji?: string; cleaned: string } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const match = /^REACT:\s*(\S+)\s*$/.exec(lines[i].trim());
    if (!match) return { cleaned: text };
    const emoji = match[1].slice(0, 16);
    lines.splice(i, 1);
    return { emoji, cleaned: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
  }
  return { cleaned: text };
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
