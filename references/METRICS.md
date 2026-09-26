# Metrics reference

How `scripts/lib/metrics.ts` turns monthly pageview series into the numbers
in `analyze`'s output. All functions there are pure and unit-tested against
synthetic series in `tests/metrics.test.ts`.

## Normalization

Overall Wikipedia traffic has been declining for years, so raw view counts
alone make a topic look like it's losing interest even when its *share* of
readers is flat or growing. Every metric is computed on both:

- **raw views** — the article's monthly pageviews, summed across all
  articles in a topic basket.
- **`share_per_million`** — `article_views / project_total_views * 1e6` for
  that language edition and month. This is what trend and confidence are
  actually based on.

Months the Wikimedia API doesn't return for an article are treated as 0
views (the API omits zero-view months rather than listing them), so the
series is always contiguous across the requested date range.

## Year-over-year growth

Sum of the last 12 months vs. the sum of the previous 12 months, computed
for both raw and normalized series. Requires at least 24 months of data;
below that, both values are `null` and a caveat explains why instead of
returning a misleading number from a partial comparison.

## Seasonal adjustment

With at least 24 months of data (every calendar month seen at least
twice), the seasonal pattern is estimated jointly with the trend on
`log(share_per_million + ε)` by backfitting: fit the OLS trend on the
deseasonalized series, take the **median** detrended residual per calendar
month as that month's offset (centered to mean 0), repeat 5 times.
Estimating both together means a declining series is not mistaken for a
"peak in the first months", and the median keeps a one-off spike from
being absorbed as seasonal once a calendar month has 3+ observations.

Strength is the peak/trough ratio of the offsets, `exp(max - min)`:

| ratio | label |
|---|---|
| < 1.3 | none |
| 1.3 – 2 | weak |
| 2 – 4 | moderate |
| > 4 | strong |

The peak month is the calendar month with the largest offset. Below 24
months, seasonality is reported as not assessable.

If the label is anything but `none`, the offsets are divided out of
`share_per_million` and **trend, p-value, anomalies and trend stability
are computed on that seasonally adjusted series**, with a caveat saying
so. Otherwise a regular yearly peak (e.g. every September) is flagged as
anomalies, and a window that starts on a peak reads as a steep decline.
YoY growth needs no adjustment: it compares the same 12 calendar months.
With under 36 months, the caveat also warns that each offset rests on two
observations, so a one-off spike can be partly absorbed as seasonal.

## Trend

All of the following run on the seasonally adjusted series when
seasonality was detected (see above), otherwise on `share_per_million`.

- **Slope (`trend_slope_pct_per_year`)**: ordinary least squares on
  `log(share + ε)` against month index (`ε = 1e-6`, negligible
  next to any real share value, just avoids `log(0)` in zero-view months).
  The monthly log-slope `m` is annualized as a compounding rate:
  `(exp(m * 12) - 1) * 100`, not `m * 12 * 100`, because a log-linear fit
  implies exponential (not linear) growth.
- **p-value (`trend_p_value`)**: from the Mann-Kendall trend test, not the
  OLS regression itself. Mann-Kendall is rank-based — it only asks whether
  values tend to rise or fall over time, not whether they fit a straight
  line — so it's robust to the shape of the series and to outliers. In
  `confidence_reasons`, values below 0.01 are written as `< 0.01`.
- **Sen's slope**: the median of all pairwise slopes in log space, annualized
  the same way as the OLS slope. A robust cross-check — if it disagrees
  sharply with the OLS slope, the OLS estimate is likely being pulled around
  by a few extreme months.
- **Direction**: `up` / `down` / `flat` from the sign of the OLS slope. Used
  to check whether the trend's direction survives removing anomalies or the
  most recent 3 months (see Confidence).

## Anomalies

Robust (median/MAD) z-score on the residuals of the (seasonally adjusted)
log series after subtracting the fitted OLS trend line:

```
z_i = 0.6745 * (residual_i - median(residuals)) / MAD(residuals)
```

`0.6745` is the standard constant that makes a MAD-based deviation
comparable to a normal-distribution z-score. `|z| > 3` is flagged as an
anomaly. If the residuals have zero MAD (no variability to compare
against), no anomalies are reported rather than dividing by zero.

The trend is then recomputed with anomalous months removed; if the
direction (up/down/flat) flips, that's surfaced as a confidence trigger —
it means the headline trend is being driven by one or two spikes rather
than a sustained pattern.

## Ranking

`ranking` orders languages with data by `--rank-by`:

- `level` (default): average `share_per_million` — where the topic already
  draws the largest share of readers.
- `growth`: `trend_slope_pct_per_year` — where interest is growing fastest
  (or declining slowest).

Languages without an article are never ranked. `--rank-by` is inherited
by follow-ups that pass `--run`.

## Confidence

Deterministic rules — never a model judgment call. Evaluated in order:

1. **`low`** if any of:
   - median monthly views < 100
   - fewer than 12 months of data
   - trend direction flips after removing anomalies
   - trend p-value > 0.2
2. **`high`** if *all* of:
   - median monthly views ≥ 1000
   - ≥ 24 months of data
   - trend p-value < 0.05
   - trend direction is stable both without anomalies and without the last
     3 months (two independent checks against the last month's data being
     noisy or anomalous months being ambiguous)
3. **`medium`** otherwise.

`confidence_reasons` always lists the specific conditions that decided the
level, in plain language, so the caveat is self-explanatory without
re-deriving it from the raw numbers.
