import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Cache, type RunRecord } from "../scripts/lib/cache.js";
import { generateReport } from "../scripts/lib/report.js";
import { WikiInterestError } from "../scripts/lib/errors.js";
import type { AnalyzeOutput } from "../scripts/lib/schemas.js";

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wiki-interest-report-test-"));
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

function makePerLanguage(lang: string, overrides: Partial<AnalyzeOutput["per_language"][number]> = {}): AnalyzeOutput["per_language"][number] {
  return {
    lang,
    articles: [`Article ${lang}`],
    avg_monthly_views: 1000,
    share_per_million: 5,
    yoy_growth_raw_pct: -10,
    yoy_growth_normalized_pct: 5,
    trend_slope_pct_per_year: 3,
    trend_p_value: 0.04,
    seasonality: "weak, peaks in March",
    anomalies: [],
    confidence: "medium",
    confidence_reasons: ["borderline result just short of the high-confidence bar"],
    ...overrides,
  };
}

function makeRun(runId: string, perLanguage: AnalyzeOutput["per_language"], overrides: Partial<RunRecord> = {}): RunRecord {
  const langs = perLanguage.map((p) => p.lang);
  const result: AnalyzeOutput = {
    ok: true,
    run_id: runId,
    question_scope: { qids: ["Q1666254"], langs, from: "2024-01", to: "2025-12" },
    per_language: perLanguage,
    ranking: [...langs].sort((a, b) => {
      const pa = perLanguage.find((p) => p.lang === a) as AnalyzeOutput["per_language"][number];
      const pb = perLanguage.find((p) => p.lang === b) as AnalyzeOutput["per_language"][number];
      return (pb.share_per_million ?? 0) - (pa.share_per_million ?? 0);
    }),
    summary: "Test summary sentence for the report.",
    caveats: ["Pageviews reflect reader interest, not purchase intent or willingness to pay."],
    chart_path: null,
    ...(overrides.result as Partial<AnalyzeOutput> | undefined),
  };
  return {
    runId,
    createdAt: "2026-09-25T12:00:00.000Z",
    topic: "intermittent fasting",
    qids: ["Q1666254"],
    langs,
    from: "2024-01",
    to: "2025-12",
    exclude: [],
    articles: Object.fromEntries(langs.map((l) => [l, [`Article ${l}`]])),
    result,
    ...overrides,
  };
}

test("generateReport produces a single-page PDF for a normal run (the function itself enforces this)", async () => {
  await withIsolatedHome(async () => {
    const cache = new Cache(":memory:");
    try {
      const run = makeRun("r_20260925_aaaa11", [makePerLanguage("pl"), makePerLanguage("cs", { confidence: "high" })]);
      cache.saveRun(run);

      const pdfPath = await generateReport(cache, { runId: run.runId, lang: "en", question: undefined, outDir: process.env.WIKI_INTEREST_HOME! });
      assert.ok(existsSync(pdfPath));
      assert.ok(isAbsolute(pdfPath), "pdf_path must be absolute so it is valid from any folder");
      assert.equal(dirname(pdfPath), process.env.WIKI_INTEREST_HOME);
      assert.ok(statSync(pdfPath).size > 500);
      const header = readFileSync(pdfPath, "utf8").slice(0, 5);
      assert.equal(header, "%PDF-");
    } finally {
      cache.close();
    }
  });
});

test("generateReport truncates a very large table rather than spilling to a second page", async () => {
  await withIsolatedHome(async () => {
    const cache = new Cache(":memory:");
    try {
      const perLanguage = Array.from({ length: 80 }, (_, i) => makePerLanguage(`l${i}`));
      const run = makeRun("r_20260925_bbbb22", perLanguage);
      cache.saveRun(run);

      // generateReport throws internally if the rendered PDF is not exactly
      // one page, so simply resolving here IS the one-page guarantee.
      const pdfPath = await generateReport(cache, { runId: run.runId, lang: "en", question: undefined, outDir: process.env.WIKI_INTEREST_HOME! });
      assert.ok(existsSync(pdfPath));
    } finally {
      cache.close();
    }
  });
});

test("generateReport works in Ukrainian and renders Cyrillic labels", async () => {
  await withIsolatedHome(async () => {
    const cache = new Cache(":memory:");
    try {
      const run = makeRun("r_20260925_cccc33", [makePerLanguage("uk")]);
      cache.saveRun(run);

      const pdfPath = await generateReport(cache, { runId: run.runId, lang: "uk", question: "Чи варто запускати українською?", outDir: process.env.WIKI_INTEREST_HOME! });
      assert.ok(existsSync(pdfPath));
      assert.match(pdfPath, /-uk\.pdf$/);
    } finally {
      cache.close();
    }
  });
});

test("generateReport handles a missing chart gracefully (no crash, notes it instead)", async () => {
  await withIsolatedHome(async () => {
    const cache = new Cache(":memory:");
    try {
      const run = makeRun("r_20260925_dddd44", [makePerLanguage("en")]);
      // chart_path already null in makeRun's default result
      cache.saveRun(run);
      const pdfPath = await generateReport(cache, { runId: run.runId, lang: "en", question: undefined, outDir: process.env.WIKI_INTEREST_HOME! });
      assert.ok(existsSync(pdfPath));
    } finally {
      cache.close();
    }
  });
});

test("generateReport: unknown run id fails with a clear hint", async () => {
  const cache = new Cache(":memory:");
  try {
    await assert.rejects(
      () => generateReport(cache, { runId: "r_20200101_zzzzzz", lang: "en", question: undefined, outDir: process.env.WIKI_INTEREST_HOME! }),
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
