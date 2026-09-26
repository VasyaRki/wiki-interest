import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTrendStability,
  buildNormalizedSeries,
  computeConfidence,
  computeSeasonality,
  computeTrend,
  computeYoYGrowth,
  detectAnomalies,
  monthRange,
  type NormalizedPoint,
} from "../scripts/lib/metrics.js";

const PROJECT_VIEWS = 1_000_000_000;

/** Builds a synthetic NormalizedPoint series from a share_per_million generator, starting at startMonth. */
function makeSeries(startMonth: string, count: number, shareAt: (monthIndex: number) => number): NormalizedPoint[] {
  const months = monthRange(startMonth, addMonths(startMonth, count - 1));
  return months.map((month, i) => {
    const sharePerMillion = shareAt(i);
    const views = Math.round((sharePerMillion / 1e6) * PROJECT_VIEWS);
    return { month, views, projectViews: PROJECT_VIEWS, sharePerMillion };
  });
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y as number) * 12 + ((m as number) - 1) + n;
  const year = Math.floor(total / 12);
  const mon = (total % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

// Deterministic pseudo-random generator (mulberry32) so "noise" tests are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("monthRange produces an inclusive contiguous list, crossing a year boundary", () => {
  assert.deepEqual(monthRange("2024-11", "2025-02"), ["2024-11", "2024-12", "2025-01", "2025-02"]);
});

test("buildNormalizedSeries fills missing months with 0 views and normalizes correctly", () => {
  const series = buildNormalizedSeries(
    "2024-01",
    "2024-03",
    [{ month: "2024-01", views: 500 }], // 2024-02, 2024-03 missing -> 0
    [
      { month: "2024-01", views: 1_000_000 },
      { month: "2024-02", views: 2_000_000 },
      { month: "2024-03", views: 2_000_000 },
    ],
  );
  assert.equal(series.length, 3);
  assert.equal(series[0]?.sharePerMillion, 500); // 500 / 1,000,000 * 1e6
  assert.equal(series[1]?.views, 0);
  assert.equal(series[1]?.sharePerMillion, 0);
});

test("linear (log-space) trend: recovers a known +20%/year growth rate", () => {
  const annualGrowth = 0.2;
  const monthlyGrowth = Math.pow(1 + annualGrowth, 1 / 12) - 1;
  const series = makeSeries("2021-01", 36, (t) => 50 * Math.pow(1 + monthlyGrowth, t));

  const trend = computeTrend(series.map((p) => p.sharePerMillion));
  assert.ok(Math.abs(trend.slopePctPerYear - 20) < 0.5, `expected ~20%/yr, got ${trend.slopePctPerYear}`);
  assert.equal(trend.direction, "up");
  assert.ok(trend.pValue < 0.01, `expected a significant p-value, got ${trend.pValue}`);
  assert.ok(Math.abs(trend.senSlopePctPerYear - 20) < 1, `Sen's slope should agree with OLS, got ${trend.senSlopePctPerYear}`);
});

test("a declining series is detected with a negative slope and 'down' direction", () => {
  const series = makeSeries("2021-01", 36, (t) => 200 * Math.pow(0.98, t));
  const trend = computeTrend(series.map((p) => p.sharePerMillion));
  assert.ok(trend.slopePctPerYear < 0);
  assert.equal(trend.direction, "down");
});

test("a single spike is flagged as an anomaly and destabilizes the trend direction", () => {
  const spikeIndex = 18;
  const series = makeSeries("2021-01", 36, (t) => (t === spikeIndex ? 10 * 50 : 10));

  const anomalies = detectAnomalies(series);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]?.index, spikeIndex);
  assert.ok(Math.abs(anomalies[0]?.z ?? 0) > 3);

  const stability = analyzeTrendStability(series);
  // Flat baseline except one huge spike: including it pulls the OLS slope up,
  // removing it should flatten the trend back out -> direction disagreement.
  assert.equal(stability.directionStableWithoutAnomalies, false);
});

test("strong seasonality is detected with the correct peak month and a high ratio", () => {
  // January (month 1) peaks at 10x, July (month 7) is the trough at 1x.
  const seasonalFactor = [10, 6, 4, 2, 1.5, 1.2, 1, 1.2, 1.5, 2, 4, 6];
  const series = makeSeries("2021-01", 36, (t) => 5 * (seasonalFactor[t % 12] as number));

  const seasonality = computeSeasonality(series);
  assert.equal(seasonality.peakMonth, 1);
  assert.equal(seasonality.label, "strong");
  assert.ok((seasonality.ratio ?? 0) > 4);
});

test("flat noise: no significant trend and no anomalies", () => {
  const rand = mulberry32(42);
  // +/-10% jitter around a constant mean, no drift and no outliers.
  const series = makeSeries("2021-01", 36, () => 200 * (1 + (rand() - 0.5) * 0.2));

  const trend = computeTrend(series.map((p) => p.sharePerMillion));
  assert.ok(trend.pValue > 0.2, `expected a non-significant p-value for pure noise, got ${trend.pValue}`);

  const anomalies = detectAnomalies(series);
  assert.equal(anomalies.length, 0);
});

test("too-short series: YoY requires 24 months and returns a caveat instead of crashing", () => {
  const series = makeSeries("2024-01", 5, () => 100);
  const yoy = computeYoYGrowth(series);
  assert.equal(yoy.rawPct, null);
  assert.equal(yoy.normalizedPct, null);
  assert.match(yoy.caveat ?? "", /24 months/);
});

test("degenerate series (0 or 1 points) do not crash any metric function", () => {
  assert.doesNotThrow(() => computeTrend([]));
  assert.doesNotThrow(() => computeTrend([42]));
  assert.doesNotThrow(() => detectAnomalies([]));
  assert.doesNotThrow(() => computeYoYGrowth([]));
  assert.equal(computeTrend([]).direction, "flat");
});

test("computeConfidence: low-view median forces low confidence regardless of trend quality", () => {
  const result = computeConfidence({
    medianMonthlyViews: 50,
    monthCount: 36,
    trendPValue: 0.001,
    directionStableWithoutAnomalies: true,
    directionStableWithoutLast3Months: true,
  });
  assert.equal(result.level, "low");
  assert.ok(result.reasons.some((r) => r.includes("median monthly views")));
});

test("computeConfidence: fewer than 12 months forces low confidence", () => {
  const result = computeConfidence({
    medianMonthlyViews: 5000,
    monthCount: 6,
    trendPValue: 0.001,
    directionStableWithoutAnomalies: true,
    directionStableWithoutLast3Months: true,
  });
  assert.equal(result.level, "low");
});

test("computeConfidence: all high-confidence criteria met yields 'high'", () => {
  const result = computeConfidence({
    medianMonthlyViews: 5000,
    monthCount: 30,
    trendPValue: 0.01,
    directionStableWithoutAnomalies: true,
    directionStableWithoutLast3Months: true,
  });
  assert.equal(result.level, "high");
});

test("computeConfidence: decent but not high-bar data yields 'medium'", () => {
  const result = computeConfidence({
    medianMonthlyViews: 500,
    monthCount: 18,
    trendPValue: 0.1,
    directionStableWithoutAnomalies: true,
    directionStableWithoutLast3Months: true,
  });
  assert.equal(result.level, "medium");
});
