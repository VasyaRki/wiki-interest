# wiki-interest

An [Agent Skill](https://agentskills.io/specification) that analyzes
Wikipedia pageview trends for a topic across language editions, so a
small, cheap agent (this was built and evaluated against Claude Haiku
4.5) can give a B2C founder a data-backed answer to "is there interest in
X, and which language/market should we launch in?" — with a chart and a
one-page PDF report on request.

All the math (normalization, seasonal adjustment, trend and anomaly
detection, confidence scoring) runs in plain TypeScript. The agent's job is limited
to picking a CLI command, passing arguments, and relaying the JSON it
gets back — see `SKILL.md` for the agent-facing contract.

## Setup

```
npm ci
```

Requires Node.js 22.13+ (for the built-in `node:sqlite` and `node:test`
modules) and internet access to `wikimedia.org` and `wikidata.org`. No
native/compiled dependencies — `npm ci` needs no build toolchain.

Then set a `User-Agent` identifying *your* deployment, per
[Wikimedia's User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy)
— without this, requests go out with a generic, non-identifying value
(and a warning on every run reminds you). Nobody's personal contact info
is hardcoded as a default, so every installer sets their own:

```
export WIKI_INTEREST_USER_AGENT="wiki-interest-skill/0.1 (https://github.com/<you>/<repo>; <email or contact URL>)"
```

```
npx tsx scripts/wiki-interest.ts <command> [options]
# or: npm run wi -- <command> [options]
```

Commands: `resolve`, `analyze`, `report`, `runs`. Every invocation prints
exactly one JSON object to stdout (`{"ok": true, ...}` or `{"ok": false,
"error": {...}, "hint": "..."}`); everything else (progress, warnings)
goes to stderr. The SQLite cache, stored runs and
charts live in a shared directory, `~/.cache/wiki-interest/` (or
`$XDG_CACHE_HOME/wiki-interest/`; override with `WIKI_INTEREST_HOME`), so the
cache and `--run` work from any folder. Only `report` writes to the current
folder: `wiki-interest-<run_id>-<lang>.pdf`, returned as an absolute path.

```
npm test          # unit tests (node:test)
npm run typecheck # tsc --noEmit
```

## Architecture

```
scripts/wiki-interest.ts   CLI entry point (commander): parses args, calls
                            into scripts/lib, prints one JSON line, never
                            computes anything itself.
scripts/lib/
  resolve.ts                Wikidata search (wbsearchentities) + sitelinks
                             (wbgetentities) → per-language article titles.
                             Deterministic disambiguation (never silently
                             guesses between two equally-plausible topics).
  fetch.ts                  Wikimedia Pageviews REST client: User-Agent,
                             retry/backoff on 429/5xx, 404 = "no data" not
                             a crash, correct monthly date-range bounds.
  cache.ts                  node:sqlite: HTTP response cache (keyed by
                             request URL) + run storage (settings +
                             resolved articles + the full analyze result,
                             so `report` never needs to re-fetch).
  metrics.ts                Pure functions, no I/O: normalization
                             (share-per-million), YoY growth, trend (OLS on
                             log-share + Mann-Kendall + Sen's slope),
                             anomaly detection (robust z-score), seasonality,
                             and the deterministic confidence rules. See
                             references/METRICS.md for the exact formulas.
  analyze.ts                Orchestrates resolve + fetch + metrics into the
                             `analyze` command's output: date-range
                             resolution, concurrent fetches (capped at 5 via
                             p-limit), per-language rollup, ranking, a
                             templated plain-language summary, run
                             persistence.
  charts.ts                 Vega-Lite spec (assets/chart-trend.vl.json) →
                             headless SVG via vega (no canvas, no browser).
  report.ts                 One-page A4 PDF via pdfkit + svg-to-pdfkit,
                             English or Ukrainian (embeds DejaVu Sans —
                             PDFKit's built-in fonts have no Cyrillic).
  schemas.ts                zod schemas for every command's input and
                             output.
  errors.ts                 Typed errors → the `{"ok":false,"error",
                             "hint"}` JSON contract.
assets/                     Chart spec, bundled fonts (with license).
references/                 METRICS.md, LIMITATIONS.md, EXAMPLES.md — linked
                             from SKILL.md for the agent to read on demand.
tests/                      node:test; fixtures are real recorded API
                             responses, not hand-typed fakes.
evals/                      Findings from running the skill against
                             Claude Haiku (FINDINGS.md per run) and the
                             runner script; raw transcripts stay local.
```

Data flow for `analyze`: `resolve.ts` turns a topic into a Wikidata QID and
per-language article titles → `fetch.ts` pulls monthly pageviews per
article and per project (for normalization), through `cache.ts` →
`metrics.ts` turns each language's series into normalized figures, a
trend, anomalies, seasonality, and a confidence rating → `analyze.ts`
assembles this into the compact JSON contract, generates the chart, and
persists the run → the CLI prints it.
## How it was verified

AI tools (Claude Code) wrote most of the code; nothing was accepted on
trust:

- **Unit tests** (`npm test`) for every metric against synthetic series
  with known answers, and for the API clients against real recorded
  responses (`tests/fixtures/`), not hand-written fakes.
- **Spot checks against the source.** Wikidata sitelinks and pageview
  numbers were checked directly on the APIs for surprising results (e.g.
  that Q1666254 really has no `plwiki` article).
- **End-to-end runs on Claude Haiku 4.5** (`evals/`, runner
  `evals/run_eval.sh`): the three sample questions from the task plus
  follow-ups and PDF requests, in a clean folder with only this skill
  installed. Every problem found in the transcripts was fixed and then
  re-tested; fixes that only changed SKILL.md were not trusted until the
  retest passed, and several were moved into code when they didn't.
  Every generated PDF was checked to be exactly one page (`pdfinfo`).

## Further development

Roughly in priority order; each step is small enough to ship and
re-evaluate on Haiku before the next.

1. **Better topic coverage.** Suggest multi-QID baskets automatically
   (subclasses, "facet of", related articles via Wikidata/SPARQL) and
   fall back to language-specific search when an article has no Wikidata
   sitelink.
2. **Report recommendations.** A templated "what to explore next" block
   in the PDF, driven by ranking and confidence rather than model prose;
   localize `summary` and `caveats` for `--lang uk`.
3. **Scale.** Batch mode for many topics × languages with a persistent
   job queue and rate-limit budget; daily granularity for short-lived
   spikes; Wikimedia pageview dumps instead of the REST API for large
   historical backfills; export to CSV/Parquet for notebook analysis.
4. **More signals.** Optional cross-checks from other sources (search
   trends, app-store data) to reduce reliance on a single proxy.
5. **Evals in CI.** Turn `evals/` into a regression suite: fixed
   questions, assertions over transcripts (confidence stated, no
   recommendation on `low`, full `pdf_path` given), run on every
   SKILL.md or output-format change.
