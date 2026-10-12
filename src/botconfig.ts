// Generates the bot's isolated opencode config home (XDG_CONFIG_HOME override).
// Keeps MCP/tooling setup scoped to the bot so the surrounding environment's
// own opencode config is never touched.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Locate the installed @playwright/mcp CLI (stable absolute path for MCP). */
export async function findPlaywrightMcpCli(searchDirs: string[]): Promise<string | undefined> {
  for (const dir of searchDirs) {
    let current: string | undefined = path.resolve(dir);
    while (current && current !== path.dirname(current)) {
      const candidate = path.join(current, "node_modules", "@playwright", "mcp", "cli.js");
      if (await exists(candidate)) return candidate;
      current = path.dirname(current);
    }
  }
  return undefined;
}

export async function findChromium(): Promise<string | undefined> {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/repl/tools/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return undefined;
}

export interface BotConfigHome {
  dir: string;
  playwrightMcpCli?: string;
  chromium?: string;
}

/** Write <configHome>/opencode/opencode.json with the browser MCP (if resolvable). */
export async function ensureBotConfigHome(opts: {
  configHome: string;
  workDir: string;
  dataDir: string;
}): Promise<BotConfigHome> {
  const searchDirs = [process.cwd(), opts.dataDir, opts.workDir, new URL(".", import.meta.url).pathname];
  const playwrightMcpCli = await findPlaywrightMcpCli(searchDirs);
  const chromium = await findChromium();

  const opencodeDir = path.join(opts.configHome, "opencode");
  await mkdir(opencodeDir, { recursive: true });

  const config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (playwrightMcpCli && chromium) {
    const mcpOut = path.join(opts.dataDir, "mcp-out");
    await mkdir(mcpOut, { recursive: true });
    config.mcp = {
      playwright: {
        type: "local",
        command: [
          "node",
          playwrightMcpCli,
          "--headless",
          "--no-sandbox",
          "--isolated",
          "--caps",
          "vision",
          "--browser",
          "chrome",
          "--executable-path",
          chromium,
          "--output-dir",
          mcpOut,
        ],
        enabled: true,
        timeout: 30000,
      },
    };
    console.log(`[botconfig] playwright MCP: node ${playwrightMcpCli} + ${chromium}`);
  } else {
    console.warn(
      `[botconfig] browser MCP disabled (playwright cli: ${playwrightMcpCli ?? "not found"}, chromium: ${chromium ?? "not found"}). ` +
        "The agent still has shell/webfetch/websearch tools.",
    );
  }

  await writeFile(path.join(opencodeDir, "opencode.json"), JSON.stringify(config, null, 2), "utf8");
  return { dir: opts.configHome, playwrightMcpCli, chromium };
}
