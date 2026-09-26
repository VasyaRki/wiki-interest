import { cumulativeStdNormalProbability, linearRegression, median, medianAbsoluteDeviation } from "simple-statistics";

// All functions here are pure (no I/O): given monthly view series, they
// compute normalization, growth, trend, anomalies, seasonality, and a
// deterministic confidence rating. Rounding for display happens where the
// CLI assembles the final JSON, not here, so intermediate math stays exact.

export interface MonthlyPoint {
  month: string; // "YYYY-MM"
  views: number;
}

export interface NormalizedPoint {
  month: string;
  views: number;
  projectViews: number;
  sharePerMillion: number;
}

/** Inclusive list of "YYYY-MM" months from fromMonth to toMonth. */
export function monthRange(fromMonth: string, toMonth: string): string[] {
  const [fromYearStr, fromMonthStr] = fromMonth.split("-");
  const [toYearStr, toMonthStr] = toMonth.split("-");
  let year = Number(fromYearStr);
  let month = Number(fromMonthStr);
  const toYear = Number(toYearStr);
  const toMonthNum = Number(toMonthStr);

  const months: string[] = [];
  while (year < toYear || (year === toYear && month <= toMonthNum)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Expands article/project points to a contiguous monthly series (missing
 * months = 0 views, since the pageviews API omits zero-view months rather
 * than listing them) and computes share_per_million per month.
 */
export function buildNormalizedSeries(
  fromMonth: string,
  toMonth: string,
  articlePoints: MonthlyPoint[],
  projectPoints: MonthlyPoint[],
): NormalizedPoint[] {
  const articleByMonth = new Map(articlePoints.map((p) => [p.month, p.views]));
  const projectByMonth = new Map(projectPoints.map((p) => [p.month, p.views]));

  return monthRange(fromMonth, toMonth).map((month) => {
    const views = articleByMonth.get(month) ?? 0;
    const projectViews = projectByMonth.get(month) ?? 0;
    const sharePerMillion = projectViews > 0 ? (views / projectViews) * 1e6 : 0;
    return { month, views, projectViews, sharePerMillion };
  });
}

// ---------------------------------------------------------------------------
// Year-over-year growth
// ---------------------------------------------------------------------------

export interface YoYGrowth {
  rawPct: number | null;
  normalizedPct: number | null;
  caveat: string | null;
}

function pctChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

/** Sum of the last 12 months vs. the previous 12 months; requires >= 24 months of data. */
export function computeYoYGrowth(series: NormalizedPoint[]): YoYGrowth {
  if (series.length < 24) {
    return {
      rawPct: null,
      normalizedPct: null,
      caveat: `Fewer than 24 months of data (${series.length}); year-over-year growth needs at least 24.`,
    };
  }

  const last12 = series.slice(series.length - 12);
  const prev12 = series.slice(series.length - 24, series.length - 12);
  const sum = (pts: NormalizedPoint[], key: "views" | "sharePerMillion") => pts.reduce((s, p) => s + p[key], 0);

  return {
    rawPct: pctChange(sum(prev12, "views"), sum(last12, "views")),
    normalizedPct: pctChange(sum(prev12, "sharePerMillion"), sum(last12, "sharePerMillion")),
    caveat: null,
  };
}

// ---------------------------------------------------------------------------
// Trend: OLS on log(share), Mann-Kendall p-value, Sen's slope
// ---------------------------------------------------------------------------

// Avoids log(0) for zero-view months without materially shifting real
// (non-zero) share values, which are always many orders of magnitude larger.
const LOG_EPSILON = 1e-6;

function fitLogOLS(values: number[]): { m: number; b: number; residuals: number[]; logValues: number[] } {
  const logValues = values.map((v) => Math.log(v + LOG_EPSILON));
  const points: Array<[number, number]> = logValues.map((y, x) => [x, y]);
  const { m, b } = linearRegression(points);
  const residuals = logValues.map((y, x) => y - (m * x + b));
  return { m, b, residuals, logValues };
}

/**
 * Mann-Kendall trend test. Run on the raw (non-log) series: a monotonic
 * log transform cannot change the sign of any pairwise comparison, so the
 * S statistic and p-value are identical to running it on log(share) while
 * sidestepping the log(0) case entirely.
 */
function mannKendall(values: number[]): { S: number; pValue: number } {
  const n = values.length;
  if (n < 2) return { S: 0, pValue: 1 };

  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      S += Math.sign(values[j]! - values[i]!);
    }
  }

  const tieCounts = new Map<number, number>();
  for (const v of values) tieCounts.set(v, (tieCounts.get(v) ?? 0) + 1);
  let tieCorrection = 0;
  for (const t of tieCounts.values()) {
    if (t > 1) tieCorrection += t * (t - 1) * (2 * t + 5);
  }
  const variance = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18;
  if (variance <= 0) return { S, pValue: 1 };

  let z: number;
  if (S > 0) z = (S - 1) / Math.sqrt(variance);
  else if (S < 0) z = (S + 1) / Math.sqrt(variance);
  else z = 0;

  const pValue = 2 * (1 - cumulativeStdNormalProbability(Math.abs(z)));
  return { S, pValue: Math.min(1, Math.max(0, pValue)) };
}

