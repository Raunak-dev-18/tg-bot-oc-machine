# Usage Guide — tg-control-bot 🤖

Remote-control a machine from Telegram with [opencode](https://opencode.ai) as the AI brain.
Every message you send is executed by an autonomous agent on the machine; replies,
files, screenshots and buttons come back into the same chat.

---

## 1. Setup

**Prerequisites:** Node.js 18+, the `opencode` CLI installed and authenticated,
a headless Chromium for browser automation (optional but recommended).

```bash
git clone https://github.com/Raunak-dev-18/tg-bot-oc-machine.git
cd tg-bot-oc-machine
npm install
cp .env.example .env   # then edit .env
```

1. Talk to **@BotFather** on Telegram → `/newbot` → copy the token.
2. (Recommended) Talk to **@userinfobot** → copy your numeric user ID.
3. Configure `.env` (minimum):

```bash
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USERS=<your numeric id>
WORK_DIR=/path/where/the-agent/works
```

4. Run:

```bash
npm run dev      # build + start (foreground, logs to stdout)
# or
npm run build && npm start
```

On boot the bot logs in (`logged in as @…`), ensures a background
`opencode serve` is healthy on `OPENCODE_SERVE_PORT` (default 4096), writes its
isolated opencode config (browser MCP) and starts polling Telegram.

> ⚠️ **Security.** With `OPENCODE_AUTO_APPROVE=true` (default) and an empty
> `TELEGRAM_ALLOWED_USERS`, **anyone who finds the bot gets full shell access
> to the machine**. Always set `TELEGRAM_ALLOWED_USERS` outside throwaway setups.

---

## 2. Talking to the agent

Just send messages. Examples:

- `clone https://github.com/user/repo and run it`
- `deploy the api-server and show me the logs`
- `why is port 5000 not responding? fix it`
- `go to example.com, log in, and screenshot the dashboard`
- `remember that I prefer nemotron for coding`

Replies are chunked to Telegram's limits automatically and end with a
`— done in Xs · tokens …` footer. While it works you'll see the typing indicator.

**Agent questions → buttons.** When the agent is blocked on a decision it sends
`❓` messages with tappable inline buttons (up to 3 questions per reply, 6 options
each). Tap one — your answer flows back into the same session and work continues.
Free-text questions are asked as `❓ … (Reply with your answer in chat.)` — just reply.

---

## 3. Commands

| Command | What it does |
|---|---|
| `/start`, `/help` | Welcome + this feature overview |
| `/status` | Bot uptime, workdir, server health, browser MCP, session, model, memory size, cron count |
| `/new`, `/reset` | Forget the conversation; next message starts a fresh session (with memory loaded) |
| `/free` | Numbered list of **free** models (`👁` = sees images, plus context sizes). Reply with the **number** to select |
| `/models [provider]` | Numbered list of models (optionally filtered by provider). Reply with the **number** |
| `/model <number\|provider/model>` | Switch model for this chat (applies from next message). Bare `/model` shows current |
| `/sessions` | Numbered list of recent opencode runs (current marked). Reply with the **number** to jump |
| `/switch <number\|session-id>` | Continue a different session |
| `/memory` | Show long-term memory (`MEMORY.md`) |
| `/remember <fact>` | Save a fact to long-term memory (or just say “remember …”) |
| `/shot <https-url> [note]` | Open a page in the agent browser, screenshot it straight to chat |
| `/cron <every 30m\|every 2h\|daily 09:30> <task>` | Run a task on schedule, delivered to this chat |
| `/crons` | List scheduled tasks |
| `/uncron <number\|id>` | Delete a scheduled task |
| `/agent <name>` | Switch opencode agent (default `build`) |
| `/exec <shell command>` | Run shell directly, no AI (e.g. `/exec git pull && pnpm -r build`) |

**Number picking:** after `/free`, `/models` or `/sessions`, just send the number
(`2`) within ~3 minutes — no `/model` prefix needed.

---

## 4. Media: in and out

**You → agent.** Send 📷 photos or 📎 files (≤20 MB, Telegram Bot API limit) with an
optional caption. They're saved to `data/inbox/` and the agent reads them with its
file tools. Vision-capable models (👁 in `/free`) can actually *see* images — if your
current model can't, the bot warns you after replying.

**Agent → you.** Two paths, both automatic:

1. **Outbox** — anything the agent saves to `data/outbox/` (screenshots, reports,
   downloads, generated files) is delivered after its reply (images as photos, rest as
   documents; max 5 files, 20 MB each).
2. **Explicit sends** — the agent emits `:::SEND` blocks for specific files:
   `/absolute/path.png | optional caption` → photo/document message.

---

## 5. Memory (OpenClaw-style, Hermes-inspired)

Stored in `data/memory/`:

- **`MEMORY.md`** — curated long-term facts: preferences, project decisions, recurring
  tasks. Compact by design (4 KB injected into fresh sessions).
- **`memory/YYYY-MM-DD.md`** — daily working notes and session context (today + yesterday
  injected, 2 KB each).

The agent reads them at the start of tasks and **updates them itself** — recording
decisions, preferences, progress. Tell it `remember that deploys go to port 5000` and
it's filed. Manage manually with `/memory` and `/remember`.

---

## 6. Scheduled tasks (cron)

```text
/cron every 30m check my site is up and report status
/cron every 2h git pull && pnpm -r build, report failures
/cron daily 09:30 send me disk usage and top processes
```

- Times are **server-local**. Max 10 jobs per chat.
- Jobs run through the full agent pipeline (memory, browser, buttons, outbox delivery).
- If you're mid-conversation when a job fires, it's deferred to the next tick.
- A job is auto-deleted after 5 consecutive failures.

---

## 7. Browser automation

The agent drives headless Chromium through Playwright MCP
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`screenshot`, `wait_for`…) — for JS sites, logins, and visual verification, like a
human would. Discipline is built into its instructions: snapshot-first, wait after
navigation, screenshot-verify before claiming success.

