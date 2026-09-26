---
name: wiki-interest
description: Analyzes Wikipedia pageview trends for a topic across language editions to judge audience interest for B2C product decisions. Compares growth between languages, assesses trend reliability, generates charts and one-page PDF reports. Use when the user asks about interest in a topic, which languages/markets to launch in, or wants data-backed evidence from Wikipedia traffic.
license: MIT
compatibility: Requires Node.js 22.13+ and npm, plus internet access to wikimedia.org and wikidata.org APIs.
metadata:
  version: "0.1.0"
---

# wiki-interest

All math (normalization, trends, confidence) runs in the tool. You only pick
a command, pass arguments, and relay the JSON result. Never compute or
estimate trends, growth, or confidence yourself.

## Setup (once)

Run `npm ci` in the skill directory (the folder containing this file).

Run every command from the user's current folder — do NOT `cd` into the
skill directory. In all commands below, replace `<skill-dir>` with the
absolute path of the skill directory.

stdout is always one JSON object. Success has `"ok": true`. Failure has
`"ok": false`, an `"error"`, and a `"hint"` naming the exact next command.

## Workflow

1. **resolve** the topic first, in the languages the user asked about.
2. If the result has `"needs_confirmation": true`, STOP. Show the
   `candidates` (label + description) to the user and ask which one they
   mean. Do not guess or pick one yourself. Once they answer, use that
   candidate's `qid` for the next step.
3. **analyze** using the confirmed `qid` — or, if `resolve` returned a
   single unambiguous candidate (`needs_confirmation: false`), its
   `best_qid` directly, without asking.
4. Answer the user in chat using `summary`, `per_language`, `ranking`, and
   `caveats` from the JSON. See Interpretation rules below.
5. **Report.** If the user asked for a report, PDF, or something to
   share (in any language, e.g. "звіт") anywhere in the conversation —
   including their first message, even if a clarifying question came in
   between — run **report** right after `analyze`, without asking. Do
   this even when confidence is `low`: the report states the limitations.
   Otherwise ask once: "Do you want a one-page PDF report saved in the
   current folder, or is the answer in chat enough?" and run **report**
   only if they say yes.

