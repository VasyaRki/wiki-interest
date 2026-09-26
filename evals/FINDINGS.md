# Evaluation run 1: wiki-interest on Claude Haiku 4.5

Ran the three sample questions from the task description plus two follow-ups against
`claude --model haiku` (`claude-haiku-4-5`) with the skill installed as a
personal skill (`~/.claude/skills/wiki-interest`), in a clean working
directory with no other project context. Non-interactive (`-p`), tools
restricted to `Bash`, `Skill`, `Read` via `--allowedTools`. Transcripts are
the raw `--output-format stream-json` output for each turn. Run 1 transcripts were not
preserved, so the file names below are for reference only; see `run2/`
for the later run.

## Sessions

| File | Scenario |
|---|---|
| `01-intermittent-fasting-turn1.jsonl` | "Is there interest in intermittent fasting in Poland/Czechia?" (before fix) |
| `01-intermittent-fasting-turn2-add-slovak.jsonl` | Follow-up: "now also check Slovak" |
| `01-intermittent-fasting-turn3-5-years.jsonl` | Follow-up: "use the last 5 years instead" |
| `02-astronomy-uk.jsonl` | "How's interest in astronomy trending in Ukraine?" |
| `03-esl-languages.jsonl` | "Which markets for ESL content: PL/CZ/UA/DE/FR?" (before fix) |
| `01b-intermittent-fasting-turn1-retest.jsonl` | Retest of Q1 after first SKILL.md fix attempt (partial improvement) |
| `01c-intermittent-fasting-turn1-retest2.jsonl` | Retest of Q1 after final SKILL.md fix (clean) |
| `03b-esl-languages-retest.jsonl` | Retest of Q3 after final SKILL.md fix (clean) |

## What went right (no fix needed)

- **Command syntax was correct every single time**, across all 8 turns:
  `resolve` before `analyze`, correct `--langs` comma-joining, correct
  `--qid`/`--run`/`--period` usage, never re-typed unchanged options on a
  follow-up.
- **Follow-ups always used `--run <run_id>`** with only the changed option
  (`--langs pl,cs,sk`, then `--period 60m`), and never called `resolve`
  again on a follow-up. This is the behavior the "Follow-up questions"
  section of `SKILL.md` was written to produce, and it worked first try.
- **Confidence was always stated**, per language, for every result.
- **Normalization was consistently mentioned** ("share per million",
  "normalized for overall Wikipedia traffic decline") whenever comparing
  languages or time periods.
- **"Pageviews ≠ demand/willingness to pay" was consistently honored** —
  every session included an explicit disclaimer along these lines
  unprompted.
- `needs_confirmation` handling was never actually exercised (none of the
  three sample topics came back ambiguous), so that branch is unverified
  by this eval; `references/EXAMPLES.md` covers it with a real captured
  transcript (the "mercury" case) as a substitute.

## What went wrong, and the fix

### 1. "No article" was sometimes phrased as "no interest" (minor)

In turn 1 and its Slovak follow-up, the model headlined missing-article
languages as **"No measurable interest"** / **"Cannot recommend
translation"** — collapsing "the tool took no measurement" into "the
measurement came back negative." `SKILL.md` already said "low confidence
is not no interest," but that rule was written for the *statistical*
low-confidence case, not the *zero-articles* case, so the model didn't
apply it there.

**Fix:** added a dedicated bullet to Interpretation rules requiring exact
phrasing ("no Wikipedia article was found" / "no data available") and
explicitly forbidding even a softened inference ("this suggests minimal
interest") — because a first attempt at the fix reduced but didn't
eliminate the inference (see `01b-...-retest.jsonl`, which still said "This
suggests minimal reader interest"). The second version
(`01c-...-retest2.jsonl`) produced: *"No Wikipedia article exists... This
is not the same as 'no interest.'"* — directly echoing the rule.

### 2. Silent topic substitution when the first topic had thin data (moderate)

In the ESL session, `resolve "English as a second or foreign language"`
correctly found `Q130192`, but `analyze` came back with almost no data in
any of the 5 requested languages. Without telling the user, the model
tried two more `resolve` calls with different phrasings, settled on a
different Wikidata entity (`Q7691272`, TEFL), and answered using *that*
data — never mentioning to the user that it had switched topics or why.
The tool's own output already said "Treat this as a weak signal only, not
a launch recommendation" for the first topic, but that got dropped rather
than surfaced.

**Fix:** added a workflow rule: report thin/empty results plainly first;
only then try an alternative topic phrasing, and tell the user explicitly
when doing so. Retested (`03b-esl-languages-retest.jsonl`): the model now
narrates *"The data is quite sparse... Let me try a broader search..."*
before pivoting, and the final answer still leads with the original
finding ("No Wikipedia articles exist for English language learning
topics in Czechia, Ukraine, or France... this doesn't mean there's no
interest").

## Changes made

Both fixes are in `SKILL.md` only (Interpretation rules + Workflow
sections) — no CLI output or hint changes were needed; the tool's JSON
(`caveats`, `summary`) already said the right thing in both cases, the gap
was purely in how the agent's own prose used it. Re-validated with
`npx skills-ref validate ./wiki-interest` and the full test suite
(`npm test`) after each edit.