Requirements: `@playwright/mcp` (installed via `npm install`) and a Chromium binary
(`CHROMIUM_PATH`, default `/repl/tools/bin/chromium`). The bot writes this MCP setup
into an **isolated** opencode config (`OPENCODE_CONFIG_HOME`, default
`data/.opencode-home/`) so your own opencode setup is never touched. MCP debug files
land in `data/mcp-out/`.

No live desktop exists on a typical server (`DISPLAY` is dead), so OS-level
mouse/keyboard control of GUI apps is out of scope — browser + shell cover it.

---

## 8. Configuration reference

| Var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | empty (= open!) | Numeric user IDs allowed (from @userinfobot) |
| `WORK_DIR` | repo root's parent's parent | Directory the agent operates in |
| `DATA_DIR` | `./data` | Sessions, memory, inbox/outbox, model cache |
| `OUTBOX_DIR` | `$DATA_DIR/outbox` | Agent-to-you file delivery |
| `OPENCODE_BIN` | `opencode` | opencode binary |
| `OPENCODE_CONFIG_HOME` | `$DATA_DIR/.opencode-home` | Isolated opencode config (MCP) |
| `CHROMIUM_PATH` | `/repl/tools/bin/chromium` | Browser for the agent |
| `OPENCODE_MODEL` | opencode default | e.g. `opencode/exo-free` |
| `OPENCODE_AGENT` | `build` | opencode agent |
| `OPENCODE_AUTO_APPROVE` | `true` | `--auto`: act without confirmation |
| `OPENCODE_TIMEOUT_MS` | `600000` | Per-message timeout |
| `OPENCODE_AUTO_SERVE` | `true` | Auto-manage background `opencode serve` |
| `OPENCODE_SERVE_PORT` | `4096` | Serve port |
| `OPENCODE_SERVER_URL` | auto | Use an externally managed server instead |
| `TELEGRAM_POLL_TIMEOUT` | `50` | Long-poll seconds |

---

## 9. How it works (for developers)

- `src/telegram.ts` — zero-dep Bot API client: long polling, chunked sends, inline
  keyboards, `getFile` downloads, multipart photo/document uploads.
- `src/opencode.ts` — spawns `opencode run --format json`, parses JSONL events into
  reply text, tracks session/tokens/cost. Message positional precedes `--file` flags
  (yargs array greediness); absolute file paths are embedded in prompts because `-f`
  content is dropped in `--attach` mode.
- `src/interact.ts` — `:::ASK` (questions → buttons) and `:::SEND` (explicit media)
  block parsers + pending-answer registry for button taps.
- `src/models.ts` — parses `opencode models --verbose` (free = zero cost, vision flags,
  6 h cache) and `opencode session list`.
- `src/serve.ts` — keeps background `opencode serve` healthy (`/global/health`).
- `src/botconfig.ts` — generates the isolated opencode home with the Playwright MCP.
- `src/store.ts` — per-chat session/model/selections + polling offset + cron jobs
  (`data/bot-state.json`, atomic writes).
- `src/memory.ts` — `MEMORY.md` + daily notes load/append with injection budgets.
- `src/cron.ts` — `every Nm|Nh` / `daily HH:MM` spec parsing and next-run math.
- `src/index.ts` — polling loop, command routing, media pipeline, outbox/SEND delivery,
  bare-number selection, 20 s cron tick.

`npm run typecheck` → `tsc`, `npm run build` → esbuild bundle to `dist/index.mjs`.

## 10. Troubleshooting

- **Bot exits `Missing TELEGRAM_BOT_TOKEN`** — export it or put it in `.env`.
- **Replies say opencode failed** — check the bot logs; verify `opencode` works manually
  (`opencode run "hi"`), and that the serve port is free.
- **Browser tools missing** (`/status` shows unavailable) — need `@playwright/mcp`
  installed and a working `CHROMIUM_PATH`; restart the bot after installing.
- **Images not understood** — switch to a 👁 model from `/free`.
- **Duplicate replies** — two bot instances polling with the same token; kill one
  (only one `getUpdates` consumer is allowed).
- **Cron not firing** — bot must stay running (jobs live in its process); check `/crons`
  and `/status`.