/** Theil-Sen estimator: median of all pairwise slopes. Robust to outliers, used as a cross-check on the OLS slope. */
function senSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      slopes.push((values[j]! - values[i]!) / (j - i));
    }
  }
  return median(slopes);
}

export interface TrendResult {
  /** OLS slope on log(share_per_million), annualized as a compounding % per year. */
  slopePctPerYear: number;
  /** Mann-Kendall two-sided p-value: robust to outliers, does not assume a linear model. */
  pValue: number;
  /** Sen's slope on the same log series, annualized the same way as slopePctPerYear, for robustness comparison. */
  senSlopePctPerYear: number;
  direction: "up" | "down" | "flat";
}

export function computeTrend(values: number[]): TrendResult {
  if (values.length < 2) {
    return { slopePctPerYear: 0, pValue: 1, senSlopePctPerYear: 0, direction: "flat" };
  }

  const { m, logValues } = fitLogOLS(values);
  const slopePctPerYear = (Math.exp(m * 12) - 1) * 100;

  const { pValue } = mannKendall(values);

  const senLogSlope = senSlope(logValues);
  const senSlopePctPerYear = (Math.exp(senLogSlope * 12) - 1) * 100;

  const direction: TrendResult["direction"] = slopePctPerYear > 0 ? "up" : slopePctPerYear < 0 ? "down" : "flat";

  return { slopePctPerYear, pValue, senSlopePctPerYear, direction };
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

export interface Anomaly {
  index: number;
  month: string;
  views: number;
  z: number;
}

// Standard "modified z-score" scaling constant (Iglewicz & Hoaglin) that
// makes a MAD-based deviation comparable to a normal-distribution z-score.
const MODIFIED_Z_SCALE = 0.6745;
const ANOMALY_Z_THRESHOLD = 3;

/** Robust z-score (median/MAD) on the log series detrended by the fitted OLS line; |z| > 3 is an anomaly. */
export function detectAnomalies(series: NormalizedPoint[]): Anomaly[] {
  const shares = series.map((p) => p.sharePerMillion);
  if (shares.length < 2) return [];

  const { residuals } = fitLogOLS(shares);
  const residualMedian = median(residuals);
  const madValue = medianAbsoluteDeviation(residuals);
  if (madValue === 0) return []; // no variability to measure deviation against

  const anomalies: Anomaly[] = [];
  residuals.forEach((r, i) => {
    const z = (MODIFIED_Z_SCALE * (r - residualMedian)) / madValue;
    if (Math.abs(z) > ANOMALY_Z_THRESHOLD) {
      anomalies.push({ index: i, month: series[i]!.month, views: series[i]!.views, z });
    }
  });
  return anomalies;
}

export interface TrendStability {
  direction: TrendResult["direction"];
  anomalies: Anomaly[];
  directionStableWithoutAnomalies: boolean;
  directionStableWithoutLast3Months: boolean;
}

/** Recomputes trend direction with anomalies removed, and with the last 3 months removed, to check robustness. */
export function analyzeTrendStability(series: NormalizedPoint[]): TrendStability {
  const shares = series.map((p) => p.sharePerMillion);
  const baseline = computeTrend(shares);
  const anomalies = detectAnomalies(series);

  let directionStableWithoutAnomalies = true;
  if (anomalies.length > 0) {
    const anomalyIndexes = new Set(anomalies.map((a) => a.index));
    const withoutAnomalies = shares.filter((_, i) => !anomalyIndexes.has(i));
    directionStableWithoutAnomalies = computeTrend(withoutAnomalies).direction === baseline.direction;
  }

  let directionStableWithoutLast3Months = true;
  if (shares.length > 3) {
    const withoutLast3 = shares.slice(0, shares.length - 3);
    directionStableWithoutLast3Months = computeTrend(withoutLast3).direction === baseline.direction;
  }

  return {
    direction: baseline.direction,
    anomalies,
    directionStableWithoutAnomalies,
    directionStableWithoutLast3Months,
  };
}

// ---------------------------------------------------------------------------
// Seasonality
// ---------------------------------------------------------------------------

export interface SeasonalityResult {
  /** max/min ratio of average share_per_million by calendar month; null if too little data to compare. */
  ratio: number | null;
  /** 1-12 (January = 1), or null if no data at all. */
  peakMonth: number | null;
  label: "none" | "weak" | "moderate" | "strong";
}

export function computeSeasonality(series: NormalizedPoint[]): SeasonalityResult {
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  for (const point of series) {
    const monthIndex = Number(point.month.slice(5, 7)) - 1;
    sums[monthIndex] = (sums[monthIndex] ?? 0) + point.sharePerMillion;
    counts[monthIndex] = (counts[monthIndex] ?? 0) + 1;
  }

  const monthlyAverages = sums
    .map((sum, i) => ({ month: i + 1, avg: (counts[i] ?? 0) > 0 ? sum / (counts[i] as number) : null }))
    .filter((v): v is { month: number; avg: number } => v.avg !== null);

  if (monthlyAverages.length < 2) {
    return { ratio: null, peakMonth: monthlyAverages[0]?.month ?? null, label: "none" };
  }

  const max = monthlyAverages.reduce((a, b) => (b.avg > a.avg ? b : a));
  const min = monthlyAverages.reduce((a, b) => (b.avg < a.avg ? b : a));

  if (max.avg <= 0) {
    // every calendar month averages exactly zero: nothing to call a "peak"
    return { ratio: null, peakMonth: null, label: "none" };
  }
  if (min.avg <= 0) {
    return { ratio: null, peakMonth: max.month, label: "strong" };
  }

  const ratio = max.avg / min.avg;
  const label: SeasonalityResult["label"] = ratio < 1.3 ? "none" : ratio < 2 ? "weak" : ratio < 4 ? "moderate" : "strong";
  return { ratio, peakMonth: max.month, label };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "low" | "medium" | "high";

export interface ConfidenceResult {
  level: ConfidenceLevel;
  reasons: string[];
}

export interface ConfidenceInput {
  medianMonthlyViews: number;
  monthCount: number;
  trendPValue: number;
  directionStableWithoutAnomalies: boolean;
  directionStableWithoutLast3Months: boolean;
}

/** Deterministic rules, no model judgment involved. */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const { medianMonthlyViews, monthCount, trendPValue, directionStableWithoutAnomalies, directionStableWithoutLast3Months } =
    input;

  const lowTriggers: string[] = [];
  if (medianMonthlyViews < 100) lowTriggers.push(`median monthly views (${Math.round(medianMonthlyViews)}) is below 100`);
  if (monthCount < 12) lowTriggers.push(`only ${monthCount} months of data (fewer than 12)`);
  if (!directionStableWithoutAnomalies) lowTriggers.push("trend direction flips after removing anomalies");
  if (trendPValue > 0.2) lowTriggers.push(`trend p-value (${trendPValue.toFixed(2)}) is above 0.2`);
  if (lowTriggers.length > 0) return { level: "low", reasons: lowTriggers };

  const isHigh =
    medianMonthlyViews >= 1000 &&
    monthCount >= 24 &&
    trendPValue < 0.05 &&
    directionStableWithoutAnomalies &&
    directionStableWithoutLast3Months;

  if (isHigh) {
    return {
      level: "high",
      reasons: [
        `median monthly views (${Math.round(medianMonthlyViews)}) is at least 1000`,
        `${monthCount} months of data (at least 24)`,
        `trend p-value (${trendPValue.toFixed(2)}) is below 0.05`,
        "trend direction is stable without anomalies and without the last 3 months",
      ],
    };
  }

  const unmetHighCriteria: string[] = [];
  if (medianMonthlyViews < 1000) unmetHighCriteria.push(`median monthly views (${Math.round(medianMonthlyViews)}) is below 1000`);
  if (monthCount < 24) unmetHighCriteria.push(`only ${monthCount} months of data (fewer than 24)`);
  if (trendPValue >= 0.05) unmetHighCriteria.push(`trend p-value (${trendPValue.toFixed(2)}) is not below 0.05`);
  if (!directionStableWithoutLast3Months) unmetHighCriteria.push("trend direction is not stable when the last 3 months are dropped");

  return {
    level: "medium",
    reasons: unmetHighCriteria.length > 0 ? unmetHighCriteria : ["borderline result just short of the high-confidence bar"],
  };
}
