import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cache } from "../scripts/lib/cache.js";
import {
  fetchArticleMonthlyViews,
  fetchProjectMonthlyViews,
  monthToApiEndDate,
  monthToApiStartDate,
} from "../scripts/lib/fetch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: () => Response | Promise<Response>): { callCount: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return impl();
  }) as typeof fetch;
  return { callCount: () => calls, restore: () => { globalThis.fetch = original; } };
}

test("monthToApiStartDate always uses day 01", () => {
  assert.equal(monthToApiStartDate("2024-02"), "20240201");
  assert.equal(monthToApiStartDate("2024-12"), "20241201");
});

test("monthToApiEndDate uses the true last day of the month, leap years included", () => {
  assert.equal(monthToApiEndDate("2024-02"), "20240229"); // leap year
  assert.equal(monthToApiEndDate("2023-02"), "20230228"); // non-leap year
  assert.equal(monthToApiEndDate("2024-04"), "20240430"); // 30-day month
  assert.equal(monthToApiEndDate("2024-01"), "20240131"); // 31-day month
});

test("regression: the request URL's end bound is the last day of the month, not day 01", async () => {
  // Requesting a monthly range with day-01 end bounds makes the Wikimedia API
  // return a near-empty bucket for the final month (confirmed against the
  // live API: passing 01 as the end day yields ~0 views for a month that
  // actually has full traffic). The URL must ask for the month's last day.
  let requestedUrl = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requestedUrl = String(url);
    return fakeResponse(200, { items: [] });
  }) as typeof fetch;
  const cache = new Cache(":memory:");
  try {
    await fetchArticleMonthlyViews(cache, "en", "Test", "2024-01", "2024-02");
    assert.match(requestedUrl, /\/monthly\/20240101\/20240229$/);
  } finally {
    globalThis.fetch = original;
    cache.close();
  }
});

test("fetchArticleMonthlyViews parses a recorded fixture and caches the result", async () => {
  const fixture = loadFixture("per-article-intermittent-fasting-en.json");
  const mock = stubFetch(() => fakeResponse(200, fixture));
  const cache = new Cache(":memory:");
  try {
    const result = await fetchArticleMonthlyViews(cache, "en", "Intermittent fasting", "2024-01", "2024-03");
    assert.equal(result.found, true);
    assert.deepEqual(result.points, [
      { month: "2024-01", views: 74155 },
      { month: "2024-02", views: 43687 },
      { month: "2024-03", views: 71317 },
    ]);
    assert.equal(mock.callCount(), 1);
  } finally {
    mock.restore();
    cache.close();
  }
});

test("an identical second call is served from cache with zero network requests", async () => {
  const fixture = loadFixture("per-article-intermittent-fasting-en.json");
  const mock = stubFetch(() => fakeResponse(200, fixture));
  const cache = new Cache(":memory:");
  try {
    const first = await fetchArticleMonthlyViews(cache, "en", "Intermittent fasting", "2024-01", "2024-03");
    const second = await fetchArticleMonthlyViews(cache, "en", "Intermittent fasting", "2024-01", "2024-03");
    assert.deepEqual(second, first);
    assert.equal(mock.callCount(), 1, "second identical call must not hit the network");
  } finally {
    mock.restore();
    cache.close();
  }
});

test("fetchProjectMonthlyViews parses the aggregate fixture", async () => {
  const fixture = loadFixture("aggregate-en.json");
  const mock = stubFetch(() => fakeResponse(200, fixture));
  const cache = new Cache(":memory:");
  try {
    const result = await fetchProjectMonthlyViews(cache, "en", "2024-01", "2024-03");
    assert.equal(result.found, true);
    assert.equal(result.points.length, 3);
    assert.equal(result.points[0]?.views, 8684755474);
  } finally {
    mock.restore();
    cache.close();
  }
});

test("a 404 is treated as no data, not an error, and the negative result is cached", async () => {
  const mock = stubFetch(() => fakeResponse(404, undefined));
  const cache = new Cache(":memory:");
  try {
    const first = await fetchArticleMonthlyViews(cache, "en", "Not A Real Article Title Xyz", "2024-01", "2024-03");
    assert.equal(first.found, false);
    assert.deepEqual(first.points, []);

    const second = await fetchArticleMonthlyViews(cache, "en", "Not A Real Article Title Xyz", "2024-01", "2024-03");
    assert.equal(second.found, false);
    assert.equal(mock.callCount(), 1, "cached 404 must not be re-fetched");
  } finally {
    mock.restore();
    cache.close();
  }
});

test("retries on 429 and succeeds once the upstream recovers", async () => {
  const fixture = loadFixture("aggregate-en.json");
  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts < 2 ? fakeResponse(429, undefined) : fakeResponse(200, fixture);
  }) as typeof fetch;
  const cache = new Cache(":memory:");
  try {
    const result = await fetchProjectMonthlyViews(cache, "en", "2024-01", "2024-03");
    assert.equal(result.found, true);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = original;
    cache.close();
  }
});

test("gives up after 3 attempts against a persistent 500 and reports a JSON-friendly error", async () => {
  const mock = stubFetch(() => fakeResponse(500, undefined));
  const cache = new Cache(":memory:");
  try {
    await assert.rejects(
      () => fetchProjectMonthlyViews(cache, "en", "2024-01", "2024-03"),
      (err: unknown) => {
        assert.match((err as Error).message, /HTTP 500/);
        return true;
      },
    );
    assert.equal(mock.callCount(), 3);
  } finally {
    mock.restore();
    cache.close();
  }
});
