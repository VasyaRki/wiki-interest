import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../scripts/lib/cache.js";

test("cache stores and retrieves an 'ok' entry", () => {
  const cache = new Cache(":memory:");
  try {
    assert.equal(cache.get("k1"), undefined);
    cache.set("k1", { status: "ok", body: { views: 42 } });
    assert.deepEqual(cache.get("k1"), { status: "ok", body: { views: 42 } });
  } finally {
    cache.close();
  }
});

test("cache stores and retrieves a 'not_found' entry", () => {
  const cache = new Cache(":memory:");
  try {
    cache.set("missing", { status: "not_found" });
    assert.deepEqual(cache.get("missing"), { status: "not_found" });
  } finally {
    cache.close();
  }
});

test("cache persists to disk across separate connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-interest-cache-test-"));
  const dbPath = join(dir, "cache.sqlite");
  try {
    const first = new Cache(dbPath);
    first.set("persisted", { status: "ok", body: { views: 7 } });
    first.close();

    const second = new Cache(dbPath);
    assert.deepEqual(second.get("persisted"), { status: "ok", body: { views: 7 } });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
