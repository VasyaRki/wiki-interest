import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cache } from "../scripts/lib/cache.js";
import { langToSiteKey, pickBestCandidate, resolveTopic, type WikidataCandidate } from "../scripts/lib/resolve.js";
import { WikiInterestError } from "../scripts/lib/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
}

function fakeResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body } as unknown as Response;
}

/** Routes wbsearchentities/wbgetentities calls to fixtures by URL substring. */
function stubWikidataFetch(routes: Array<[substring: string, fixture: unknown]>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const route = routes.find(([substring]) => String(url).includes(substring));
    if (!route) throw new Error(`no fixture route for ${url}`);
    return fakeResponse(200, route[1]);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("langToSiteKey applies the normal hyphen->underscore rule", () => {
  assert.equal(langToSiteKey("uk"), "ukwiki");
  assert.equal(langToSiteKey("pl"), "plwiki");
  assert.equal(langToSiteKey("zh-yue"), "zh_yuewiki");
});

test("langToSiteKey applies documented legacy overrides", () => {
  assert.equal(langToSiteKey("be-tarask"), "be_x_oldwiki");
  assert.equal(langToSiteKey("nb"), "nowiki");
});

test("pickBestCandidate: single candidate is always unambiguous", () => {
  const candidates: WikidataCandidate[] = [{ qid: "Q1", label: "foo", description: null }];
  const { best, needsConfirmation } = pickBestCandidate(candidates, "foo");
  assert.equal(best?.qid, "Q1");
  assert.equal(needsConfirmation, false);
});

test("pickBestCandidate: exact top match beats a coincidental exact match further down", () => {
  const candidates: WikidataCandidate[] = (loadFixture("wbsearchentities-astronomy.json") as { search: Array<{ id: string; label: string; description: string }> })
    .search.map((r) => ({ qid: r.id, label: r.label, description: r.description }));
  const { best, needsConfirmation } = pickBestCandidate(candidates, "astronomy");
  assert.equal(best?.qid, "Q333");
  assert.equal(needsConfirmation, false);
});

test("pickBestCandidate: a genuine top-two tie requires confirmation", () => {
  const candidates: WikidataCandidate[] = (loadFixture("wbsearchentities-mercury.json") as { search: Array<{ id: string; label: string; description: string }> })
    .search.map((r) => ({ qid: r.id, label: r.label, description: r.description }));
  const { needsConfirmation } = pickBestCandidate(candidates, "mercury");
  assert.equal(needsConfirmation, true);
});

test("resolveTopic: intermittent fasting for pl,cs,uk returns articles with pl missing", async () => {
  const mock = stubWikidataFetch([
    ["action=wbsearchentities", loadFixture("wbsearchentities-intermittent-fasting.json")],
    ["action=wbgetentities", loadFixture("wbgetentities-Q1666254.json")],
  ]);
  const cache = new Cache(":memory:");
  try {
    const outcome = await resolveTopic(cache, "intermittent fasting", ["pl", "cs", "uk"], "en");
    assert.equal(outcome.needsConfirmation, false);
    assert.equal(outcome.bestQid, "Q1666254");
    assert.deepEqual(outcome.articles, {
      pl: null,
      cs: "Přerušovaný půst",
      uk: "Інтервальне голодування",
    });
  } finally {
    mock.restore();
    cache.close();
  }
});

test("resolveTopic: ambiguous topic returns candidates without fetching sitelinks", async () => {
  const mock = stubWikidataFetch([["action=wbsearchentities", loadFixture("wbsearchentities-mercury.json")]]);
  const cache = new Cache(":memory:");
  try {
    const outcome = await resolveTopic(cache, "mercury", ["en"], "en");
    assert.equal(outcome.needsConfirmation, true);
    assert.equal(outcome.articles, null);
    assert.equal(outcome.candidates.length, 4);
    assert.equal(mock.calls.some((u) => u.includes("wbgetentities")), false, "must not fetch sitelinks when ambiguous");
  } finally {
    mock.restore();
    cache.close();
  }
});

test("resolveTopic: no search results throws a topic_not_found error with a hint", async () => {
  const mock = stubWikidataFetch([["action=wbsearchentities", { search: [] }]]);
  const cache = new Cache(":memory:");
  try {
    await assert.rejects(
      () => resolveTopic(cache, "zzzznonexistentqueryxyz", ["en"], "en"),
      (err: unknown) => {
        assert.ok(err instanceof WikiInterestError);
        assert.equal(err.code, "topic_not_found");
        assert.ok(err.hint.length > 0);
        return true;
      },
    );
  } finally {
    mock.restore();
    cache.close();
  }
});

test("resolveTopic: single unambiguous candidate (EFL) resolves cleanly", async () => {
  const mock = stubWikidataFetch([
    ["action=wbsearchentities", loadFixture("wbsearchentities-efl.json")],
    ["action=wbgetentities", { entities: { Q130192: { sitelinks: { enwiki: { site: "enwiki", title: "English as a second or foreign language" } } } } }],
  ]);
  const cache = new Cache(":memory:");
  try {
    const outcome = await resolveTopic(cache, "English as a second or foreign language", ["en"], "en");
    assert.equal(outcome.needsConfirmation, false);
    assert.equal(outcome.bestQid, "Q130192");
    assert.deepEqual(outcome.articles, { en: "English as a second or foreign language" });
  } finally {
    mock.restore();
    cache.close();
  }
});
