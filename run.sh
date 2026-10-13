#!/usr/bin/env bash
# Supervisor for tg-control-bot (free-tier friendly).
# Restarts the bot if it ever exits. Secrets are NEVER stored here —
# export them or put them in .env (gitignored, see .env.example).
#
#   Start:  setsid ./run.sh >>bot.log 2>&1 < /dev/null &
#   Stop:   touch STOP   (supervisor exits after the bot stops; then rm STOP)
set -u
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN env var or create a .env file (see .env.example)}"
: "${WORK_DIR:=$(pwd)/../..}"
: "${DATA_DIR:=$(pwd)/data}"
: "${OPENCODE_AUTO_APPROVE:=true}"
: "${OPENCODE_AUTO_SERVE:=true}"
export TELEGRAM_BOT_TOKEN WORK_DIR DATA_DIR OPENCODE_AUTO_APPROVE OPENCODE_AUTO_SERVE
export TELEGRAM_ALLOWED_USERS OPENCODE_MODEL OPENCODE_AGENT OPENCODE_TIMEOUT_MS \
  OPENCODE_SERVE_PORT OPENCODE_SERVER_URL OPENCODE_CONFIG_HOME OUTBOX_DIR \
  CHROMIUM_PATH TELEGRAM_POLL_TIMEOUT HEALTH_PORT OPENCODE_BIN 2>/dev/null || true

node ./build.mjs || { echo "[supervisor] build failed, fix errors and rerun"; exit 1; }

backoff=5
while true; do
  if [ -f STOP ]; then
    echo "[supervisor] STOP file present, exiting (rm STOP to allow restarts)"
    exit 0
  fi
  echo "[supervisor] starting bot…"
  node --enable-source-maps ./dist/index.mjs
  code=$?
  echo "[supervisor] bot exited (code $code), restarting in ${backoff}s…"
  sleep "$backoff"
  backoff=$(( backoff < 60 ? backoff + 5 : 60 ))
done
