import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../scripts/lib/cache.js";
import { WikiInterestError } from "../scripts/lib/errors.js";
import { monthRange, type NormalizedPoint } from "../scripts/lib/metrics.js";
import {
  applyExcludeRanges,
  buildSummary,
  formatSeasonality,
  mergeArticlePoints,
  resolveDateRange,
  round1,
  roundSig,
  runAnalyze,
} from "../scripts/lib/analyze.js";
import type { AnalyzeOutput } from "../scripts/lib/schemas.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("resolveDateRange: explicit --from/--to wins over everything", () => {
  const range = resolveDateRange({ from: "2020-01", to: "2020-06", period: "24m" }, { from: "2019-01", to: "2019-12" });
  assert.deepEqual(range, { from: "2020-01", to: "2020-06" });
});

test("resolveDateRange: --period is relative to now and overrides inherited settings", () => {
  const now = new Date(Date.UTC(2026, 8, 25)); // 2026-09-25
  const range = resolveDateRange({ period: "12m" }, { from: "2019-01", to: "2019-12" }, now);
  // ends at the last *complete* month (Aug), not the in-progress current month (Sep)
  assert.deepEqual(range, { from: "2025-09", to: "2026-08" });
});

test("resolveDateRange: inherits from a prior run when nothing is specified this call", () => {
  const range = resolveDateRange({}, { from: "2019-01", to: "2019-12" });
  assert.deepEqual(range, { from: "2019-01", to: "2019-12" });
});

test("resolveDateRange: defaults to the last 24 months when there is nothing to inherit", () => {
  const now = new Date(Date.UTC(2026, 8, 25));
  const range = resolveDateRange({}, undefined, now);
  assert.deepEqual(range, { from: "2024-09", to: "2026-08" });
});

test("round1 and roundSig", () => {
  assert.equal(round1(11.949), 11.9);
  assert.equal(round1(-4.149), -4.1);
  assert.equal(roundSig(0.0020000000000000018, 2), 0.002);
  assert.equal(roundSig(0.03, 2), 0.03);
  assert.equal(roundSig(0, 2), 0);
});

test("applyExcludeRanges drops months inside the range, keeps everything else", () => {
  const series: NormalizedPoint[] = monthRange("2024-01", "2024-06").map((month) => ({
    month,
    views: 100,
    projectViews: 1000,
    sharePerMillion: 100_000,
  }));
  const filtered = applyExcludeRanges(series, ["2024-03:2024-04"]);
  assert.deepEqual(filtered.map((p) => p.month), ["2024-01", "2024-02", "2024-05", "2024-06"]);
});

test("mergeArticlePoints sums views across multiple articles in a basket by month", () => {
  const merged = mergeArticlePoints([
    [{ month: "2024-01", views: 100 }, { month: "2024-02", views: 50 }],
    [{ month: "2024-01", views: 10 }],
  ]);
  assert.deepEqual(
    merged.sort((a, b) => a.month.localeCompare(b.month)),
    [{ month: "2024-01", views: 110 }, { month: "2024-02", views: 50 }],
  );
});

test("formatSeasonality formats a normal result and handles the no-data case", () => {
  assert.equal(formatSeasonality({ ratio: 5, peakMonth: 1, label: "strong", offsets: null }), "strong, peaks in January");
  assert.equal(
    formatSeasonality({ ratio: null, peakMonth: null, label: "none", offsets: null }),
    "not enough data to assess seasonality (needs at least 24 months)",
  );
});

test("buildSummary mentions the top-ranked language and flags low confidence", () => {
  const perLanguage: AnalyzeOutput["per_language"] = [
    {
      lang: "pl",
      articles: ["X"],
      avg_monthly_views: 100,
      share_per_million: 50,
      yoy_growth_raw_pct: null,
      yoy_growth_normalized_pct: null,
      trend_slope_pct_per_year: 10,
      trend_p_value: 0.5,
      seasonality: "none",
      anomalies: [],
      confidence: "low",
      confidence_reasons: [],
    },
  ];
  const summary = buildSummary(perLanguage, ["pl"]);
  assert.match(summary, /^pl: 50 per million views/);
  assert.doesNotMatch(summary, /strongest/);
  assert.match(summary, /weak signal/);
});

