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

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
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
  voice?: TgVoice;
  audio?: TgDocument;
  reply_to_message?: TgMessage;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgReaction {
  type: string;
  emoji?: string;
  custom_emoji_id?: string;
}

export interface TgMessageReaction {
  chat: TgChat;
  message_id: number;
  user?: TgUser;
  actor_chat?: TgChat;
  old_reaction: TgReaction[];
  new_reaction: TgReaction[];
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
  message_reaction?: TgMessageReaction;
  message_reaction_count?: unknown;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface BotCommand {
  command: string;
  description: string;
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
  /** Recent bot-sent messages for reaction context: "chatId:msgId" → snippet. */
  private sentCache = new Map<string, { text: string; at: number }>();

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

  /** Register the "/" command menu (otherwise clients show no autocomplete). */
  async setMyCommands(commands: BotCommand[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async getUpdates(offset?: number, timeoutSec = 50): Promise<TgUpdate[]> {
    // Long poll: give the request timeout + a buffer so we don't abort early.
    return this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "edited_message", "channel_post", "callback_query", "message_reaction"],
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

  async sendMessage(chatId: number, text: string, replyTo?: number, replyMarkup?: ReplyMarkup): Promise<TgMessage> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (replyTo !== undefined) payload.reply_to_message_id = replyTo;
    if (replyMarkup !== undefined) payload.reply_markup = replyMarkup;
    const sent = await this.call<TgMessage>("sendMessage", payload);
    this.rememberSent(chatId, sent.message_id, text);
    return sent;
  }

  /** What did we recently send as message_id in chatId? (for reaction context) */
  sentSnippet(chatId: number, messageId: number): string | undefined {
    return this.sentCache.get(`${chatId}:${messageId}`)?.text;
  }

  private rememberSent(chatId: number, messageId: number, text: string): void {
    this.sentCache.set(`${chatId}:${messageId}`, { text: text.slice(0, 300), at: Date.now() });
    if (this.sentCache.size > 300) {
      const cutoff = Date.now() - 2 * 3600 * 1000;
      for (const [key, value] of this.sentCache) {
        if (value.at < cutoff) this.sentCache.delete(key);
      }
    }
  }

  /** React to a message (best-effort — never throws). */  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    try {
      await this.call("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }, 10_000);
    } catch {
      // Reactions may be unavailable in some chats — never break the flow.
    }
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

  private async sendFile(method: "sendPhoto" | "sendDocument", chatId: number, filePath: string, caption?: string): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const data = await readFile(filePath);
    const form = new FormData();
    form.set("chat_id", String(chatId));
    const field = method === "sendPhoto" ? "photo" : "document";
    form.set(field, new Blob([new Uint8Array(data)]), path.basename(filePath));
    if (caption) form.set("caption", caption.slice(0, 1000));
    const res = await fetch(`${this.base}/${method}`, { method: "POST", body: form });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => res.statusText);
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
    try {
      const body = (await res.json()) as ApiEnvelope<TgMessage>;
      if (body.ok) this.rememberSent(chatId, body.result.message_id, caption || path.basename(filePath));
    } catch {
      // Non-critical: message went through, only context tracking failed.
    }
  }

  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void> {
    await this.sendFile("sendPhoto", chatId, filePath, caption);
  }

  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
    await this.sendFile("sendDocument", chatId, filePath, caption);
  }

  /** Send audio bytes as a Telegram voice note (ogg/opus) or audio file (mp3). */
  async sendVoiceData(
    chatId: number,
    audio: Buffer,
    filename: string,
    mime: string,
    caption?: string,
    replyTo?: number,
  ): Promise<void> {
    const { method, field } =
      filename.endsWith(".ogg") || mime.includes("opus") || mime.includes("ogg")
        ? { method: "sendVoice", field: "voice" }
        : { method: "sendAudio", field: "audio" };
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(field, new Blob([new Uint8Array(audio)], { type: mime }), filename);
    if (caption) form.set("caption", caption.slice(0, 1000));
    if (replyTo !== undefined) form.set("reply_to_message_id", String(replyTo));
    const res = await fetch(`${this.base}/${method}`, { method: "POST", body: form });
    if (!res.ok) {
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => res.statusText);
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, 10_000);
    } catch {
      // Best-effort (already deleted, too old, or no rights).
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

export interface QuotedMessage {
  text: string;
  fromName: string;
  isBot: boolean;
  messageId: number;
}

/**
 * What is this message replying to? Returns the quoted message (bot's older
 * reply or the user's own earlier message) with attribution, if any.
 */
export function extractQuote(message: TgMessage, botId?: number): QuotedMessage | undefined {
  const quoted = message.reply_to_message;
  if (!quoted) return undefined;
  const text = (quoted.text ?? quoted.caption ?? "").trim();
  if (!text) return undefined;
  const from = quoted.from;
  const isBot = from ? from.is_bot || (botId !== undefined && from.id === botId) : false;
  const fromName = isBot
    ? "you (the assistant)"
    : from?.username
      ? `@${from.username}`
      : from?.first_name || "the operator";
  return { text: text.slice(0, 1000), fromName, isBot, messageId: quoted.message_id };
}

/** Render quoted context as a prompt prefix so the agent knows what "this" means. */
export function quotePrefix(quote: QuotedMessage): string {
  return quote.isBot
    ? `[The operator replied to YOUR earlier message: "${quote.text}"]\n`
    : `[The operator replied to ${quote.fromName}'s earlier message: "${quote.text}"]\n`;
}

export interface MediaAttachment {
  message: TgMessage;
  kind: "photo" | "document";
  fileId: string;
  fileName: string;
  fileSize?: number;
  caption: string;
}

export interface VoiceAttachment {
  message: TgMessage;
  fileId: string;
  duration: number;
  fileSize?: number;
}

/** Extract a voice/audio attachment from an update, if present. */
export function extractVoice(update: TgUpdate): VoiceAttachment | null {
  const message = update.message ?? update.channel_post;
  if (!message) return null;
  const voice = message.voice;
  if (voice) {
    return { message, fileId: voice.file_id, duration: voice.duration, fileSize: voice.file_size };
  }
  if (message.document && (message.document.mime_type ?? "").startsWith("audio/")) {
    return { message, fileId: message.document.file_id, duration: 0, fileSize: message.document.file_size };
  }
  return null;
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
