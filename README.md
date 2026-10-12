# tg-control-bot 🤖

Control a machine from Telegram, with [opencode](https://opencode.ai) as the AI brain.
Every chat message is forwarded to `opencode run` in your working directory;
the agent's reply comes back as the chat reply — and it can actually act:
run shell, manage files, clone repos, deploy/start/stop apps, read logs.

Zero runtime dependencies (plus `@playwright/mcp` for browser automation).
TypeScript source, bundled to a single file with esbuild.
Full instructions: **[usage.md](./usage.md)**.

## Features

- 💬 **Chat → opencode → chat** with per-chat persistent sessions (memory across messages)
- ❓ **Agent questions as buttons** — the agent emits `:::ASK` blocks, you tap inline-keyboard options, your answer flows back into the same session
- 📷📎 **Photos & documents both ways** — uploads go to the agent; agent files (screenshots, reports) come back via outbox + `:::SEND` blocks
- 🧠 **Persistent memory** — `MEMORY.md` + daily notes, agent-maintained (`/memory`, `/remember`)
- 🌐 **Browser automation** — headless Chromium via Playwright MCP, `/shot <url>` screenshots
- 🆓 **Free-model browser** — `/free` lists free models with vision (👁) markers; reply with the number to switch
- 📚 **Session browser** — `/sessions` lists recent runs; reply with the number to jump
- ⏰ **Scheduled tasks** — `/cron every 30m …`, `/crons`, `/uncron`
- 🛠️ **Skills** — drop-in `SKILL.md` guides (`/skills`); **recall** past sessions (`/recall`); **parallel** runs (`/parallel a ;; b`)
- 📤 **Direct sends** — `/send <path>` pushes any machine file to chat instantly
- 🔧 **Direct shell** — `/exec <command>` runs without AI; `/agent`, `/status`, `/new`, `/reset`
- 🖥️ **Background server** — auto-starts and reuses `opencode serve` (`--attach` mode)

## Quickstart

```bash
npm install   # or: pnpm install / yarn
cp .env.example .env   # then put your bot token in .env (or export it)

# 1. Create a bot with @BotFather on Telegram to get TELEGRAM_BOT_TOKEN
# 2. Run:
TELEGRAM_BOT_TOKEN=<token> WORK_DIR=/path/to/your/project npm run dev
```

Or build once and run the bundle:

```bash
npm run build
TELEGRAM_BOT_TOKEN=<token> WORK_DIR=/path/to/your/project npm start
```

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | empty (= open!) | Comma/space-separated numeric Telegram user IDs allowed to use the bot. Get yours from @userinfobot |
| `WORK_DIR` | repo root's parent's parent | Directory opencode operates in |
| `DATA_DIR` | `./data` | Session store + downloaded inbox |
| `OPENCODE_BIN` | `opencode` | opencode binary |
| `OPENCODE_MODEL` | opencode default | e.g. `opencode/exo-free` |
| `OPENCODE_AGENT` | `build` | opencode agent |
| `OPENCODE_AUTO_APPROVE` | `true` | Pass `--auto` so the agent acts without confirmation |
| `OPENCODE_TIMEOUT_MS` | `600000` | Per-message opencode timeout |
| `OPENCODE_AUTO_SERVE` | `true` | Auto-manage background `opencode serve` |
| `OPENCODE_SERVE_PORT` | `4096` | Serve port |
| `OPENCODE_SERVER_URL` | auto | Point at an externally managed server instead |
| `TELEGRAM_POLL_TIMEOUT` | `50` | Long-poll seconds |

## How it works

- `src/telegram.ts` — zero-dep Bot API client (long polling, chunked sends, inline keyboards, file download)
- `src/opencode.ts` — spawns `opencode run --format json`, parses JSONL events into reply text, tracks session/tokens/cost
- `src/interact.ts` — `:::ASK` block parser + pending-answer registry for button taps
- `src/models.ts` — parses `opencode models --verbose` (free = zero cost, vision flags) and `opencode session list`
- `src/serve.ts` — ensures background `opencode serve` is healthy (`/global/health`), starts it if needed
- `src/store.ts` — per-chat session/model/selection state + polling offset in `data/bot-state.json`
- `src/index.ts` — command routing, media handling, the opencode forward pipeline

Two opencode CLI quirks handled in code: the message positional must precede
`--file` flags (yargs array greediness), and in `--attach` mode `-f` content is
dropped — so the absolute file path is always embedded in the prompt text.

## ⚠️ Security

With `OPENCODE_AUTO_APPROVE=true` and no `TELEGRAM_ALLOWED_USERS`, **anyone who
finds the bot gets full shell access to the machine**. Always set
`TELEGRAM_ALLOWED_USERS` to your own numeric user ID in any non-throwaway setup.
