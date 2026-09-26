# Evaluation run 2 (2026-09-26): wiki-interest on Claude Haiku 4.5

Same setup as run 1 (`../FINDINGS.md`): `claude -p --model haiku`
(`claude-haiku-4-5-20251001`), skill installed at
`~/.claude/skills/wiki-interest`, clean working dir per session, tools
`Bash Skill Read`, follow-ups via `--resume`. Runner: `../run_eval.sh`.
Transcripts are raw `stream-json`. Transcripts and the 8 generated PDFs
(`pdfs/`) are kept locally, not committed; each PDF was verified as exactly 1 page (`pdfinfo`).

| Prefix | Skill version | Scenario |
|---|---|---|
| `01-`, `02-`, `03-` | as left by run 1 | baseline: Q1 (+PDF, +Slovak, +5 years), Q2 (+PDF), Q3 (+PDF) |
| `01b-`, `02b-`, `03b-` | fixes A–D | full retest |
| `01c-`, `02c-` | + fix E, F | Q1 follow-ups, Q2 |
| `01d-` | + fix G | Q1 + both follow-ups + PDF |

Wikidata sitelinks were checked directly: Q1666254 (intermittent fasting)
has no `plwiki`/`skwiki`; Q130192 (ESL) has only `dewiki`. The missing
articles are real, not a resolver bug.

## What went right in every session

- Correct command syntax, `resolve` → `analyze` order, `best_qid` used
  without asking when `needs_confirmation: false`.
- Follow-ups always used `--run <id>` with only the changed option; no
  re-resolve.
- Confidence was stated for the first answer in every session, and
  normalization and the "not willingness to pay" caveat were mentioned.
- No recommendation made on `low` confidence (ESL).

## Errors found in the baseline, and their fixes

1. **The model inferred things from missing articles, again.** (Q1 turns 1
   and 3, Q3.) Examples: "Poland's lack of a Wikipedia article suggests the
   topic is less mainstream… less saturation", "limited existing public
   knowledge infrastructure". The SKILL.md rule from run 1 did not hold.
   **Root cause was in the CLI:** the caveat said "excluded from the
   ranking", but `ranking` still contained `pl`, `summary` said "pl follows
   at 0 per million", and `confidence_reasons` invented a
   "trend p-value (1.00)". The tool itself presented "no article" as a
   measured zero.
   - **A (CLI):** languages without an article are excluded from `ranking`.
     `avg_monthly_views` and `share_per_million` are now `null` (not 0).
     The only reason given is "no Wikipedia article in this language, so
     nothing was measured". `summary` says explicitly that nothing was
     measured and that this says nothing about interest. The caveat adds
     "Do not infer anything about interest in <lang>".
   - **B (SKILL.md):** the rule now names the observed speculation phrases
     ("less mainstream", "less saturated", "early-entry opportunity").
2. **"Clearer pick" for a language that won by default.** (Q1 turn 3.)
   `cs` was the only language with data.
   - A also covers this: `summary` now says "cs is the only language with
     data… Its first place is not a win". SKILL.md adds "do not call it
     the clearer pick".
3. **Only the PDF file name was given, not `pdf_path`.** (All 3 sessions.)
   - **C (SKILL.md):** "Give the user the full `pdf_path` exactly as
     returned".
4. **An anomaly was called a "seasonal spike".** (Q1, April 2025.)
   - **D (SKILL.md):** anomalies are one-off spikes or dips, not
     seasonality.
5. **Noise on stderr in every tool result:** two lines of Node's SQLite
   `ExperimentalWarning` and a three-line User-Agent notice.
   - **CLI:** `scripts/lib/quiet-warnings.ts` filters only that warning.
     `node:sqlite` is now loaded via `process.getBuiltinModule` so the
     filter is installed first. The UA notice is now one line.

## Errors found in retests, and their fixes

6. **Anomalies were not mentioned.** (Q2 had 6 anomalies, including
   2024-09 with z=7.) `confidence_reasons` only listed shortcomings.
   - **E (CLI):** a reason is added when there are anomalies:
     "6 anomalous months found; trend direction holds without them". In
     `02c` the model relayed it.
7. **Wrong direction when comparing periods.** (`01b` turn 4.) The model
   wrote "the rate of decline has slowed more recently", but the recent
   24-month slope (−45.7%/yr) is steeper than the 5-year one (−30.9%/yr).
   A SKILL.md-only rule (**F**) did not stop the model from comparing the
   two runs itself (`01c`).
   - **G (CLI):** when `--run` changes the period, `summary` ends with a
     deterministic "Compared with the previous run…" sentence that says
     which window is steeper. SKILL.md tells the model to relay it. In
     `01d` the direction was correct.

## Still imperfect after the fixes (minor, not fixed)

- Some light causal speculation remains. `01d` said "dips at the
  article's launch in late 2021" and "may align with New Year's
  resolutions". `02c` said "educational calendars may drive interest".
  None of it changed a number or a recommendation.
- `01d` turn 3 (the 5-year follow-up) did not restate the confidence
  level.
- `01d` turn 2 asked about the PDF again on a follow-up, despite the
  SKILL.md rule.

## Changes made

- CLI: `scripts/lib/analyze.ts`, `schemas.ts` (nullable views/share),
  `report.ts` (renders `—`), `cache.ts`, `fetch.ts`, new
  `quiet-warnings.ts`, entry-point import.
- Skill text: `SKILL.md` (interpretation and follow-up rules),
  `references/EXAMPLES.md` (example output updated to the new format).
- Tests: new assertions for no-article handling, plus a `comparePeriods`
  test. `npm test` passes 59/59, `tsc --noEmit` is clean,
  `skills-ref validate` passes.
