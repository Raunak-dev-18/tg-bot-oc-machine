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
2. (Recommended) Get your numeric ID from **@userinfobot**, or just use your
   `@username` — both work in the allowlist.
3. Configure `.env` (minimum):

```bash
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USERS=@your_username
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
- `search YouTube for X and list the top 5`
- `create a 5-slide presentation on our roadmap and send it`
- `make a spreadsheet tracking expenses with totals and send it`
- `remember that I prefer nemotron for coding`

**Reply to quote.** Swipe-reply to any older message — the bot's or your own — and the
agent sees exactly what you mean (`[The operator replied to YOUR earlier message: "…"]`
is prepended to your prompt, capped at 1000 chars, works for photos/files too). "Change
this one" finally understands what "this" is.

### Voice-to-voice (Sarvam AI, multilingual)

Requires `SARVAM_API_KEY` where the bot runs (dashboard.sarvam.ai). Then:

1. You send a voice note (any of 22 Indic languages + English, Hinglish included).
2. Sarvam transcribes with auto language detect; the transcript + language go to the agent.
3. The agent replies in chat (full pipeline: buttons, files, memory) **and** speaks a short
   version back as a voice note in the same language (opus → Telegram voice, mp3 fallback).
4. Spoken replies stay under ~600 chars by instruction; longer answers chunk to ≤2 notes.

- `/voice hi` forces Hindi always, `/voice en` English, `/voice auto` follows each note,
  `/voice off` keeps text-only (still transcribes). `/say <text>` speaks anything.
- TTS: `bulbul:v4-flash` default speaker (override via `SARVAM_TTS_MODEL` / `SARVAM_VOICE`;
  note `bulbul:v2` is deprecated, opus needs 24 kHz which the bot sets automatically),
  STT: `saaras:v4` with auto language detect,
  3500 chars/call, paced/naturalized for pronunciation.

Replies are chunked to Telegram's limits automatically and end with a
`— done in Xs · tokens …` footer. While it works you'll see the typing indicator
plus a live bubble: `⏳ Working…` with elapsed time and current activity, which turns
into a **streaming preview** — the answer text appears live (with a `▍` cursor) as the
agent produces it, edited at a flood-safe cadence. (Telegram has no true streaming API;
message edits are the standard approximation — and opencode emits answer text per
completed step, so long agentic runs stream part-by-part while short answers arrive whole.)
The bubble is deleted when the final chunked reply lands. Your message gets 👀 on pickup,
the agent's own emotional `REACT:` emoji (or 👍) when done, 👎 on failure.

**Agent questions → buttons.** When the agent is blocked on a decision it sends
`❓` messages with tappable inline buttons (up to 3 questions per reply, 6 options
each). Tap one — your answer flows back into the same session and work continues.
Free-text questions are asked as `❓ … (Reply with your answer in chat.)` — just reply.

**Reactions, both ways.** React to any bot reply (👍 ❤️ 👎 …) — the update reaches theagent with the original message attached: praise gets a brief thanks + a memory note,
criticism gets an apology and an offer to fix. The bot reacts back with **whatever the
agent feels**: every reply ends in a `REACT: <emoji>` line the agent chooses itself
(🔥 pride, 😅 relief, 🎉 celebration, 😔 apology…), attached to your message, plus
👀 while working and 👎 on failure. (Only Telegram-native reaction emoji work —
e.g. ✅/❌ are rejected by the API, and anything invalid is skipped silently.)

---

## 3. Commands

| Command | What it does |
|---|---|
| `/start`, `/help` | Welcome + this feature overview |
| `/stop` | Cancel the currently running task (kills the agent run, replies ⏹️) |

All 29 commands are registered via `setMyCommands` on every boot, so Telegram shows
the `/` autocomplete menu (note: `/voice-ans` is registered as `/voice_ans` — Telegram
command names forbid hyphens; both spellings work in chat).
| `/bg <task>` | Run in background — chat stays free, result delivered here (fresh session) |
| `/jobs` | List running tasks (they survive bot restarts and auto-resume) |
| `/status` | Bot uptime, workdir, server health, browser MCP, session, model, memory size, cron count |
| `/new`, `/reset` | Forget the conversation; next message starts a fresh session (with memory loaded) |
| `/free` | Numbered list of **free** models (`👁` = sees images, plus context sizes). Reply with the **number** to select |
| `/models [provider]` | Numbered list of models (optionally filtered by provider). Reply with the **number** |
| `/model <number\|provider/model>` | Switch model for this chat (applies from next message). Bare `/model` shows current |
| `/effort <minimal\|low\|medium\|high\|xhigh\|max>` | Reasoning effort for this chat (applies from next message). `/effort off` resets |
| `/effort` | Show current effort + available levels for your model |
| `/sessions` | Last 10 sessions by title (current marked). Reply with the **number** to jump |
| `/switch <number\|session-id>` | Continue a different session |
| `/memory` | Show long-term memory (`MEMORY.md`) |
| `/remember <fact>` | Save a fact to long-term memory (or just say “remember …”) |
| `/recall <keywords>` | Search recent session transcripts for context |
| `/skills` | List installed agent skills |
| `/parallel <t1> ;; <t2> [;; t3]` | Run up to 3 tasks concurrently in fresh sessions |
| `/shot <https-url> [note]` | Open a page in the agent browser, screenshot it straight to chat |
| `/send <absolute-path> [caption]` | Send any machine file to chat instantly, no AI round-trip |
| 🎤 voice note | Transcribed (auto language) → text reply + spoken reply |
| `/voice [hi\|en\|auto\|off]` | Voice reply language (default follows each note) |
| `/voice-ans <text>` | Full AI answer in text + voice, auto-matched to your text's language |
| `/say <text>` | Speak any text as a voice note |
| `/cron <every 30m\|every 2h\|daily 09:30> <task>` | Run a task on schedule, delivered to this chat |
| `/crons` | List scheduled tasks |
| `/uncron <number\|id>` | Delete a scheduled task |
| `/agent <name>` | Switch opencode agent (default `build`) |
| `/exec <shell command>` | Run shell directly, no AI (e.g. `/exec git pull && pnpm -r build`) |

**Number picking:** after `/free`, `/models` or `/sessions`, just send the number
(`2`) within ~3 minutes — no `/model` prefix needed.

### Skills, recall & parallel runs

- **Skills** (`skills/<name>/SKILL.md`, `name:` + `description:` frontmatter, agentskills.io
  style) are injected into every session; the agent reads the full guide when a task
  matches. Shipped: `presentations`, `spreadsheets`, `browser-mission`, `deploy-app`,
  `memory-keeper`. List with `/skills`; add your own and restart the bot.
- **Recall** — `/recall <keywords>` searches the 8 most recent session transcripts
  (via `opencode export`) and returns title + snippet hits. Your past work stays findable.
- **Parallel** — `/parallel <task 1> ;; <task 2> [;; <task 3>]` runs up to 3 tasks
  concurrently in fresh sessions (main session untouched), results labeled per task.

### Long-horizon tasks (no timeouts, background, survival)

- **Timeout chaining** — a step that hits `OPENCODE_TIMEOUT_MS` (default 10 min) no longer
  errors. The bot re-attaches to the same session and says "continue where you left off",
  up to `OPENCODE_MAX_CHUNKS` (default 4 ≈ 40 min/task). Partials stream into the bubble;
  the footer reports `(3 parts)` when chained. Exhausted chunks deliver everything made so far.
- **Empty-reply retry** — free models occasionally return zero text; the bot retries once in
  the same session automatically, and only errors if both come back empty. Voice notes never
  speak placeholders.
- **Background** — `/bg <task>` runs with chat free (fresh session, same memory/skills).
  Max 3 per chat. Result lands here when done; `/stop` cancels.
- **Restart-proof** — every started run is journaled (`/jobs` lists them). If the bot
  restarts mid-task, it auto-resumes each one with a `🔄 Resuming…` note on boot.

**Effort levels:** reasoning effort (`minimal → low → medium → high → xhigh → max`)
trades speed for thinking depth. Available levels depend on the model — e.g.
`muse-spark` offers up to `xhigh`, `space-bunny` up to `max`, while `nemotron`
models have none. `/effort` shows exactly what your current model supports, and
rejects levels it doesn't have. Higher effort = slower, more thorough answers.

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
3. **Direct** — `/send <absolute-path> [caption]` sends any machine file yourself.

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
| `TELEGRAM_ALLOWED_USERS` | empty (= open!) | Numeric IDs and/or `@usernames` allowed (IDs from @userinfobot) |
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
| `HEALTH_PORT` | `5001` | HTTP health endpoint (`/` and `/healthz`, `0` = disabled; Replit injects `PORT`) |

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
  effort variants, 6 h cache), `opencode session list`, and `opencode export` for
  `/recall` cross-session search.
- `src/serve.ts` — keeps background `opencode serve` healthy (`/global/health`).
- `src/botconfig.ts` — generates the isolated opencode home with the Playwright MCP.
- `src/store.ts` — per-chat session/model/selections + polling offset + cron jobs
  (`data/bot-state.json`, atomic writes).
- `src/memory.ts` — `MEMORY.md` + daily notes load/append with injection budgets.
- `src/cron.ts` — `every Nm|Nh` / `daily HH:MM` spec parsing and next-run math.
- `src/index.ts` — polling loop, command routing, media pipeline, outbox/SEND delivery,
  bare-number selection, 20 s cron tick, `/parallel` fan-out.

`npm run typecheck` → `tsc`, `npm run build` → esbuild bundle to `dist/index.mjs`.

## 10. Troubleshooting

- **Bot exits `Missing TELEGRAM_BOT_TOKEN`** — export it or put it in `.env`.
- **Replies say opencode failed** — check the bot logs; verify `opencode` works manually
  (`opencode run "hi"`). If the background server died, your next message restarts it
  automatically (self-heal); check `/status` for server health.
- **Browser tools missing** (`/status` shows unavailable) — need `@playwright/mcp`
  installed and a working `CHROMIUM_PATH`; restart the bot after installing.
- **Images not understood** — switch to a 👁 model from `/free`.
- **Duplicate replies** — two bot instances polling with the same token; kill one
  (only one `getUpdates` consumer is allowed).
- **Cron not firing** — bot must stay running (jobs live in its process); check `/crons`
  and `/status`.

### Staying up 24/7

A Replit workspace sleeps when idle — nothing inside it can prevent that. Your options:

0. **Free: keep the workspace tab open + supervisor.** An open tab keeps Replit's
   machine awake; `run.sh` (included) restarts the bot on any crash with backoff:
   `setsid ./run.sh >>bot.log 2>&1 < /dev/null &`. Secrets come from env or a
   gitignored `.env` (see `.env.example`) — never hardcoded. Stop cleanly with
   `touch STOP`. I proved this by `kill -9`ing the bot: it rebooted itself in seconds.
1. **Cheapest reliable: a small VPS** (~$5/mo, Hetzner/Contabo/DigitalOcean). Clone this
   repo there and follow [AGENTS.md](./AGENTS.md) §3–§4 (systemd unit included). This is
   the recommended path for a bot that must never sleep.
2. **Replit Reserved VM deployment** — always-on, billed for reserved capacity. Deploy
   this repo with run command `npm start` and the env vars from `.env.example`; the
   `/healthz` endpoint satisfies deployment health checks.
3. **Autoscale + uptime pinger (fragile)** — expose `/healthz` publicly and have an
   external pinger (e.g. UptimeRobot, 5-min interval) hit it. Works until it doesn't;
   cold starts still drop messages mid-sleep.

In all cases, keep a single instance per token (duplicates cause double replies).