test("buildSummary with rankBy=growth describes the trend, not the share level", () => {
  const row = (lang: string, share: number, slope: number): AnalyzeOutput["per_language"][number] => ({
    lang,
    articles: ["X"],
    avg_monthly_views: 1000,
    share_per_million: share,
    yoy_growth_raw_pct: null,
    yoy_growth_normalized_pct: null,
    trend_slope_pct_per_year: slope,
    trend_p_value: 0.01,
    seasonality: "none",
    anomalies: [],
    confidence: "medium",
    confidence_reasons: [],
  });
  const perLanguage = [row("uk", 13.7, -51.6), row("pl", 7.8, -26.2)];
  const summary = buildSummary(perLanguage, ["pl", "uk"], "growth");
  assert.match(summary, /^Ranked by trend: pl shows the slowest normalized decline \(-26\.2%\/year/);
  assert.match(summary, /uk follows at -51\.6%\/year/);
});

// ---------------------------------------------------------------------------
// Integration: runAnalyze against a mocked network
// ---------------------------------------------------------------------------

/** runAnalyze writes a chart file under WIKI_INTEREST_HOME; isolate that to a temp dir per test. */
async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wiki-interest-analyze-test-"));
  const previous = process.env.WIKI_INTEREST_HOME;
  process.env.WIKI_INTEREST_HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WIKI_INTEREST_HOME;
    else process.env.WIKI_INTEREST_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body } as unknown as Response;
}

function extractDates(url: string): [string, string] {
  const match = url.match(/\/monthly\/(\d{8})\/(\d{8})$/);
  if (!match) throw new Error(`cannot parse date range from ${url}`);
  return [match[1] as string, match[2] as string];
}

function apiDateToMonth(apiDate: string): string {
  return `${apiDate.slice(0, 4)}-${apiDate.slice(4, 6)}`;
}

function makePageviewsBody(startDate: string, endDate: string, viewsFor: (month: string) => number) {
  const months = monthRange(apiDateToMonth(startDate), apiDateToMonth(endDate));
  return { items: months.map((m) => ({ timestamp: `${m.replace("-", "")}0100`, views: viewsFor(m) })) };
}

interface AnalyzeMockOptions {
  sitelinks: Record<string, unknown>; // qid -> wbgetentities response body
  articleViews?: (lang: string, title: string, month: string) => number;
  projectViews?: (lang: string, month: string) => number;
}

function stubAnalyzeNetwork(opts: AnalyzeMockOptions) {
  const original = globalThis.fetch;
  const articleViews = opts.articleViews ?? (() => 1000);
  const projectViews = opts.projectViews ?? (() => 1_000_000);
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("action=wbgetentities")) {
      const qid = (u.match(/ids=([^&]+)/)?.[1] as string) ?? "";
      const body = opts.sitelinks[qid];
      if (!body) throw new Error(`no sitelinks fixture for ${qid}`);
      return fakeResponse(200, body);
    }
    if (u.includes("/per-article/")) {
      const lang = u.match(/per-article\/([a-z0-9_-]+)\.wikipedia/)?.[1] as string;
      const titleSegment = u.match(/user\/([^/]+)\/monthly/)?.[1] as string;
      const title = decodeURIComponent(titleSegment).replace(/_/g, " ");
      const [startDate, endDate] = extractDates(u);
      return fakeResponse(200, makePageviewsBody(startDate, endDate, (m) => articleViews(lang, title, m)));
    }
    if (u.includes("/aggregate/")) {
      const lang = u.match(/aggregate\/([a-z0-9_-]+)\.wikipedia/)?.[1] as string;
      const [startDate, endDate] = extractDates(u);
      return fakeResponse(200, makePageviewsBody(startDate, endDate, (m) => projectViews(lang, m)));
    }
    throw new Error(`unhandled URL in analyze test mock: ${u}`);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

