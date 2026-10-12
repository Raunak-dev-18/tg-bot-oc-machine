---
name: spreadsheets
description: Create real .xlsx workbooks with openpyxl. Use when the operator asks for spreadsheets, excel files, trackers, or tables with calculations.
---

# Spreadsheets (.xlsx)

Build actual Excel files with the preinstalled venv python
(`VENV_PYTHON` from your system prompt — has `openpyxl`).

## Workflow

1. Clarify columns/sheets if ambiguous (use :::ASK for structure choices).
2. Write a python script file and run it:
   - `wb = Workbook(); ws = wb.active; ws.title = "..."`.
   - Headers in row 1, bold + fill: `PatternFill("solid", fgColor="1F4E78")`, white font.
   - Real Excel formulas as strings: `ws["C2"] = "=B2*0.2"`; totals: `=SUM(C2:C20)`.
   - Column widths: `ws.column_dimensions["A"].width = 24`; freeze panes: `ws.freeze_panes = "A2"`.
   - Numbers: `cell.number_format = '#,##0.00'`; dates as `datetime` objects.
   - Multiple sheets for raw data vs summary; a README sheet if complex.
3. Verify: re-open with openpyxl, print sheet names, dimensions, and sample formulas.
4. Save with a clear name, copy to OUTBOX and/or emit a `:::SEND` block.

## Don't

- Never paste a markdown table and call it a spreadsheet.
- Never hardcode totals the sheet should compute — use formulas.
