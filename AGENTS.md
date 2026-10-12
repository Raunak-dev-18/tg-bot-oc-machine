# AGENTS.md — tg-control-bot 🤖

> Instructions for setting up and operating **tg-control-bot**: a Telegram bot that
> remote-controls a machine with [opencode](https://opencode.ai) as its AI brain.
> Written for humans and AI assistants alike — follow it top to bottom.

---

## 1. What this is

- Every Telegram message is forwarded to `opencode run` in `WORK_DIR`; the agent's
  reply comes back to chat. The agent acts with `--auto`: shell, files, git,
  deploys, headless-Chromium browsing (Playwright MCP), pptx/xlsx generation.
- Per-chat opencode sessions (memory across messages), `MEMORY.md` long-term memory,
  cron tasks, skills, media in/out, model/effort switching, parallel runs.
- Zero runtime dependencies (plus `@playwright/mcp` for the browser). TypeScript,
  bundled with esbuild to `dist/index.mjs`.

## 2. Prerequisites (target machine)

1. **Node.js 18+** (`node --version`).
2. **opencode CLI** installed and authenticated (`opencode run "hi"` must answer).
   Any provider works; free `opencode/*` models work out of the box.
3. **Chromium** for browser automation (optional but recommended). Set `CHROMIUM_PATH`
   if yours isn't at `/repl/tools/bin/chromium`. Verify:
   `chromium --headless --screenshot=/tmp/t.png --window-size=1280,800 https://example.com`
4. **Telegram bot token** from **@BotFather** (`/newbot`). Restrict access with your
   numeric ID from **@userinfobot** (or your `@username`).
5. Outbound HTTPS to `api.telegram.org`.

## 3. Setup (5 minutes)

```bash
git clone https://github.com/Raunak-dev-18/tg-bot-oc-machine.git
cd tg-bot-oc-machine
npm install          # or: pnpm install / yarn
cp .env.example .env # then edit .env
```

Minimum `.env`:

```bash
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USERS=@your_username   # or numeric id; empty = OPEN TO ANYONE
WORK_DIR=/path/where/the-agent/works
```

> ⚠️ Never commit `.env` (it's gitignored). Never share tokens in chat screenshots.

Start it:

```bash
npm run dev    # build + run in foreground (logs to stdout)
# or: npm run build && npm start
```

Expected boot log order: `skills:` → `opencode config home:` → `whitelist:` →
`logged in as @…` → `opencode server healthy` → `polling for updates…`.
Then send `/start` to your bot on Telegram.

## 4. Keep it running

Pick one:

```bash
# tmux (simplest)
tmux new -s tgbot 'TELEGRAM_BOT_TOKEN=… WORK_DIR=… npm run dev'

# nohup
TELEGRAM_BOT_TOKEN=… WORK_DIR=… DATA_DIR=./data nohup npm start >/var/log/tgbot.log 2>&1 &

# systemd — /etc/systemd/system/tgbot.service
[Unit]
Description=tg-control-bot
After=network-online.target
[Service]
WorkingDirectory=/opt/tg-bot-oc-machine
Environment=TELEGRAM_BOT_TOKEN=…
Environment=TELEGRAM_ALLOWED_USERS=@you
Environment=WORK_DIR=/opt/work
Restart=always
ExecStart=/usr/bin/npm start
[Install]
WantedBy=multi-user.target
```

Notes:

- The bot auto-manages background `opencode serve` (`OPENCODE_AUTO_SERVE=true`,
  port `OPENCODE_SERVE_PORT`, default 4096) and **self-heals**: if the server dies,
  your next message restarts it. Only one bot instance per token (Telegram allows a
  single `getUpdates` consumer — duplicates cause double replies).
- State lives in `DATA_DIR` (default `./data`): `bot-state.json` (sessions, crons),
  `memory/` (MEMORY.md + daily notes), `inbox/`/`outbox/` (media),
  `.opencode-home/` (isolated opencode config with the browser MCP). Back up `data/`
  if sessions/memory matter to you.

## 5. Configure

| Var | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | From @BotFather |
| `TELEGRAM_ALLOWED_USERS` | empty (= open!) | IDs and/or `@usernames`, comma/space separated |
| `WORK_DIR` | package root's parent's parent | The agent's machine scope — point it at your project |
| `DATA_DIR` | `./data` | All runtime state (see §4) |
| `OUTBOX_DIR` | `$DATA_DIR/outbox` | Files the agent saves for you → auto-delivered |
| `OPENCODE_MODEL` | opencode default | e.g. `opencode/exo-free` (per-chat `/model` overrides) |
| `OPENCODE_AGENT` | `build` | Per-chat `/agent` overrides |
| `OPENCODE_AUTO_APPROVE` | `true` | `--auto`. `false` = safer, but headless runs may stall |
| `OPENCODE_TIMEOUT_MS` | `600000` | Per-message cap |
| `OPENCODE_AUTO_SERVE` / `OPENCODE_SERVE_PORT` | `true` / `4096` | Background server management |
| `OPENCODE_SERVER_URL` | auto | Use an externally managed server instead |
| `CHROMIUM_PATH` | `/repl/tools/bin/chromium` | Headless browser binary |
| `SKILLS_DIR` | auto-detected `./skills` | Drop-in `SKILL.md` guides |
| `TELEGRAM_POLL_TIMEOUT` | `50` | Long-poll seconds |

## 6. Operate (what to tell the user)

Core loop: **just talk** (`clone X and run it`, `screenshot example.com`, `make me a
spreadsheet…`). Key commands: `/status` (health), `/new` (fresh session),
`/free` → reply number (models), `/effort high` (reasoning depth), `/sessions` →
reply number, `/memory` + `/remember`, `/shot <url>`, `/send <path>`,
`/cron every 30m …` + `/crons` + `/uncron`, `/recall`, `/parallel a ;; b`,
`/exec` (raw shell), `/stop` (cancel). Full reference: [usage.md](./usage.md).

- Vision needs a 👁 model from `/free`; the bot warns when the current one can't see.
- Media ≤20 MB each way (Telegram limit). Outbox auto-sends (max 5/run).
- Skills: add `skills/<name>/SKILL.md` (`name:` + `description:` frontmatter) and restart.
- Cron times are server-local; max 10/chat; jobs need the bot process alive.

## 7. Troubleshoot

| Symptom | Fix |
|---|---|
| `Missing TELEGRAM_BOT_TOKEN` at boot | Export it or fill `.env` |
| `⛔ Unauthorized` for yourself | `TELEGRAM_ALLOWED_USERS` must contain your exact ID or `@username` |
| Replies say opencode failed | Run `opencode run "hi"` manually; check port free; `/status` for server health |
| Browser tools missing (`/status`) | `npm install` (needs `@playwright/mcp`) + valid `CHROMIUM_PATH`, then restart |
| Images not understood | Switch to a 👁 model via `/free` |
| Double replies | Kill the duplicate bot process (one consumer per token) |
| Cron never fires | Bot process must stay up; check `/crons` + `/status` |
| `REACTION_INVALID` in logs | Normal — only Telegram-native emoji are accepted as reactions |

## 8. Develop

```bash
npm run typecheck  # tsc --noEmit
npm run build      # esbuild → dist/index.mjs
```

- `src/` modules: `telegram.ts` (Bot API), `opencode.ts` (`run --format json` bridge),
  `interact.ts` (`:::ASK`/`:::SEND`/`REACT:` protocols), `models.ts` (models/sessions/recall),
  `serve.ts` + `botconfig.ts` (background server + isolated MCP config), `store.ts`,
  `memory.ts`, `cron.ts`, `skills.ts`, `index.ts` (loop + routing).
- Gotchas baked in: message positional must precede `--file` flags; `-f` content is
  dropped in `--attach` mode (absolute paths go in prompt text); `✅`/`❌` are invalid
  Telegram reactions; detached `serve` processes may be reaped — the bot self-heals.
- PRs welcome: keep zero runtime deps (except `@playwright/mcp`), update `usage.md`
  for user-facing changes.
