---
name: memory-keeper
description: Maintain MEMORY.md and daily notes. Applies to every task — record durable facts, never let context evaporate.
---

# Memory keeping

Memory lives in `MEMORY_DIR` (from your system prompt):
`MEMORY.md` (durable facts) + `memory/YYYY-MM-DD.md` (daily working notes).

## Rules

- **During work**: record decisions, preferences revealed, credentials LOCATIONS (never values), repo/app URLs + ports + PIDs, what's pending.
- **"Remember …"**: write it to the right file IMMEDIATELY, confirm briefly.
- **Keep MEMORY.md compact** (<~4KB): one bullet per fact, dated `[YYYY-MM-DD]`. Move detail (logs, transcripts) to daily notes; distill only durable conclusions upward.
- **Supersede, don't contradict**: when a preference changes, edit the old bullet in place.
- **Start of task**: re-read MEMORY.md + today's/yesterday's notes (already injected for new sessions — for ongoing ones, read the files).
- Never store secret VALUES (tokens, passwords). Locations and usernames are fine.
