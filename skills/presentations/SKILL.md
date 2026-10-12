---
name: presentations
description: Create real .pptx slide decks with python-pptx. Use when the operator asks for slides, decks, or presentations.
---

# Presentations (.pptx)

Build actual PowerPoint files with the preinstalled venv python
(`VENV_PYTHON` from your system prompt — has `python-pptx` + `pillow`).

## Workflow

1. Plan the deck: title slide + one idea per slide (5-8 slides unless told otherwise).
2. Write a python script (heredoc to a file, then run it — easier to fix than `-c`):
   - `prs = Presentation()` (default 16:9? default is 4:3 — use `prs.slide_width/height` or blank layouts deliberately).
   - Title slide: `slide_layouts[0]`; content: `slide_layouts[1]` (title + bullets) or `[5]` (title only) / `[6]` (blank) for custom.
   - Bullets: `tf = shape.text_frame; tf.text = "first"; p = tf.add_paragraph(); p.text = "…"; p.level = 1`.
   - Tables: `shapes.add_table(rows, cols, x, y, w, h)` — set `cell.text`, bold header row.
   - Images/charts: generate with `pillow`/`matplotlib`? (matplotlib NOT installed — draw with pillow or skip), `shapes.add_picture(path, x, y, w, h)`.
   - Keep fonts large (title ≥32pt, body ≥18pt), high contrast, no tiny text.
3. Verify: re-open with python-pptx and print slide count + titles; render-check by converting? (no libreoffice — verify structurally: every slide has a title, no empty placeholders).
4. Save under a clear name, copy to OUTBOX and/or emit a `:::SEND` block.

## Don't

- Never deliver a text outline and call it a presentation.
- Never invent images — generate placeholders with pillow (colored box + label) if needed.
