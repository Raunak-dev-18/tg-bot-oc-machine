// Manages a background `opencode serve` so the requirement
// "opencode kept running in the background" holds even after reboots:
// the bot ensures the server is up and `opencode run --attach` reuses it.
import { spawn, type ChildProcess } from "node:child_process";

export async function isServeHealthy(serverUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${serverUrl}/global/health`, { signal: ctrl.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { healthy?: boolean };
      return body.healthy === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function ensureServe(opts: {
  bin: string;
  cwd: string;
  port: number;
  enabled: boolean;
}): Promise<{ serverUrl: string | undefined; child: ChildProcess | undefined }> {
  if (!opts.enabled) return { serverUrl: undefined, child: undefined };
  const serverUrl = `http://127.0.0.1:${opts.port}`;
  if (await isServeHealthy(serverUrl)) {
    console.log(`[serve] reusing healthy opencode server at ${serverUrl}`);
    return { serverUrl, child: undefined };
  }

  console.log(`[serve] starting background opencode server on ${serverUrl} …`);
  const child = spawn(opts.bin, ["serve", "--port", String(opts.port), "--hostname", "127.0.0.1"], {
    cwd: opts.cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", (err) => console.error(`[serve] failed to start: ${(err as Error).message}`));

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isServeHealthy(serverUrl)) {
      console.log(`[serve] opencode server healthy at ${serverUrl}`);
      return { serverUrl, child };
    }
  }
  console.warn("[serve] server did not become healthy; falling back to per-message opencode runs");
  return { serverUrl: undefined, child };
}
