# Worked examples

Real command output (trimmed where noted), captured against the live
Wikimedia/Wikidata APIs. Numbers will drift over time as Wikipedia traffic
changes — the shapes and fields will not.

## 1. Unambiguous topic: "intermittent fasting" in Poland and Czechia

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "intermittent fasting" --langs pl,cs
```

```json
{
  "ok": true,
  "topic": "intermittent fasting",
  "search_lang": "en",
  "candidates": [
    { "qid": "Q1666254", "label": "intermittent fasting", "description": "a diet that cycles between a period of fasting and non-fasting" },
    { "qid": "Q112575736", "label": "Intermittent Fasting Can Make Us Healthier", "description": "Article published in Scientific European on 15 January 2019" },
    "... 5 more candidates (clinical trials, a book, a podcast episode) trimmed"
  ],
  "needs_confirmation": false,
  "best_qid": "Q1666254",
  "articles": { "pl": null, "cs": "Přerušovaný půst" },
  "notes": ["No Wikipedia article in \"pl\" for this topic."]
}
```

`needs_confirmation` is `false` and there's a `best_qid`, so proceed straight
to `analyze` without asking the user anything. Note `pl` is already `null`
here — expect `analyze` to report it as "nothing measured" too.

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid Q1666254 --langs pl,cs
```

```json
{
  "ok": true,
  "run_id": "r_20260926_bwtjnm",
  "question_scope": { "qids": ["Q1666254"], "langs": ["pl", "cs"], "from": "2024-09", "to": "2026-08", "rank_by": "level" },
  "per_language": [
    {
      "lang": "pl", "articles": [], "avg_monthly_views": null, "share_per_million": null,
      "yoy_growth_raw_pct": null, "yoy_growth_normalized_pct": null,
      "trend_slope_pct_per_year": null, "trend_p_value": null,
      "seasonality": "no data (no article)", "anomalies": [],
      "confidence": "low",
      "confidence_reasons": ["no Wikipedia article in this language, so nothing was measured"]
    },
    {
      "lang": "cs", "articles": ["Přerušovaný půst"], "avg_monthly_views": 289, "share_per_million": 4.4,
      "yoy_growth_raw_pct": -53.6, "yoy_growth_normalized_pct": -47.7,
      "trend_slope_pct_per_year": -46.7, "trend_p_value": 0.002,
      "seasonality": "moderate, peaks in April",
      "anomalies": [],
      "confidence": "medium",
      "confidence_reasons": ["median monthly views (232) is below 1000"]
    }
  ],
  "ranking": ["cs"],
  "summary": "cs is the only language with data (4.4 per million views), with declining interest (-46.7%/year), at medium confidence. Its first place is not a win over the other languages, which could not be measured. No Wikipedia article exists in pl, so nothing was measured there; this says nothing about interest in that language.",
  "caveats": [
    "pl: no Wikipedia article exists for this topic in this language, so nothing was measured; excluded from the ranking. Do not infer anything about interest in pl from this.",
    "cs: moderate, peaks in April; trend and anomalies are computed after removing this yearly pattern, so a regular seasonal peak is not reported as growth or as an anomaly. With under 3 years of data the pattern rests on 2 observations per calendar month, so a one-off spike can be partly absorbed as seasonal; use --period 36m or longer to separate them.",
    "Pageviews reflect reader interest, not purchase intent or willingness to pay."
  ],
  "chart_path": "/home/user/.cache/wiki-interest/runs/r_20260926_bwtjnm/trend.svg"
}
```

**How to answer the user:** cs has some real (if declining) interest at
medium confidence; pl has no Wikipedia article on this topic at all, so
there's no evidence either way for Polish — that's not the same as "no
interest in Poland". Mention the normalization (`share_per_million`) and
the medium confidence explicitly. The cs trend is seasonally adjusted (the
April peak is removed before fitting it), so say so; the April peak itself
is seasonality, not an anomaly.

## 2. A single-language question: "astronomy" in Ukraine

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "astronomy" --langs uk
```

```json
{
  "ok": true, "topic": "astronomy", "search_lang": "en",
  "candidates": [
    { "qid": "Q333", "label": "astronomy", "description": "natural science studying celestial objects and phenomena in the cosmos" },
    "... 6 more candidates (journals, a song, a magazine, astrobiology) trimmed"
  ],
  "needs_confirmation": false, "best_qid": "Q333",
  "articles": { "uk": "Астрономія" }, "notes": []
}
```

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid Q333 --langs uk
```

