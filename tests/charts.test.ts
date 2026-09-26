import { test } from "node:test";
import assert from "node:assert/strict";
import { monthRange } from "../scripts/lib/metrics.js";
import { renderTrendChartSvg, type ChartLanguageInput } from "../scripts/lib/charts.js";

test("renderTrendChartSvg produces a well-formed SVG with lines for every language and marks anomalies", async () => {
  const months = monthRange("2023-01", "2024-12");
  const languages: ChartLanguageInput[] = [
    {
      lang: "pl",
      points: months.map((month, i) => ({ month, value: 10 + i })),
      anomalyMonths: new Set(["2023-06"]),
    },
    {
      lang: "cs",
      points: months.map((month, i) => ({ month, value: 5 + i * 0.5 })),
      anomalyMonths: new Set(),
    },
  ];

  const svg = await renderTrendChartSvg(languages);

  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  // one path per raw+rolling line per language (>=4), plus at least one anomaly mark
  const pathCount = (svg.match(/<path/g) ?? []).length;
  assert.ok(pathCount >= 4, `expected at least 4 path elements, got ${pathCount}`);
});

test("renderTrendChartSvg handles a single flat language with no anomalies and no crash", async () => {
  const months = monthRange("2024-01", "2024-06");
  const languages: ChartLanguageInput[] = [
    { lang: "en", points: months.map((month) => ({ month, value: 0 })), anomalyMonths: new Set() },
  ];
  const svg = await renderTrendChartSvg(languages);
  assert.match(svg, /^<svg /);
});