If `analyze` comes back with thin or no data everywhere (every language
`low` confidence or `articles: []`), first report that plainly — it's a
real, honest answer. Only then, if you try a differently-worded topic to
see whether a more specific or more general Wikidata entity is better
covered, tell the user you did this and why (e.g. "the general concept had
almost no data, so I also checked '<other topic>', which had more"). Never
silently substitute a different topic than the one you resolved.

## Commands

### resolve
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "<text>" --langs <codes> [--search-lang <code>]
```
`<codes>` is comma-separated, e.g. `pl,cs`. `--search-lang` defaults to
`en`; only change it if searching in English finds nothing.

### analyze
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid <QID> [--qid <QID> ...] --langs <codes> [--period <N>m | --from <YYYY-MM> --to <YYYY-MM>] [--exclude <YYYY-MM>:<YYYY-MM>] [--rank-by level|growth] [--run <run_id>]
```
Multiple `--qid` sums views across all of them as one topic basket.
Default period is the last 24 months if you pass neither `--period` nor
`--from`/`--to`. `--exclude` removes a month range from the analysis (e.g.
a known traffic anomaly); repeat it for multiple ranges.
`--rank-by` decides the order in `ranking`: `level` (default) = where the
topic has the largest share of readers now; `growth` = where interest is
growing fastest. Use `growth` when the user asks about growth, rising
interest, or momentum; otherwise keep the default.

### report
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts report --run <run_id> [--question "<original question>"] [--lang en|uk]
```
Writes a one-page PDF into the current folder and returns its absolute
path in `pdf_path`. Nothing else is written to the user's folder; cache and
charts live in a shared cache directory. Pass the user's
original question verbatim in `--question` so the report is self-contained.
Give the user the full `pdf_path` exactly as returned (absolute path, not
just the file name).

### runs
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts runs [--limit <n>]
```
Lists recent runs (id, topic, languages, period) so you can find one to
refine with `--run`.

## Exact examples for common questions

**"Is there interest in intermittent fasting in Poland or Czechia?"**
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "intermittent fasting" --langs pl,cs
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid <best_qid from resolve> --langs pl,cs
```

**"How is interest in astronomy trending in Ukraine?"**
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "astronomy" --langs uk
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid <best_qid from resolve> --langs uk
```

**"Which countries should we launch ESL content in?"**
```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "English as a second or foreign language" --langs pl,cs,uk,de,fr
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid <best_qid from resolve> --langs pl,cs,uk,de,fr
```

More worked examples with real output: `references/EXAMPLES.md`.

## Interpretation rules

- **Always state the confidence level** (`low`/`medium`/`high`) per
  language when relaying results. Never quote a number without it.
- **On `confidence: "low"`, do not recommend a language or market.**
  Explain why using `confidence_reasons` (too few months of data, very low
  traffic, an unstable trend). Low confidence is not "no interest" — it
  means the data can't support a decision either way.
- **Always mention normalization when comparing languages or over time.**
  Overall Wikipedia traffic is declining, so `share_per_million` (not raw
  views) is what growth/decline and cross-language comparisons are based
  on. `avg_monthly_views` is context, not the basis for comparison.
- **Never claim pageviews equal willingness to pay or purchase intent.**
  They measure reader curiosity/traffic only. Say "interest" or
  "readership", not "demand" or "customers".
- **Distinguish "no article exists" from "measured, but low confidence."**
  When `articles` is empty for a language, say exactly that — "no
  Wikipedia article was found" or "no data available" — not "no measurable
  interest" or "no interest." Do not soften this into an inference either
  (e.g. "this suggests minimal interest") — a missing article on this
  specific language edition has many causes unrelated to interest (nobody
  has written it yet, it is merged into a broader article, editor
  coverage gaps). The tool took no measurement at all; say so and stop
  there. Do not speculate about the market either ("less mainstream",
  "less saturated", "an early-entry opportunity"). This applies even when
  summarizing across several languages, e.g. in a table.
- If a language ranks first only because others had no article or no data
  (check `summary` and `caveats`), say so — it isn't a real win. Do not
  call it "the clearer pick".
- `anomalies` are one-off spikes or dips, not seasonality. If there are
  any, mention them briefly and keep them separate from the `seasonality`
  field. When a caveat says trend was computed after removing a yearly
  pattern, say the trend is seasonally adjusted.
- See `references/LIMITATIONS.md` before making strong claims from a
  single run.

## Follow-up questions

If the user asks a follow-up about a topic you already analyzed ("now add
Slovak", "use 5 years instead", "exclude the COVID period"), reuse the run
instead of starting over:

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --run <run_id> [only the changed options]
```

Do not call `resolve` again and do not re-type unchanged options —
`--run` carries over everything you don't explicitly override. Get
`<run_id>` from the previous command's output, or from `runs` if you've
lost track of it. Do not ask about the PDF again on follow-ups unless the
user brings it up.

When the period changes, `summary` ends with a "Compared with the
previous run" sentence. Relay that sentence as the comparison. Do not
compare the two runs' numbers yourself, and do not explain why the rate
differs (no "stabilized", "novelty wore off", "temporary").

## Errors

Every error is JSON with a `"hint"` field. Follow it — it names the exact
next command (e.g. re-run `resolve` with a different `--search-lang`, or
run `runs` to find a valid run id). Do not retry the same command
unchanged, and do not invent data when a command reports none is
available.

## More detail

- `references/METRICS.md` — exactly how normalization, trend, anomalies,
  seasonality, and confidence are computed.
- `references/LIMITATIONS.md` — what this tool cannot tell you.
- `references/EXAMPLES.md` — full worked examples with real output.