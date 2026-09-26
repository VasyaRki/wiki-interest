import type { Cache } from "./cache.js";
import { fetchJsonWithRetry } from "./fetch.js";
import { WikiInterestError } from "./errors.js";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

/**
 * Wikidata sitelink keys are normally "<lang with '-' -> '_'>wiki", but a
 * handful of language codes changed over time while the sitelink key kept
 * the old form. Extend this map only for confirmed exceptions.
 */
const SITE_KEY_OVERRIDES: Record<string, string> = {
  "be-tarask": "be_x_old", // Belarusian (Taraškievica) kept its pre-2007 code
  nb: "no", // Norwegian Bokmål ships under the plain "no" Wikipedia
};

export function langToSiteKey(lang: string): string {
  const base = SITE_KEY_OVERRIDES[lang] ?? lang.replace(/-/g, "_");
  return `${base}wiki`;
}

export interface WikidataCandidate {
  qid: string;
  label: string;
  description: string | null;
}

interface WbSearchEntitiesResponse {
  search?: Array<{ id: string; label?: string; description?: string }>;
}

interface WbGetEntitiesResponse {
  entities?: Record<
    string,
    {
      missing?: string;
      sitelinks?: Record<string, { site: string; title: string }>;
    }
  >;
  error?: { code: string; info: string };
}

async function fetchJsonCached(cache: Cache, url: string): Promise<unknown> {
  const cached = cache.get(url);
  if (cached && cached.status === "ok") return cached.body;
  const { body } = await fetchJsonWithRetry(url);
  cache.set(url, { status: "ok", body });
  return body;
}

export async function searchWikidata(
  cache: Cache,
  topic: string,
  searchLang: string,
  limit = 7,
): Promise<WikidataCandidate[]> {
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(topic)}&language=${encodeURIComponent(searchLang)}&limit=${limit}&format=json`;
  const body = (await fetchJsonCached(cache, url)) as WbSearchEntitiesResponse;
  return (body.search ?? []).map((r) => ({
    qid: r.id,
    label: r.label ?? r.id,
    description: r.description ?? null,
  }));
}

/**
 * Deterministic disambiguation: pick the top-ranked (Wikidata's own
 * relevance order) candidate as the winner only when it exactly matches the
 * topic string and the runner-up does not also match exactly. A lower-ranked
 * coincidental exact match (e.g. a song called "Astronomy") is ignored, but
 * a genuine top-two tie (e.g. "Mercury" the car brand vs. "Mercury" the
 * commune) forces confirmation instead of a silent guess.
 */
export function pickBestCandidate(
  candidates: WikidataCandidate[],
  topic: string,
): { best: WikidataCandidate | undefined; needsConfirmation: boolean } {
  if (candidates.length === 0) return { best: undefined, needsConfirmation: false };
  if (candidates.length === 1) return { best: candidates[0], needsConfirmation: false };

  const isExact = (c: WikidataCandidate) => c.label.toLowerCase() === topic.toLowerCase();
  const top = candidates[0] as WikidataCandidate;
  const runnerUp = candidates[1];
  const clearWinner = isExact(top) && !(runnerUp && isExact(runnerUp));
  return { best: top, needsConfirmation: !clearWinner };
}

export async function getSitelinkArticles(
  cache: Cache,
  qid: string,
  langs: string[],
): Promise<Record<string, string | null>> {
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=sitelinks|labels|descriptions&format=json`;
  const body = (await fetchJsonCached(cache, url)) as WbGetEntitiesResponse;
  if (body.error) {
    throw new WikiInterestError(
      "wikidata_error",
      `Wikidata could not resolve entity ${qid}: ${body.error.info}`,
      "Run resolve again; the QID may be invalid, merged, or deleted.",
    );
  }
  const entity = body.entities?.[qid];
  if (!entity || entity.missing !== undefined) {
    throw new WikiInterestError(
      "wikidata_error",
      `Wikidata entity ${qid} does not exist.`,
      "Run resolve again to find a valid QID for this topic.",
    );
  }
  const sitelinks = entity.sitelinks ?? {};
  const result: Record<string, string | null> = {};
  for (const lang of langs) {
    result[lang] = sitelinks[langToSiteKey(lang)]?.title ?? null;
  }
  return result;
}

export interface ResolveOutcome {
  candidates: WikidataCandidate[];
  needsConfirmation: boolean;
  bestQid: string | null;
  articles: Record<string, string | null> | null;
}

export async function resolveTopic(
  cache: Cache,
  topic: string,
  langs: string[],
  searchLang: string,
): Promise<ResolveOutcome> {
  const candidates = await searchWikidata(cache, topic, searchLang);
  if (candidates.length === 0) {
    throw new WikiInterestError(
      "topic_not_found",
      `No Wikidata entity found for "${topic}" searching in language "${searchLang}".`,
      "Try a different --search-lang, or rephrase --topic using the concept's common English name.",
    );
  }

  const { best, needsConfirmation } = pickBestCandidate(candidates, topic);
  const articles = !needsConfirmation && best ? await getSitelinkArticles(cache, best.qid, langs) : null;

  return {
    candidates,
    needsConfirmation,
    bestQid: best?.qid ?? null,
    articles,
  };
}