```json
{
  "ok": true,
  "run_id": "r_20260926_31bl4l",
  "question_scope": { "qids": ["Q333"], "langs": ["uk"], "from": "2024-09", "to": "2026-08", "rank_by": "level" },
  "per_language": [
    {
      "lang": "uk", "articles": ["Астрономія"], "avg_monthly_views": 972, "share_per_million": 13.7,
      "yoy_growth_raw_pct": -59.6, "yoy_growth_normalized_pct": -45.5,
      "trend_slope_pct_per_year": -37.4, "trend_p_value": 0.002,
      "seasonality": "strong, peaks in September",
      "anomalies": [],
      "confidence": "medium",
      "confidence_reasons": ["median monthly views (611) is below 1000"]
    }
  ],
  "ranking": ["uk"],
  "summary": "uk: 13.7 per million views, with declining interest (-37.4%/year), at medium confidence.",
  "caveats": [
    "uk: strong, peaks in September; trend and anomalies are computed after removing this yearly pattern, so a regular seasonal peak is not reported as growth or as an anomaly. With under 3 years of data the pattern rests on 2 observations per calendar month, so a one-off spike can be partly absorbed as seasonal; use --period 36m or longer to separate them.",
    "Pageviews reflect reader interest, not purchase intent or willingness to pay."
  ],
  "chart_path": "/home/user/.cache/wiki-interest/runs/r_20260926_31bl4l/trend.svg"
}
```

**How to answer the user:** interest in astronomy on Ukrainian Wikipedia
is declining (−37.4%/year, seasonally adjusted, normalized), at medium
confidence because traffic is modest (median 611 views/month). There is a
strong school-year pattern peaking in September; that is seasonality, not
growth. The caveat notes only 2 years of data: if the user wants to know
whether the decline is real or partly a one-off 2024 spike, suggest
re-running with `--run r_20260926_31bl4l --period 36m`.

## 3. Ambiguous topic: "mercury"

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts resolve --topic "mercury" --langs en
```

```json
{
  "ok": true, "topic": "mercury", "search_lang": "en",
  "candidates": [
    { "qid": "Q613883", "label": "Mercury", "description": "automobile marque of the Ford Motor Company" },
    { "qid": "Q1231263", "label": "Mercury", "description": "commune in Savoie, France" },
    { "qid": "Q308", "label": "Mercury", "description": "first planet from the Solar System..." },
    { "qid": "Q925", "label": "mercury", "description": "chemical element with symbol Hg and atomic number 80" },
    { "qid": "Q1150", "label": "Mercury", "description": "Roman god of trade, merchants, thieves and travel" },
    "... 2 more candidates trimmed"
  ],
  "needs_confirmation": true,
  "best_qid": "Q613883",
  "articles": null,
  "notes": ["Multiple plausible Wikidata entities match this topic. Show the candidate list to the user and ask which one they mean before calling analyze."]
}
```

`needs_confirmation` is `true`: **stop and ask the user** which entity they
mean, showing them the `label`/`description` pairs. Ignore `best_qid` here
— it is not a recommendation, just the top search hit. Only call `analyze`
once the user has picked one, using that candidate's `qid`.

If you instead call `analyze --topic "mercury" --langs en` directly without
resolving first, it refuses the same way:

```json
{
  "ok": false,
  "error": { "code": "topic_ambiguous", "message": "\"mercury\" matches multiple Wikidata entities." },
  "hint": "Run resolve --topic \"mercury\" --langs en, show the candidates to the user, then call analyze again with an explicit --qid."
}
```

## 4. Follow-up: "now add Slovak"

Reuse the run id from example 1 instead of re-resolving:

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --run r_20260926_bwtjnm --langs pl,cs,sk
```

```json
{
  "run_id": "r_20260926_jd2wqo",
  "question_scope": { "qids": ["Q1666254"], "langs": ["pl", "cs", "sk"], "from": "2024-09", "to": "2026-08", "rank_by": "level" },
  "ranking": ["cs"],
  "summary": "cs is the only language with data (4.4 per million views), with declining interest (-46.7%/year), at medium confidence. Its first place is not a win over the other languages, which could not be measured. No Wikipedia article exists in pl, sk, so nothing was measured there; this says nothing about interest in those languages."
}
```

