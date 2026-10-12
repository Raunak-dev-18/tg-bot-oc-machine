---
name: deploy-app
description: Clone, build, run and verify apps end-to-end. Use when the operator says deploy, run, host, or start an app/service.
---

# Deploying apps

## Checklist

1. **Inspect**: repo layout, README, package manager (pnpm/npm/pip), required env vars, ports.
2. **Install**: `pnpm install` / `npm install` / `pip install -r requirements.txt` (never `--break-system-packages`; use a venv for python).
3. **Configure**: copy `.env.example` → `.env`, fill non-secret defaults; ask via :::ASK for secrets/choices.
4. **Run**: start in background (`nohup … &` or pm2-style), record PID/port/URL.
5. **Verify**: curl the health endpoint / load the page (screenshot for UIs); read logs on failure and fix iteratively.
6. **Report**: URL, port, PID, how to stop/restart, what remains (e.g. secrets to fill).

## Rules

- Prefer non-privileged ports (>1024). Never expose secrets in chat or files that get committed.
- If the app needs a database, say so explicitly and offer options instead of silently installing servers.
- Leave the app RUNNING unless told otherwise; note how to stop it.
