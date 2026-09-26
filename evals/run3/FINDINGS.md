# Evaluation run 3 (2026-09-26): wiki-interest on Claude Haiku 4.5

Retest after the seasonal adjustment, `--rank-by`, chart and
`references/EXAMPLES.md` changes. Same setup as run 2 (`../run2/FINDINGS.md`):
`claude -p --model haiku`, skill synced to `~/.claude/skills/wiki-interest`,
clean working dir per session, tools `Bash Skill Read`, follow-ups via
`--resume`, runner `../run_eval.sh`. This time the prompts are the three
examples from the task, verbatim in Ukrainian; for Q3 the "selected
languages" were set to pl, cs, uk, de, fr. The three sessions ran **in
parallel**. Transcripts and PDFs are kept locally, not committed.

| Prefix | Scenario |
|---|---|
| `01-` | Q1 intermittent fasting pl/cs → + Slovak → 5 years → PDF |
| `02-`, `02b-` | Q2 astronomy in uk (baseline, retest) |
| `03-`, `03b-` | Q3 learning English in 5 languages + short report; turn 2 picks Q7691272 after disambiguation (baseline, retest) |

Cost: $0.04–0.09 per turn, 2–6 tool-loop turns each.

## What went right

- Correct `resolve` → `analyze` order and syntax in every session.
- **New `--rank-by growth` was picked up unprompted** when the question was
  about growth ("Порівняй зростання…", "Чи зростає…").
- Follow-ups used `--run <id>` with only the changed option.
- The "Compared with the previous run" sentence was relayed with the
  correct direction (5-year slope less steep than 2-year).
- Missing articles (pl, sk, cs/uk/fr) were reported as "no data / nothing
  measured, not no interest" in Q1.
- **`needs_confirmation` was exercised for the first time** (Q3, "English
  language"): the model stopped, showed the candidates and asked.
- No market recommendation on `low` confidence (Q3).
- Seasonal adjustment was relayed in Q2b ("strong seasonality peaking in
  September, accounted for in the trend").
- Every generated PDF is exactly one page.

## Errors found, and their fixes

1. **`database is locked` when sessions run in parallel.** (Q2.) The SQLite
   cache is shared by every session on the machine; the second writer
   failed immediately. The model then retried despite the hint saying not
   to, which happened to work.
   - **Fix (CLI):** `busy_timeout = 10000` and WAL journal mode in
     `scripts/lib/cache.ts`. New test spawns 4 processes writing to one
     cache file at once; it fails with "database is locked" without the
     fix. Q2b/Q3b then ran in parallel with no errors.
2. **Report not generated although the first message asked for it.** (Q3:
   "підготуй короткий звіт".) The disambiguation turn in between made the
   model lose the request.
   - **Fix (SKILL.md):** the report step now says to run `report` whenever
     a report/PDF/"звіт" was requested anywhere in the conversation, even
     after a clarifying question and even at `low` confidence. Q3b produced
     the PDF without asking.
3. **Caveats cut off in the PDF.** (Q3b.) The assumptions block had a fixed
   height, so with 5 languages the `uk`/`fr` "no article" caveats were
   replaced by "…" while half the page was empty.
   - **Fix (CLI):** `scripts/lib/report.ts` gives the block all the space
     down to the source line. Regenerated report: all caveats present, still
     1 page.

## Still imperfect (not fixed)

- **Speculation about unmeasured markets.** Asked "which audiences to
  research next and why", Q3b said cs/uk "are potentially strong audiences"
  and that "the need for English is high" in uk/cs — claims the data does
  not support, and it used "попит" (demand). The SKILL.md rule against this
  held in Q1 but not under a question that directly asks for a
  recommendation. Likely fix: a deterministic `next_steps` block in the
  `analyze` output (see README, Further development → report
  recommendations), so the model relays data-backed next steps instead of
  inventing them.
- **Causal explanation of a period comparison.** Q1 turn 3 added "may
  indicate stabilization" after relaying the comparison sentence, and did
  not restate confidence. Same as run 2.
- **Full `pdf_path` not always given.** Q1 gave it; Q3b said "saved in the
  project folder".
- **Ukrainian language quality.** Haiku's Ukrainian had typos, Russian and
  even CJK characters ("мовних版иях"), and one self-contradicting sentence
  in Q2 ("не зростає — навпаки, він збільшується (спадає)"). The numbers
  were right; the prose was not. Worth checking the same prompts in
  English, or with a stronger model, before drawing conclusions about
  answer quality in Ukrainian.

## Changes made

- CLI: `scripts/lib/cache.ts` (busy timeout, WAL), `scripts/lib/report.ts`
  (caveat block height).
- Skill text: `SKILL.md` (report step).
- Tests: concurrent-writers test in `tests/cache.test.ts`. `npm test`
  passes 67/67, `tsc --noEmit` is clean.
