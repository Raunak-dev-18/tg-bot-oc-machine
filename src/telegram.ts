// Minimal Telegram Bot API client over global fetch (zero dependencies).
// Uses long-polling getUpdates so no public webhook URL is required.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface ReplyMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ApiEnvelope<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TgApi {
  private base: string;

  constructor(private token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const body = (await res.json()) as ApiEnvelope<T>;
      if (!res.ok || !body.ok) {
        throw new Error(`Telegram ${method} failed: ${body.description ?? res.statusText}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  async getUpdates(offset?: number, timeoutSec = 50): Promise<TgUpdate[]> {
    // Long poll: give the request timeout + a buffer so we don't abort early.
    return this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "edited_message", "channel_post", "callback_query"],
      },
      (timeoutSec + 15) * 1000,
    );
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action }, 10_000);
    } catch {
      // Best-effort; typing indicator must never break the main flow.
    }
  }

  async sendMessage(chatId: number, text: string, replyTo?: number, replyMarkup?: ReplyMarkup): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyTo !== undefined) payload.reply_to_message_id = replyTo;
    if (replyMarkup !== undefined) payload.reply_markup = replyMarkup;
    await this.call("sendMessage", payload);
  }

  async answerCallback(queryId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: queryId, ...(text ? { text } : {}) }, 10_000);
    } catch {
      // Best-effort.
    }
  }

  async getFile(fileId: string): Promise<TgFile> {
    return this.call<TgFile>("getFile", { file_id: fileId });
  }

  /** Download a Telegram file path into destDir, returns the saved filename. */
  async downloadFile(filePath: string, destDir: string, filename: string): Promise<string> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await mkdir(destDir, { recursive: true });
    const safe = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
    const dest = path.join(destDir, safe);
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return dest;
  }

  async sendChunked(chatId: number, text: string, replyTo?: number): Promise<void> {
    const chunks = chunkText(text.trim() || "(empty response)");
    for (let i = 0; i < chunks.length; i++) {
      await this.sendMessage(chatId, chunks[i], i === 0 ? replyTo : undefined);
    }
  }
}

/** Split long replies into Telegram-safe ≤4096-char chunks on line boundaries. */
export function chunkText(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if ((current ? current.length + 1 : 0) + line.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Extract the human-typed content from an update (message text or caption). */
export function extractText(update: TgUpdate): { message: TgMessage; text: string } | null {
  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message) return null;
  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) return null;
  return { message, text };
}

export interface MediaAttachment {
  message: TgMessage;
  kind: "photo" | "document";
  fileId: string;
  fileName: string;
  fileSize?: number;
  caption: string;
}

/** Extract a photo/document attachment from an update, if present. */
export function extractMedia(update: TgUpdate): MediaAttachment | null {
  const message = update.message ?? update.channel_post;
  if (!message) return null;
  const caption = (message.caption ?? "").trim();
  if (message.photo && message.photo.length > 0) {
    const best = message.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {
      message,
      kind: "photo",
      fileId: best.file_id,
      fileName: `photo-${stamp}.jpg`,
      fileSize: best.file_size,
      caption,
    };
  }
  if (message.document) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {
      message,
      kind: "document",
      fileId: message.document.file_id,
      fileName: message.document.file_name || `file-${stamp}.bin`,
      fileSize: message.document.file_size,
      caption,
    };
  }
  return null;
}
