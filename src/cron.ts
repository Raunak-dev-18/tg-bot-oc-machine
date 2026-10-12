// Natural-language-ish schedule specs for /cron (hermes/openclaw-style automation,
// minimal cron dialect to stay dependency-free).
//
// Supported specs:
//   every 30m | every 2h        (minutes / hours from now)
//   daily 09:30                 (server-local time)

export interface ParsedSpec {
  kind: "interval" | "daily";
  everyMs?: number;
  hour?: number;
  minute?: number;
}

export function parseSpec(raw: string): ParsedSpec | undefined {
  const text = raw.trim().toLowerCase();
  const interval = /^every\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)$/.exec(text);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2];
    if (!Number.isInteger(n) || n <= 0) return undefined;
    const ms = unit.startsWith("m") ? n * 60000 : n * 3600000;
    if (ms < 60000) return undefined;
    return { kind: "interval", everyMs: ms };
  }
  const daily = /^daily\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return undefined;
    return { kind: "daily", hour, minute };
  }
  return undefined;
}

export function computeNext(spec: ParsedSpec, fromMs: number): number {
  if (spec.kind === "interval" && spec.everyMs) return fromMs + spec.everyMs;
  const d = new Date(fromMs);
  d.setHours(spec.hour ?? 9, spec.minute ?? 0, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function describeSpec(spec: ParsedSpec): string {
  if (spec.kind === "interval" && spec.everyMs) {
    const mins = Math.round(spec.everyMs / 60000);
    return mins >= 60 && mins % 60 === 0 ? `every ${mins / 60}h` : `every ${mins}m`;
  }
  return `daily ${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
}

export function formatNext(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (server-local)`;
}
