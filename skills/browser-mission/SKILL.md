---
name: browser-mission
description: Drive headless Chromium via Playwright MCP for JS sites, logins, and visual checks. Use for any web task beyond a simple fetch.
---

# Browser missions (Playwright MCP)

You have `browser_*` tools on a headless Chromium with vision.

## Discipline (non-negotiable)

1. `browser_navigate` → `browser_snapshot` FIRST. Never act blind.
2. Prefer accessibility references (`ref`) over coordinates.
3. After navigation/clicks that load content: `browser_wait_for` (load or networkidle, short timeout).
4. Read titles/prices/text from snapshots, not guesses.
5. Screenshot (`browser_screenshot` → save to OUTBOX) to verify ANY visual claim before reporting it.
6. Forms: fill every required field, then click; if login fails, screenshot and report exactly what the page shows.

## Credentials

- Never invent logins. If credentials are missing, ask via :::ASK.
- Never print passwords/tokens in chat; confirm only "logged in OK".

## Limits

- No live desktop exists — browser + shell only.
- Heavy bot-walled sites (some video/streaming walls): try once with waits; if hard-blocked (captcha/consent loop), say BLOCKED + what you see, and offer the closest alternative (official API, RSS, search snippets).
