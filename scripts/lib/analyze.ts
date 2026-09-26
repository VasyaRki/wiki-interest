import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import { median } from "simple-statistics";
import { type Cache, generateRunId, getWikiInterestHome } from "./cache.js";
import { renderTrendChartSvg, type ChartLanguageInput } from "./charts.js";
import { WikiInterestError } from "./errors.js";
import { fetchArticleMonthlyViews, fetchProjectMonthlyViews, type PageviewsFetchResult } from "./fetch.js";
import {
  analyzeTrendStability,
  buildNormalizedSeries,
  computeConfidence,
  computeSeasonality,
  computeTrend,
  computeYoYGrowth,
  type MonthlyPoint,
  type NormalizedPoint,
  type SeasonalityResult,
} from "./metrics.js";
import { getSitelinkArticles, resolveTopic } from "./resolve.js";
import { analyzeOutputSchema, type AnalyzeOutput } from "./schemas.js";

const MAX_CONCURRENCY = 5;
const DEFAULT_PERIOD_MONTHS = 24;

export interface AnalyzeCliInput {
  qids?: string[] | undefined;
  topic?: string | undefined;
  langs?: string[] | undefined;
  period?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  exclude?: string[] | undefined;
  run?: string | undefined;
}

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

function monthsBefore(month: string, n: number): string {
  const [yearStr, monthStr] = month.split("-");
  const total = Number(yearStr) * 12 + (Number(monthStr) - 1) - n;
  const year = Math.floor(total / 12);
  const mon = (total % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/**
 * The most recent fully-elapsed calendar month. The current month's pageviews
 * are partial (the month isn't over), so a relative --period or the default
 * window must not end there: a partial month reads as a massive, fake drop
 * and gets flagged as an anomaly.
 */
function lastCompleteMonth(now: Date): string {
  const currentMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth(); // 0-based total months, "now"
  const year = Math.floor((currentMonthIndex - 1) / 12);
  const mon = ((currentMonthIndex - 1) % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/** Resolves --period / --from+--to / inherited-from-run / the default (last 24 months), in that priority order. */
export function resolveDateRange(
  input: Pick<AnalyzeCliInput, "period" | "from" | "to">,
  inherited: { from: string; to: string } | undefined,
  now: Date = new Date(),
): { from: string; to: string } {
  if (input.from && input.to) return { from: input.from, to: input.to };
  if (input.period) {
    const n = Number(input.period.replace(/m$/, ""));
    const to = lastCompleteMonth(now);
    return { from: monthsBefore(to, n - 1), to };
  }
  if (inherited) return inherited;
  const to = lastCompleteMonth(now);
  return { from: monthsBefore(to, DEFAULT_PERIOD_MONTHS - 1), to };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function roundSig(n: number, sig: number): number {
  if (n === 0 || !Number.isFinite(n)) return n;
  const magnitude = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(n))));
  return Math.round(n * magnitude) / magnitude;
}

/** Drops months that fall inside any "YYYY-MM:YYYY-MM" exclude range (both ends inclusive). */
export function applyExcludeRanges(series: NormalizedPoint[], excludeRanges: string[]): NormalizedPoint[] {
  if (excludeRanges.length === 0) return series;
  const ranges = excludeRanges.map((r) => {
    const [from, to] = r.split(":") as [string, string];
    return { from, to };
  });
  return series.filter((p) => !ranges.some((r) => p.month >= r.from && p.month <= r.to));
}

/** Sums views across every article in a language's basket, aligned by month. */
export function mergeArticlePoints(pointArrays: MonthlyPoint[][]): MonthlyPoint[] {
  const sums = new Map<string, number>();
  for (const points of pointArrays) {
    for (const p of points) {
      sums.set(p.month, (sums.get(p.month) ?? 0) + p.views);
    }
  }
  return [...sums.entries()].map(([month, views]) => ({ month, views }));
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatSeasonality(s: SeasonalityResult): string {
  if (s.peakMonth === null) return "not enough data to assess seasonality";
  const monthName = MONTH_NAMES[s.peakMonth - 1];
  return `${s.label}, peaks in ${monthName}`;
}

/** Surfaces anomalies in the reasons list so agents relay them alongside confidence. */
function anomalyReasons(stability: ReturnType<typeof analyzeTrendStability>): string[] {
  const n = stability.anomalies.length;
  if (n === 0 || !stability.directionStableWithoutAnomalies) return []; // a flip is already a low-confidence reason
  return [`${n} anomalous month${n === 1 ? "" : "s"} found; trend direction holds without ${n === 1 ? "it" : "them"}`];
}

export function buildSummary(perLanguage: AnalyzeOutput["per_language"], ranking: string[]): string {
  const missing = perLanguage.filter((p) => p.articles.length === 0).map((p) => p.lang);
  const missingSentence =
    missing.length > 0
      ? ` No Wikipedia article exists in ${missing.join(", ")}, so nothing was measured there; this says nothing about interest in ${missing.length === 1 ? "that language" : "those languages"}.`
      : "";

  if (ranking.length === 0) {
    return perLanguage.length === 0
      ? "No data was found for the requested languages."
      : `No data could be measured for this topic in any requested language.${missingSentence}`;
  }
  const topLang = ranking[0] as string;
  const top = perLanguage.find((p) => p.lang === topLang) as AnalyzeOutput["per_language"][number];

  const trendPhrase =
    top.trend_slope_pct_per_year === null
      ? "an unclear trend"
      : top.trend_slope_pct_per_year > 0
        ? `growing interest (+${top.trend_slope_pct_per_year}%/year)`
        : `declining interest (${top.trend_slope_pct_per_year}%/year)`;

  let sentence =
    ranking.length === 1 && perLanguage.length > 1
      ? `${top.lang} is the only language with data (${top.share_per_million} per million views), with ${trendPhrase}, at ${top.confidence} confidence. Its first place is not a win over the other languages, which could not be measured.`
      : `${top.lang} shows the strongest normalized interest (${top.share_per_million} per million views) with ${trendPhrase}, at ${top.confidence} confidence.`;

  if (ranking.length > 1) {
    const secondLang = ranking[1] as string;
    const second = perLanguage.find((p) => p.lang === secondLang);
    if (second) sentence += ` ${second.lang} follows at ${second.share_per_million} per million.`;
  }

  if (top.confidence === "low") {
    sentence += " Treat this as a weak signal only, not a launch recommendation.";
  }

  return sentence + missingSentence;
}

/**
 * Deterministic sentence comparing trend slopes after a `--run` period change,
 * so agents don't compare two runs' numbers themselves (and get the direction wrong).
 */
export function comparePeriods(
  prior: AnalyzeOutput,
  current: AnalyzeOutput["per_language"],
  from: string,
  to: string,
): string {
  const parts: string[] = [];
  for (const cur of current) {
    const prev = prior.per_language.find((p) => p.lang === cur.lang);
    const a = prev?.trend_slope_pct_per_year;
    const b = cur.trend_slope_pct_per_year;
    if (a === null || a === undefined || b === null) continue;
    const fmt = (n: number): string => `${n > 0 ? "+" : ""}${n}%/year`;
    const prevRange = `${prior.question_scope.from}..${prior.question_scope.to}`;
    const curRange = `${from}..${to}`;
    let verdict: string;
    if (Math.sign(a) !== Math.sign(b)) verdict = "the trend direction differs between the two periods";
    else if (Math.abs(a - b) < 5) verdict = "the two periods show a similar rate";
    else verdict = `the rate is ${Math.abs(b) > Math.abs(a) ? "steeper" : "less steep"} over ${curRange} than over ${prevRange}`;
    parts.push(`${cur.lang}: ${fmt(b)} over ${curRange} vs ${fmt(a)} over ${prevRange}; ${verdict}`);
  }
  if (parts.length === 0) return "";
  return ` Compared with the previous run (${prior.run_id}): ${parts.join("; ")}. These are overlapping windows, not a measured change in speed.`;
}

export async function runAnalyze(cache: Cache, input: AnalyzeCliInput, now: Date = new Date()): Promise<AnalyzeOutput> {
  const priorRun = input.run ? cache.getRun(input.run) : undefined;
  if (input.run && !priorRun) {
    throw new WikiInterestError(
      "run_not_found",
      `No stored run with id "${input.run}".`,
      "Run the `runs` command to list available run ids, or omit --run to start a new analysis.",
    );
  }

  // ---- topic/qid basket ----
  let qids: string[];
  let topic: string | null;
  if (input.qids && input.qids.length > 0) {
    qids = input.qids;
    topic = null;
  } else if (input.topic) {
    const langsForResolve = input.langs ?? priorRun?.langs ?? [];
    const outcome = await resolveTopic(cache, input.topic, langsForResolve, "en");
    if (outcome.needsConfirmation || !outcome.bestQid) {
      throw new WikiInterestError(
        "topic_ambiguous",
        `"${input.topic}" matches multiple Wikidata entities.`,
        `Run resolve --topic "${input.topic}" --langs ${langsForResolve.join(",")}, show the candidates to the user, then call analyze again with an explicit --qid.`,
      );
    }
    qids = [outcome.bestQid];
    topic = input.topic;
  } else if (priorRun) {
    qids = priorRun.qids;
    topic = priorRun.topic;
  } else {
    throw new WikiInterestError(
      "invalid_input",
      "One of --qid, --topic, or --run is required.",
      "Provide --qid, --topic, or --run.",
    );
  }

  // ---- languages ----
  const langs = input.langs ?? priorRun?.langs;
  if (!langs || langs.length === 0) {
    throw new WikiInterestError(
      "invalid_input",
      "No languages specified.",
      "Provide --langs, or --run a run that already has languages set.",
    );
  }

  // ---- date range, excludes ----
  const { from, to } = resolveDateRange(input, priorRun ? { from: priorRun.from, to: priorRun.to } : undefined, now);
  const exclude = input.exclude && input.exclude.length > 0 ? input.exclude : (priorRun?.exclude ?? []);

  // ---- articles per language (always re-fetched fresh; cached HTTP calls make this cheap) ----
  const articlesByLang: Record<string, string[]> = Object.fromEntries(langs.map((l) => [l, [] as string[]]));
  for (const qid of qids) {
    const sitelinks = await getSitelinkArticles(cache, qid, langs);
    for (const lang of langs) {
      const title = sitelinks[lang];
      if (title) (articlesByLang[lang] as string[]).push(title);
    }
  }

  // ---- fetch pageviews, capped at 5 concurrent requests across the whole run ----
  const limit = pLimit(MAX_CONCURRENCY);
  const projectFetches = new Map<string, Promise<PageviewsFetchResult>>(
    langs.map((lang) => [lang, limit(() => fetchProjectMonthlyViews(cache, lang, from, to))]),
  );
  const articleFetches = new Map<string, Array<Promise<PageviewsFetchResult>>>(
    langs.map((lang) => [
      lang,
      (articlesByLang[lang] as string[]).map((title) => limit(() => fetchArticleMonthlyViews(cache, lang, title, from, to))),
    ]),
  );

  const perLanguage: AnalyzeOutput["per_language"] = [];
  const chartInputs: ChartLanguageInput[] = [];
  const caveats = new Set<string>();

  for (const lang of langs) {
    const projectResult = await (projectFetches.get(lang) as Promise<PageviewsFetchResult>);
    const titleResults = await Promise.all(articleFetches.get(lang) ?? []);

    const combinedArticlePoints = mergeArticlePoints(titleResults.map((r) => r.points));
    const rawSeries = buildNormalizedSeries(from, to, combinedArticlePoints, projectResult.points);
    const series = applyExcludeRanges(rawSeries, exclude);

    const articles = articlesByLang[lang] as string[];
    if (articles.length === 0) {
      caveats.add(
        `${lang}: no Wikipedia article exists for this topic in this language, so nothing was measured; excluded from the ranking. Do not infer anything about interest in ${lang} from this.`,
      );
      perLanguage.push({
        lang,
        articles,
        avg_monthly_views: null,
        share_per_million: null,
        yoy_growth_raw_pct: null,
        yoy_growth_normalized_pct: null,
        trend_slope_pct_per_year: null,
        trend_p_value: null,
        seasonality: "no data (no article)",
        anomalies: [],
        confidence: "low",
        confidence_reasons: ["no Wikipedia article in this language, so nothing was measured"],
      });
      continue;
    }

    const shares = series.map((p) => p.sharePerMillion);
    const yoy = computeYoYGrowth(series);
    if (yoy.caveat) caveats.add(`${lang}: ${yoy.caveat}`);

    const trend = computeTrend(shares);
    const stability = analyzeTrendStability(series);
    const seasonality = computeSeasonality(series);
    const medianViews = series.length > 0 ? median(series.map((p) => p.views)) : 0;
    const confidence = computeConfidence({
      medianMonthlyViews: medianViews,
      monthCount: series.length,
      trendPValue: trend.pValue,
      directionStableWithoutAnomalies: stability.directionStableWithoutAnomalies,
      directionStableWithoutLast3Months: stability.directionStableWithoutLast3Months,
    });

    const avgViews = series.length > 0 ? series.reduce((s, p) => s + p.views, 0) / series.length : 0;
    const avgShare = series.length > 0 ? series.reduce((s, p) => s + p.sharePerMillion, 0) / series.length : 0;

    perLanguage.push({
      lang,
      articles,
      avg_monthly_views: Math.round(avgViews),
      share_per_million: round1(avgShare),
      yoy_growth_raw_pct: yoy.rawPct === null ? null : round1(yoy.rawPct),
      yoy_growth_normalized_pct: yoy.normalizedPct === null ? null : round1(yoy.normalizedPct),
      trend_slope_pct_per_year: round1(trend.slopePctPerYear),
      trend_p_value: roundSig(trend.pValue, 2),
      seasonality: formatSeasonality(seasonality),
      anomalies: stability.anomalies.map((a) => ({ month: a.month, views: Math.round(a.views), z: round1(a.z) })),
      confidence: confidence.level,
      confidence_reasons: [...confidence.reasons, ...anomalyReasons(stability)],
    });

    chartInputs.push({
      lang,
      points: series.map((p) => ({ month: p.month, value: p.sharePerMillion })),
      anomalyMonths: new Set(stability.anomalies.map((a) => a.month)),
    });
  }

  if (exclude.length > 0) {
    caveats.add(`Excluded months from analysis: ${exclude.join(", ")}.`);
  }
  caveats.add("Pageviews reflect reader interest, not purchase intent or willingness to pay.");

  const ranking = perLanguage
    .filter((p) => p.share_per_million !== null)
    .sort((a, b) => (b.share_per_million ?? 0) - (a.share_per_million ?? 0))
    .map((p) => p.lang);
  let summary = buildSummary(perLanguage, ranking);
  if (priorRun && (priorRun.from !== from || priorRun.to !== to)) {
    const prior = analyzeOutputSchema.safeParse(priorRun.result);
    if (prior.success) summary += comparePeriods(prior.data, perLanguage, from, to);
  }
  const runId = generateRunId(now);

  let chartPath: string | null = null;
  try {
    const svg = await renderTrendChartSvg(chartInputs);
    const runDir = join(getWikiInterestHome(), "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const fullChartPath = join(runDir, "trend.svg");
    writeFileSync(fullChartPath, svg, "utf8");
    chartPath = fullChartPath;
  } catch (err) {
    caveats.add(`Chart generation failed (${err instanceof Error ? err.message : String(err)}); numbers below are still valid.`);
  }

  const output: AnalyzeOutput = {
    ok: true,
    run_id: runId,
    question_scope: { qids, langs, from, to },
    per_language: perLanguage,
    ranking,
    summary,
    caveats: [...caveats],
    chart_path: chartPath,
  };

  cache.saveRun({
    runId,
    createdAt: now.toISOString(),
    topic,
    qids,
    langs,
    from,
    to,
    exclude,
    articles: articlesByLang,
    result: output,
  });

  return output;
}
