import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeInputSchema, langsListSchema, resolveInputSchema } from "../scripts/lib/schemas.js";

test("langsListSchema splits and trims a comma list", () => {
  const langs = langsListSchema.parse("uk, pl,cs");
  assert.deepEqual(langs, ["uk", "pl", "cs"]);
});

test("langsListSchema rejects an invalid language code", () => {
  assert.throws(() => langsListSchema.parse("uk,??"));
});

test("resolveInputSchema requires topic and langs, defaults searchLang", () => {
  const parsed = resolveInputSchema.parse({ topic: "intermittent fasting", langs: "pl,cs" });
  assert.equal(parsed.searchLang, "en");
  assert.deepEqual(parsed.langs, ["pl", "cs"]);
});

test("analyzeInputSchema requires one of qid/topic/run", () => {
  assert.throws(() => analyzeInputSchema.parse({ langs: "pl" }));
  assert.doesNotThrow(() => analyzeInputSchema.parse({ topic: "astronomy", langs: "uk" }));
});

test("analyzeInputSchema rejects --period combined with --from/--to", () => {
  assert.throws(() =>
    analyzeInputSchema.parse({ topic: "astronomy", langs: "uk", period: "24m", from: "2023-01", to: "2024-01" }),
  );
});
