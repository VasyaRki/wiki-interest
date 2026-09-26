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

test("several processes can write to the shared cache at once (parallel agent sessions)", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "wiki-interest-cache-concurrency-"));
  const dbPath = join(dir, "cache.db");
  const cacheModule = new URL("../scripts/lib/cache.ts", import.meta.url).href;
  const worker = (id: number): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const code = `
        const { Cache } = await import(${JSON.stringify(cacheModule)});
        const cache = new Cache(${JSON.stringify(dbPath)});
        for (let i = 0; i < 300; i++) cache.set("w${id}-" + i, { status: "ok", body: { i } });
        cache.close();
      `;
      const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", code]);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (exitCode) => resolve({ code: exitCode, stderr }));
    });
  try {
    const results = await Promise.all([0, 1, 2, 3].map(worker));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const cache = new Cache(dbPath);
    try {
      assert.deepEqual(cache.get("w3-299"), { status: "ok", body: { i: 299 } });
    } finally {
      cache.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
