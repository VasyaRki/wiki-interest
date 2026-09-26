import { WikiInterestError } from "./errors.js";
import type { Cache } from "./cache.js";

const PAGEVIEWS_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

/**
 * Wikimedia's User-Agent policy asks for a way to reach the operator of a
 * tool (https://meta.wikimedia.org/wiki/User-Agent_policy). This is not a
 * per-user credential, so no contact info is hardcoded here — every
 * deployment (including this one) must set its own via
 * WIKI_INTEREST_USER_AGENT before real use, e.g.:
 *   WIKI_INTEREST_USER_AGENT="wiki-interest-skill/0.1 (https://github.com/<you>/<repo>; <email or contact URL>)"
 * The fallback below is intentionally generic so nobody else running this
 * skill unknowingly sends a stranger's contact details on every request.
 */
const DEFAULT_USER_AGENT = "wiki-interest-skill/0.1 (contact not configured; set WIKI_INTEREST_USER_AGENT)";
export const USER_AGENT = process.env.WIKI_INTEREST_USER_AGENT ?? DEFAULT_USER_AGENT;

if (USER_AGENT === DEFAULT_USER_AGENT) {
  process.stderr.write(
    "wiki-interest: WIKI_INTEREST_USER_AGENT is not set; using a generic User-Agent (see README). Results are unaffected.\n",
  );
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface PageviewPoint {
  /** "YYYY-MM" */
  month: string;
  views: number;
}

export interface PageviewsFetchResult {
  /** false when the API returned 404 ("no data"), not a crash. */
  found: boolean;
  points: PageviewPoint[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "YYYY-MM" -> "YYYYMM01": the start-of-range date, used for the `from` bound. */
export function monthToApiStartDate(yyyyMm: string): string {
  return `${yyyyMm.replace("-", "")}01`;
}

/**
 * "YYYY-MM" -> the *last* day of that month, used for the `to` bound.
 * The API computes the end month's bucket by summing daily data only up to
 * the exact end date given, not the whole calendar month - passing day 01
 * (as with the `from` bound) yields a near-empty last month instead of the
 * full month's total, silently corrupting the most recent data point.
 */
export function monthToApiEndDate(yyyyMm: string): string {
  const [yearStr, monthStr] = yyyyMm.split("-") as [string, string];
  const lastDay = new Date(Date.UTC(Number(yearStr), Number(monthStr), 0)).getUTCDate();
  return `${yearStr}${monthStr}${String(lastDay).padStart(2, "0")}`;
}

/** Article title -> URL path segment: spaces become underscores, then percent-encoded. */
export function titleToApiSegment(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_"));
}

/** Generic retrying JSON GET with the required User-Agent; shared by the pageviews and Wikidata clients. */
export async function fetchJsonWithRetry(url: string): Promise<{ status: 200 | 404; body: unknown }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new WikiInterestError(
        "network_error",
        `Failed to reach the Wikimedia API: ${err instanceof Error ? err.message : String(err)}`,
        "Check internet connectivity and retry the same command.",
      );
    }

    if (res.status === 404) {
      return { status: 404, body: undefined };
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < MAX_ATTEMPTS) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new WikiInterestError(
        "upstream_unavailable",
        `Wikimedia API returned HTTP ${res.status} after ${MAX_ATTEMPTS} attempts.`,
        "The Wikimedia API is rate-limiting or unavailable; wait a minute and retry the same command.",
      );
    }
    if (!res.ok) {
      throw new WikiInterestError(
        "upstream_error",
        `Wikimedia API returned unexpected HTTP ${res.status} for ${url}`,
        "This looks like a bug in the request; report it rather than retrying.",
      );
    }
    return { status: 200, body: await res.json() };
  }
  // Unreachable: the loop above always returns or throws on its final attempt.
  throw new WikiInterestError(
    "network_error",
    `Failed to reach the Wikimedia API: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    "Check internet connectivity and retry the same command.",
  );
}

interface PageviewsApiResponse {
  items: Array<{ timestamp: string; views: number }>;
}

/** Parses "YYYYMMDDHH" monthly-granularity timestamps into "YYYY-MM" points. */
function parseItems(body: unknown): PageviewPoint[] {
  const items = (body as PageviewsApiResponse).items ?? [];
  return items.map((item) => ({
    month: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(4, 6)}`,
    views: item.views,
  }));
}

async function fetchSeries(cache: Cache, url: string): Promise<PageviewsFetchResult> {
  const cached = cache.get(url);
  if (cached) {
    if (cached.status === "not_found") return { found: false, points: [] };
    return { found: true, points: parseItems(cached.body) };
  }

  const { status, body } = await fetchJsonWithRetry(url);
  if (status === 404) {
    cache.set(url, { status: "not_found" });
    return { found: false, points: [] };
  }
  cache.set(url, { status: "ok", body });
  return { found: true, points: parseItems(body) };
}

/** Per-article monthly views for one language edition, from cache when available. */
export function fetchArticleMonthlyViews(
  cache: Cache,
  lang: string,
  title: string,
  fromMonth: string,
  toMonth: string,
): Promise<PageviewsFetchResult> {
  const url = `${PAGEVIEWS_BASE}/per-article/${lang}.wikipedia/all-access/user/${titleToApiSegment(title)}/monthly/${monthToApiStartDate(fromMonth)}/${monthToApiEndDate(toMonth)}`;
  return fetchSeries(cache, url);
}

/** Project-wide monthly views for one language edition, used to normalize article views. */
export function fetchProjectMonthlyViews(
  cache: Cache,
  lang: string,
  fromMonth: string,
  toMonth: string,
): Promise<PageviewsFetchResult> {
  const url = `${PAGEVIEWS_BASE}/aggregate/${lang}.wikipedia/all-access/user/monthly/${monthToApiStartDate(fromMonth)}/${monthToApiEndDate(toMonth)}`;
  return fetchSeries(cache, url);
}
