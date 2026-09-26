# Limitations

What this tool cannot tell you, and where its numbers can mislead if read
without this context.

## Pageviews are not demand

A pageview is a reader looking at an article, not a purchase, a signup, or
willingness to pay. Wikipedia's readership also skews toward people who
already search things online in that language — it under-represents
offline-first or social-media-first audiences. Treat every number here as
"documented curiosity", not "market size" or "customer count".

## Wikipedia readership is a proxy, not the market

Interest in a topic on Wikipedia correlates with, but is not the same as,
interest in a product about that topic. A spike in "intermittent fasting"
pageviews might be driven by a viral video or a celebrity mention that has
nothing to do with anyone wanting to pay for a course on it.

## Data window

Wikimedia's pageviews API only has data from **2015-07** onward, `agent=user`
only (bot traffic is excluded, but some automated or proxy traffic can
still slip through). `analyze` never includes the current, still-in-progress
calendar month — its data is partial and would otherwise show as a fake
collapse; the most recent month reported is always the last fully-elapsed
one.

## A Wikidata topic is not one fixed article

The same Wikidata item (QID) can map to differently-scoped articles across
language editions — broader in some languages, narrower or entirely
absent in others (`resolve` reports `null` for languages with no article).
A missing article means no data was found, not zero interest; `analyze`
excludes such languages from the ranking and says so in `caveats`, rather
than guessing.

`resolve` also only ever proposes **one** best-matching Wikidata entity (or
asks you to disambiguate). If a topic genuinely spans multiple Wikidata
items (e.g. a concept split across several related entries), you must
identify those QIDs yourself and pass them all to `analyze --qid` as a
basket; the tool cannot discover a multi-item basket on its own.

## Confidence is a heuristic, not a guarantee

`confidence` comes from fixed, deterministic rules (median traffic,
months of data, a trend p-value, and whether the trend survives removing
anomalies/the last 3 months — see `references/METRICS.md`). It flags
*statistical* reliability, not real-world correctness. A `high`-confidence
declining trend can still reverse next quarter; a `low`-confidence result
can still be pointing at something real that the data is just too thin to
confirm.

## Small numbers are noisy

Below a few hundred monthly views, month-to-month swings are dominated by
random variation, not genuine shifts in interest. This is exactly what the
`median monthly views < 100` low-confidence rule is for — but even
`medium`-confidence results on small languages/topics deserve more
skepticism than the same trend on a high-traffic one.

## Report localization is partial

`report --lang uk` translates the report's fixed labels and headers (table
columns, section titles, assumptions text) into Ukrainian. It does **not**
translate the generated `summary` sentence or the dynamic `caveats` —
those are produced by code, not a language model, and are always in
English regardless of `--lang`.

## Chart and report generation are best-effort

If chart rendering fails for any reason, `analyze` still returns full,
correct numeric results with `chart_path: null` and a caveat — never
silently drops the numbers to produce a chart. `report` similarly still
produces a valid one-page PDF (noting "Chart unavailable") if no chart
exists for the run.

## No cross-checking against non-Wikipedia signals

This tool only reads Wikipedia/Wikidata. It has no visibility into search
volume, social media, app store data, or actual sales — treat its output
as one input among several for a launch or localization decision, not the
whole picture.
