// Session context measurement + auto-compaction against the opencode server.
// Context size = the last assistant message's prompt tokens (total - output):
// that is exactly what the next turn will re-send (system + history + cache).
// Compaction = POST /session/{id}/summarize (AI summary; recent context is
// replaced by a compact digest — proven to drop 13k → 1k while keeping facts).
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** "opencode/muse-spark-1.3" → { providerID: "opencode", modelID: "muse-spark-1.3" }. */
export function splitModelId(id: string): ModelRef {
  const i = id.indexOf("/");
  return i > 0 ? { providerID: id.slice(0, i), modelID: id.slice(i + 1) } : { providerID: "opencode", modelID: id };
}

/** Last assistant message's prompt tokens for a session (undefined = not measurable). */
export async function sessionContextTokens(serverUrl: string, sessionId: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${serverUrl}/session/${sessionId}/message`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    const msgs = Array.isArray(data)
      ? data
      : ((data as { data?: unknown[] })?.data ?? []);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = (msgs[i] as { info?: { role?: string; tokens?: { total?: number; output?: number } } })?.info;
      if (info?.role !== "assistant") continue;
      const t = info.tokens;
      if (!t || !(typeof t.total === "number") || t.total <= 0) continue;
      return Math.max(0, t.total - (t.output ?? 0));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * AI-compaction of a session. Tries each model candidate in order (a dead /
 * deprecated modelID must not block compaction). Returns true only when the
 * server actually produced a summary.
 */
export async function summarizeSession(
  serverUrl: string,
  sessionId: string,
  models: ModelRef[],
): Promise<boolean> {
  for (const m of models) {
    if (!m.modelID) continue;
    try {
      const res = await fetch(`${serverUrl}/session/${sessionId}/summarize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerID: m.providerID, modelID: m.modelID }),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) {
        const body = (await res.text()).trim();
        return body !== "false";
      }
      if (res.status >= 500) return false; // server-side, don't hammer
      // 4xx → try the next model candidate.
    } catch {
      return false; // timeout / network — retrying would just stack latency
    }
  }
  return false;
}