(`per_language` and `caveats` trimmed.) The topic (`qids`), period
(`from`/`to`), `rank_by`, and any excludes all carried over unchanged from
`r_20260926_bwtjnm` — only `--langs` was overridden. Slovak has no article
either, so it is reported exactly like Polish. This
also created a **new** run id; the original run is untouched, so you can
still `report --run r_20260926_bwtjnm` for the 2-language version.

For "use 5 years instead", the equivalent call is
`analyze --run <run_id> --period 60m` (only the period changes, langs and
topic are inherited the same way).

## 5. Ranking by growth instead of size

"Where is interest in astronomy growing fastest — Ukrainian, Polish or
Czech?" asks about growth, so pass `--rank-by growth`:

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts analyze --qid Q333 --langs uk,pl,cs --rank-by growth
```

```json
{
  "ok": true,
  "run_id": "r_20260926_vy0v7c",
  "question_scope": { "qids": ["Q333"], "langs": ["uk", "pl", "cs"], "from": "2024-09", "to": "2026-08", "rank_by": "growth" },
  "per_language": [
    { "lang": "uk", "share_per_million": 13.7, "trend_slope_pct_per_year": -37.4, "trend_p_value": 0.002, "seasonality": "strong, peaks in September", "confidence": "medium" },
    { "lang": "pl", "share_per_million": 7.8, "trend_slope_pct_per_year": -12.4, "trend_p_value": 0.016, "seasonality": "moderate, peaks in November", "confidence": "high" },
    { "lang": "cs", "share_per_million": 10, "trend_slope_pct_per_year": -18.8, "trend_p_value": 0.006, "seasonality": "weak, peaks in September", "confidence": "medium" }
  ],
  "ranking": ["pl", "cs", "uk"],
  "summary": "Ranked by trend: pl shows the slowest normalized decline (-12.4%/year, 7.8 per million views), at high confidence. cs follows at -18.8%/year."
}
```

(`per_language` fields and `caveats` trimmed.) With the default
`--rank-by level` the order would be uk, cs, pl — uk has the largest share
of readers but the steepest decline. All three are declining, so the
honest answer is "declining slowest", not "growing": relay the `summary`
wording as is. A follow-up with `--run r_20260926_vy0v7c` keeps
`rank_by: growth` unless you pass `--rank-by level`.

## 6. Writing a report

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts report --run r_20260926_bwtjnm --question "Should we launch our intermittent fasting course in Polish or Czech?" --lang en
```

```json
{ "ok": true, "run_id": "r_20260926_bwtjnm", "pdf_path": "/home/user/projects/wiki-interest-r_20260926_bwtjnm-en.pdf" }
```

The PDF is always exactly one page. Pass `--lang uk` for a Ukrainian report
(labels and headers only — see `references/LIMITATIONS.md`).

## 7. Listing runs

```
<skill-dir>/node_modules/.bin/tsx <skill-dir>/scripts/wiki-interest.ts runs --limit 5
```

```json
{
  "ok": true,
  "runs": [
    { "run_id": "r_20260926_vy0v7c", "created_at": "2026-09-26T14:32:27.351Z", "topic": null, "qids": ["Q333"], "langs": ["uk", "pl", "cs"], "from": "2024-09", "to": "2026-08" },
    { "run_id": "r_20260926_31bl4l", "created_at": "2026-09-26T14:32:25.335Z", "topic": null, "qids": ["Q333"], "langs": ["uk"], "from": "2024-09", "to": "2026-08" },
    { "run_id": "r_20260926_jd2wqo", "created_at": "2026-09-26T14:32:21.136Z", "topic": null, "qids": ["Q1666254"], "langs": ["pl", "cs", "sk"], "from": "2024-09", "to": "2026-08" },
    { "run_id": "r_20260926_bwtjnm", "created_at": "2026-09-26T14:32:19.272Z", "topic": null, "qids": ["Q1666254"], "langs": ["pl", "cs"], "from": "2024-09", "to": "2026-08" }
  ]
}
```

Use this when the user references an earlier analysis but you don't have
its run id handy.

## 8. Errors

Every failure looks like this (here, `report` with an unknown run id):

```json
{
  "ok": false,
  "error": { "code": "run_not_found", "message": "No stored run with id \"r_20200101_zzzzzz\"." },
  "hint": "Run the `runs` command to list available run ids, or run `analyze` first."
}
```

Always act on `hint`, not on the error `message` alone.
