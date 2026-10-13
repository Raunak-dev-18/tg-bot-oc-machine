// Voice-to-voice via Sarvam AI (hermes/openclaw-style voice channel, multilingual).
// In: Telegram voice notes (.oga Opus) → Sarvam STT (auto language detect).
// Out: agent reply → Sarvam TTS (opus → Telegram voice note, mp3 fallback).
import { readFile } from "node:fs/promises";
import path from "node:path";

const STT_URL = "https://api.sarvam.ai/speech-to-text";
const TTS_URL = "https://api.sarvam.ai/text-to-speech/stream";

/** TTS-supported language codes. STT may return others (as-IN, ur-IN…) → mapped to en-IN. */
const TTS_LANGS = new Set([
  "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN",
  "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
]);

export function mapToTtsLang(code?: string): string {
  if (code && TTS_LANGS.has(code)) return code;
  if (code && TTS_LANGS.has(`${code.split("-")[0]}-IN`)) return `${code.split("-")[0]}-IN`;
  return "en-IN";
}

export function langLabel(code?: string): string {
  const names: Record<string, string> = {
    "hi-IN": "Hindi", "en-IN": "English", "bn-IN": "Bengali", "gu-IN": "Gujarati",
    "kn-IN": "Kannada", "ml-IN": "Malayalam", "mr-IN": "Marathi", "ta-IN": "Tamil",
    "te-IN": "Telugu", "pa-IN": "Punjabi", "od-IN": "Odia", "ur-IN": "Urdu",
  };
  if (!code) return "auto";
  return names[code] ?? code;
}

export interface Transcript {
  text: string;
  languageCode?: string;
  probability?: number;
}

export class Sarvam {
  constructor(
    private apiKey: string,
    private ttsModel = "bulbul:v2",
    private speaker?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "api-subscription-key": this.apiKey, ...extra };
  }

  private async throwIfError(res: Response, context: string): Promise<void> {
    if (res.ok) return;
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body.error?.message) detail = `${body.error.code ?? "error"}: ${body.error.message}`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Sarvam ${context} failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  /** Transcribe an audio file. Language auto-detected (pass "unknown"). */
  async transcribe(filePath: string, languageCode = "unknown"): Promise<Transcript> {
    const data = await readFile(filePath);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(data)], { type: "audio/ogg" }), path.basename(filePath));
    form.set("model", "saaras:v4");
    form.set("language_code", languageCode);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(STT_URL, { method: "POST", headers: this.headers(), body: form, signal: ctrl.signal });
      await this.throwIfError(res, "speech-to-text");
      const body = (await res.json()) as {
        transcript?: string;
        language_code?: string;
        language_probability?: number;
      };
      const text = (body.transcript ?? "").trim();
      if (!text) throw new Error("Sarvam returned an empty transcript (silent audio?)");
      return { text, languageCode: body.language_code ?? undefined, probability: body.language_probability ?? undefined };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Synthesize speech. Returns raw audio bytes + suggested extension.
   * Codec opus first (Telegram voice notes), caller falls back to mp3.
   */
  async synthesize(text: string, languageCode: string, codec: "opus" | "mp3" = "opus"): Promise<{ audio: Buffer; ext: string }> {
    const payload: Record<string, unknown> = {
      text,
      language_code: languageCode,
      model: this.ttsModel,
      output_audio_codec: codec,
      // OPUS rejects the 22050 Hz default — 24000 Hz is Telegram-friendly.
      ...(codec === "opus" ? { speech_sample_rate: 24000 } : {}),
    };
    if (this.speaker) payload.speaker = this.speaker;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(TTS_URL, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      await this.throwIfError(res, "text-to-speech");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("Sarvam returned suspiciously small audio");
      return { audio: buf, ext: codec === "opus" ? "ogg" : "mp3" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Strip markdown/formatting so spoken output sounds natural. */
export function cleanForSpeech(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~#>|]/g, "")
      // Space out huge bare numbers for pronunciation (Sarvam wants 10,000 not 10000).
      .replace(/\b(\d{5,})\b/g, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ","))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, ". ")
      .replace(/\s*\n\s*/g, " ")
      .trim()
  );
}

/** Split cleaned text into sentence-aware chunks ≤ maxChars (for the 3500-char TTS cap). */
export function chunkForSpeech(text: string, maxChars = 900, maxChunks = 2): string[] {
  const cleaned = cleanForSpeech(text);
  if (cleaned.length <= maxChars) return [cleaned];
  const sentences = cleaned.match(/[^.!?।]+[.!?।]+["']?\s*|[^.!?।]+$/g) ?? [cleaned];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if ((current ? current.length + 1 : 0) + sentence.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks.slice(0, maxChunks).filter(Boolean);
}
