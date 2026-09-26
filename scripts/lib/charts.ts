import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import type { TopLevelSpec } from "vega-lite";

const TEMPLATE_PATH = fileURLToPath(new URL("../../assets/chart-trend.vl.json", import.meta.url));
const ROLLING_WINDOW_MONTHS = 12;

export interface ChartSeriesPoint {
  month: string; // "YYYY-MM"
  value: number; // share_per_million
}

export interface ChartLanguageInput {
  lang: string;
  /** Full normalized series (post-exclude), chronological. */
  points: ChartSeriesPoint[];
  /** Months flagged as anomalies for this language. */
  anomalyMonths: Set<string>;
}

interface SeriesRow {
  lang: string;
  month: string; // ISO date, "YYYY-MM-01"
  value: number;
  kind: "raw" | "rolling";
}

interface AnomalyRow {
  lang: string;
  month: string;
  value: number;
}

function monthToIsoDate(month: string): string {
  return `${month}-01`;
}

/** Trailing mean over up to the last 12 months (fewer at the start of the series). */
function rollingMean(points: ChartSeriesPoint[]): ChartSeriesPoint[] {
  return points.map((p, i) => {
    const window = points.slice(Math.max(0, i - ROLLING_WINDOW_MONTHS + 1), i + 1);
    const mean = window.reduce((sum, w) => sum + w.value, 0) / window.length;
    return { month: p.month, value: mean };
  });
}

function loadTemplate(): TopLevelSpec {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as TopLevelSpec;
}

/**
 * Renders one SVG trend chart covering every requested language: a thin raw
 * line, a thicker 12-month rolling mean, and anomaly points, per
 * assets/chart-trend.vl.json. Rendering is headless (no canvas/DOM).
 */
export async function renderTrendChartSvg(languages: ChartLanguageInput[]): Promise<string> {
  const series: SeriesRow[] = [];
  const anomalies: AnomalyRow[] = [];

  for (const { lang, points, anomalyMonths } of languages) {
    for (const p of points) {
      series.push({ lang, month: monthToIsoDate(p.month), value: p.value, kind: "raw" });
      if (anomalyMonths.has(p.month)) {
        anomalies.push({ lang, month: monthToIsoDate(p.month), value: p.value });
      }
    }
    for (const p of rollingMean(points)) {
      series.push({ lang, month: monthToIsoDate(p.month), value: p.value, kind: "rolling" });
    }
  }

  const template = loadTemplate();
  const spec = {
    ...template,
    datasets: { series, anomalies },
  } as unknown as TopLevelSpec;

  const compiled = vegaLite.compile(spec).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: "none" });
  return view.toSVG();
}
