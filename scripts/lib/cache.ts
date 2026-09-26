import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Loaded at evaluation time (not as a static import) so the CLI's
// quiet-warnings filter is installed before node:sqlite emits its
// ExperimentalWarning.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** Shared cache/run storage, independent of the caller's folder so cache and `--run` work from anywhere. */
export function getWikiInterestHome(): string {
  if (process.env.WIKI_INTEREST_HOME) return process.env.WIKI_INTEREST_HOME;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "wiki-interest");
}

export function defaultCacheDbPath(): string {
  return join(getWikiInterestHome(), "cache.sqlite");
}

export type CacheEntry = { status: "ok"; body: unknown } | { status: "not_found" };

interface CacheRow {
  status: string;
  body: string | null;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  topic: string | null;
  qids: string[];
  langs: string[];
  from: string;
  to: string;
  exclude: string[];
  articles: Record<string, string[]>;
  /** The full analyze JSON output, stored verbatim so `report` renders exactly what analyze returned. */
  result: unknown;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  topic: string | null;
  qids: string[];
  langs: string[];
  from: string;
  to: string;
}

interface RunRow {
  run_id: string;
  created_at: string;
  topic: string | null;
  qids: string;
  langs: string;
  from_month: string;
  to_month: string;
  exclude_ranges: string;
  articles: string;
  result: string;
}

function randomAlnum(length: number): string {
  const max = 36 ** length;
  return Math.floor(Math.random() * max)
    .toString(36)
    .padStart(length, "0");
}

/** "r_YYYYMMDD_xxxxxx", matching runIdSchema. */
export function generateRunId(now: Date = new Date()): string {
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `r_${stamp}_${randomAlnum(6)}`;
}

/**
 * Thin key/value cache over node:sqlite, keyed by request URL. Holds both
 * successful API responses and "not_found" (404) results, so a topic/period
 * combo with no data is remembered instead of being re-fetched every run.
 */
export class Cache {
  #db: DatabaseSyncType;

  constructor(dbPath: string = defaultCacheDbPath()) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        cache_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        body TEXT,
        fetched_at TEXT NOT NULL
      )
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        topic TEXT,
        qids TEXT NOT NULL,
        langs TEXT NOT NULL,
        from_month TEXT NOT NULL,
        to_month TEXT NOT NULL,
        exclude_ranges TEXT NOT NULL,
        articles TEXT NOT NULL,
        result TEXT NOT NULL
      )
    `);
  }

  get(key: string): CacheEntry | undefined {
    const row = this.#db.prepare("SELECT status, body FROM http_cache WHERE cache_key = ?").get(key) as
      | CacheRow
      | undefined;
    if (!row) return undefined;
    if (row.status === "not_found") return { status: "not_found" };
    return { status: "ok", body: JSON.parse(row.body as string) };
  }

  set(key: string, entry: CacheEntry): void {
    const body = entry.status === "ok" ? JSON.stringify(entry.body) : null;
    this.#db
      .prepare(
        `INSERT INTO http_cache (cache_key, status, body, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run(key, entry.status, body, new Date().toISOString());
  }

  saveRun(run: RunRecord): void {
    this.#db
      .prepare(
        `INSERT INTO runs (run_id, created_at, topic, qids, langs, from_month, to_month, exclude_ranges, articles, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           created_at = excluded.created_at, topic = excluded.topic, qids = excluded.qids,
           langs = excluded.langs, from_month = excluded.from_month, to_month = excluded.to_month,
           exclude_ranges = excluded.exclude_ranges, articles = excluded.articles, result = excluded.result`,
      )
      .run(
        run.runId,
        run.createdAt,
        run.topic,
        JSON.stringify(run.qids),
        JSON.stringify(run.langs),
        run.from,
        run.to,
        JSON.stringify(run.exclude),
        JSON.stringify(run.articles),
        JSON.stringify(run.result),
      );
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      createdAt: row.created_at,
      topic: row.topic,
      qids: JSON.parse(row.qids),
      langs: JSON.parse(row.langs),
      from: row.from_month,
      to: row.to_month,
      exclude: JSON.parse(row.exclude_ranges),
      articles: JSON.parse(row.articles),
      result: JSON.parse(row.result),
    };
  }

  listRuns(limit: number): RunSummary[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as RunRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      topic: row.topic,
      qids: JSON.parse(row.qids),
      langs: JSON.parse(row.langs),
      from: row.from_month,
      to: row.to_month,
    }));
  }

  close(): void {
    this.#db.close();
  }
}