test("runAnalyze: two languages, one missing an article, ranks and caveats correctly", async () => {
  await withIsolatedHome(async () => {
    const mock = stubAnalyzeNetwork({
      sitelinks: {
        Q1: { entities: { Q1: { sitelinks: { enwiki: { site: "enwiki", title: "Test Article" } } } } },
      },
      articleViews: (lang) => (lang === "en" ? 5000 : 0),
      projectViews: () => 1_000_000,
    });
    const cache = new Cache(":memory:");
    try {
      const now = new Date(Date.UTC(2026, 8, 25));
      const result = await runAnalyze(cache, { qids: ["Q1"], langs: ["en", "pl"], period: "24m" }, now);

      assert.equal(result.ok, true);
      assert.match(result.run_id, /^r_\d{8}_[a-z0-9]+$/);
      assert.deepEqual(result.question_scope, { qids: ["Q1"], langs: ["en", "pl"], from: "2024-09", to: "2026-08", rank_by: "level" });

      const en = result.per_language.find((p) => p.lang === "en");
      const pl = result.per_language.find((p) => p.lang === "pl");
      assert.equal(en?.articles.length, 1);
      assert.equal(pl?.articles.length, 0);
      assert.equal(pl?.trend_slope_pct_per_year, null, "no article => trend fields are null, not a misleading 0%");

      assert.deepEqual(result.ranking, ["en"], "languages without an article are excluded from the ranking");
      assert.equal(pl?.share_per_million, null, "no article => no invented 0 share");
      assert.equal(pl?.avg_monthly_views, null);
      assert.deepEqual(pl?.confidence_reasons, ["no Wikipedia article in this language, so nothing was measured"]);
      assert.match(result.summary, /only language with data/);
      assert.match(result.summary, /No Wikipedia article exists in pl/);
      assert.doesNotMatch(result.summary, /pl follows/);
      assert.ok(result.caveats.some((c) => c.includes("pl") && c.includes("no Wikipedia article")));
      assert.ok(result.chart_path, "chart should have been generated");

      // the run must be persisted for `runs` and `report`
      const stored = cache.getRun(result.run_id);
      assert.ok(stored);
      assert.deepEqual(stored?.langs, ["en", "pl"]);
    } finally {
      mock.restore();
      cache.close();
    }
  });
});

test("runAnalyze: --run inherits settings and applies only the new override", async () => {
  await withIsolatedHome(async () => {
    const mock = stubAnalyzeNetwork({
      sitelinks: {
        Q1: {
          entities: {
            Q1: {
              sitelinks: {
                enwiki: { site: "enwiki", title: "Test Article" },
                plwiki: { site: "plwiki", title: "Artykuł testowy" },
              },
            },
          },
        },
      },
    });
    const cache = new Cache(":memory:");
    try {
      const now = new Date(Date.UTC(2026, 8, 25));
      const first = await runAnalyze(
        cache,
        { qids: ["Q1"], langs: ["en"], from: "2023-01", to: "2024-12", rankBy: "growth" },
        now,
      );

      // Follow-up: "now add Polish" - only --langs given, everything else should be inherited.
      const second = await runAnalyze(cache, { run: first.run_id, langs: ["en", "pl"] }, now);

      assert.equal(second.question_scope.from, "2023-01");
      assert.equal(second.question_scope.to, "2024-12");
      assert.deepEqual(second.question_scope.qids, ["Q1"]);
      assert.equal(second.question_scope.rank_by, "growth");
      assert.deepEqual(
        second.per_language.map((p) => p.lang).sort(),
        ["en", "pl"],
      );
      assert.notEqual(second.run_id, first.run_id, "a follow-up creates a new run, preserving the original");
    } finally {
      mock.restore();
      cache.close();
    }
  });
});

test("runAnalyze: --run with an unknown id fails with a clear hint", async () => {
  const cache = new Cache(":memory:");
  try {
    await assert.rejects(
      () => runAnalyze(cache, { run: "r_20200101_zzzzzz" }),
      (err: unknown) => {
        assert.ok(err instanceof WikiInterestError);
        assert.equal(err.code, "run_not_found");
        return true;
      },
    );
  } finally {
    cache.close();
  }
});

test("comparePeriods: states which window is steeper, deterministically", async () => {
  const { comparePeriods } = await import("../scripts/lib/analyze.js");
  const row = (slope: number | null) => ({
    lang: "cs", articles: ["X"], avg_monthly_views: 1, share_per_million: 1,
    yoy_growth_raw_pct: null, yoy_growth_normalized_pct: null,
    trend_slope_pct_per_year: slope, trend_p_value: 0.01, seasonality: "", anomalies: [],
    confidence: "medium" as const, confidence_reasons: [],
  });
  const prior = {
    ok: true as const, run_id: "r_20260926_aaaa",
    question_scope: { qids: ["Q1"], langs: ["cs"], from: "2024-09", to: "2026-08" },
    per_language: [row(-45.7)], ranking: ["cs"], summary: "", caveats: [], chart_path: null,
  };
  const text = comparePeriods(prior, [row(-30.9)], "2021-09", "2026-08");
  assert.match(text, /less steep over 2021-09\.\.2026-08 than over 2024-09\.\.2026-08/);
  assert.equal(comparePeriods(prior, [row(null)], "2021-09", "2026-08"), "");
});
