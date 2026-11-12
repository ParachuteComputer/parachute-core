/**
 * Hybrid search (T-461 prototype for 0.9.3): keyword (FTS5 bm25) and meaning
 * (vector cosine) ranked lists, fused by reciprocal rank fusion.
 *
 * Pure: no db, no provider. `Store.hybridSearch` runs the two arms and calls
 * `fuseRanks`; this module owns how the keyword arm's query is built and how
 * the two rankings are merged.
 *
 * Why RRF: bm25 scores and cosine similarities live on different scales, so a
 * weighted sum needs per-vault calibration. RRF uses ranks only:
 * score(d) = sum over arms of 1 / (k + rank_arm(d)), k = 60 (Cormack et al.
 * 2009, the value every hybrid-search system since has defaulted to).
 */

import { escapeFtsToken } from "./search-query.js";

export const RRF_K = 60;

/**
 * Whether a search with no `search_mode` is answered by hybrid when it reads as a question (the 0.9.3 "auto" default,
 * T-461). On by default (0.9.3). It is the default only: a call's `search_mode` always wins,
 * and a vault's `search.auto_hybrid` in vault.yaml (true or false, set by an admin over PATCH /api/vault) overrides it.
 * Changing it also changes what `HYBRID_TEXT` says ("the default").
 */
export const HYBRID_AUTO_DEFAULT = true;

/** The effective auto setting: the vault's own `search.auto_hybrid` when set, else `HYBRID_AUTO_DEFAULT`. */
export function effectiveHybridAuto(vaultSetting: boolean | null | undefined): boolean {
  return vaultSetting ?? HYBRID_AUTO_DEFAULT;
}

/** Each arm fetches this many candidates before fusing (the fused page is cut to the caller's `limit`). */
export const HYBRID_POOL = 50;

/**
 * Words too common to carry a keyword match. A natural-language question
 * ("when did I write about feeling stuck at work") would otherwise either fail
 * under literal search (every word must appear) or rank on "I" and "about".
 * Small and English-only on purpose: bm25's idf already discounts the rest.
 */
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him " +
    "himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other " +
    "our ours ourselves out over own same she should so some such than that the their theirs them themselves then there " +
    "these they this those through to too under until up very was we were what when where which while who whom why will " +
    "with would you your yours yourself yourselves ever anything something thing things"
  ).split(" "),
);

/** Lowercase word tokens of `raw`, punctuation stripped, stopwords and duplicates dropped. */
export function keywordTerms(raw: string): string[] {
  const words = raw
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/[^\p{L}\p{N}_'-]+/u)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * The keyword arm's FTS5 query: any of the terms (OR), each phrase-quoted the
 * same way literal mode quotes tokens, so punctuation can't become syntax.
 * bm25 still ranks a note holding more (and rarer) terms first. Empty string
 * when nothing is left to match.
 */
export function anyTermsQuery(raw: string): string {
  return keywordTerms(raw).map(escapeFtsToken).join(" OR ");
}

/**
 * Whether a search reads as a question in plain words (at least 4 words, 2 of them content words), as opposed to an
 * id, a URL, a code, a title or a name ("Garden Plan 2026"). With no search_mode these are answered by hybrid when
 * `HYBRID_AUTO_DEFAULT` is on (the 0.9.3 `auto` default); shorter searches stay literal, so exact lookups and short existence checks are unchanged.
 */
export function isQuestionShaped(raw: string): boolean {
  return raw.trim().split(/\s+/).length >= 4 && keywordTerms(raw).length >= 2;
}

/**
 * The words an AI reads about hybrid search: used by the short tool schemas and the full reference. They stay true
 * when a vault turns auto off ("its auto setting is on (the default)"), so they don't depend on the vault.
 */
export const HYBRID_TEXT = {
  // The line in a tool's description.
  line: '`search`: a question in plain words ("when did I write about…", "have we decided…") is ranked by keyword and meaning together when the vault has meaning search and its auto setting is on (the default); 1–3 words (a name, an id) match exactly. `search_mode: "literal"` forces exact words.',
  // The short schema's `search` parameter.
  param: "Search over title, content and field values. 1–3 words: notes holding every word. A 4+ word question: ranked by keyword and meaning when the vault has meaning search and its auto setting is on (the default)",
  mode: "hybrid: keyword + meaning, for questions in plain words",
  // The reference's `search` parameter (a sentence inside it) and `search_mode` ending.
  refSearch: "Literal for 1–3 words; a 4+ word question is ranked by keyword and meaning together when the vault has meaning search and its auto setting is on (the default; see search_mode)",
  refMode:
    '"hybrid": rank by keyword (any of the content words) and meaning together, fused by rank; each result says `matched_by`; answers keyword-only with a `semantic_unavailable` warning when the vault has no embeddings. With search_mode omitted, a search of 4+ words (2+ content words) on a vault with meaning search, without sort, is answered by hybrid with a `search_auto` warning, unless the vault turned its auto setting off (`search.auto_hybrid` false); shorter searches stay literal; pass "literal" for the exact-words answer. A search_mode you pass always wins over the vault\'s setting. Has no effect without `search` (an `ignored_param` warning fires if you pass it without `search`). Omit for the default (hybrid for a 4+ word question on a vault with meaning search, else literal).',
  hint: 'pass "literal", "advanced" or "hybrid", or omit for the default (hybrid for a 4+ word question on a vault with meaning search, else literal)',
};

export interface FusedHit {
  id: string;
  /** The RRF score: bigger is better. Comparable within one answer only. */
  score: number;
  /** 1-based rank in each arm that found it. */
  ranks: { keyword?: number; meaning?: number };
}

/**
 * Reciprocal rank fusion of ranked id lists (best first). Ties break by best single rank, then the keyword arm
 * first (a keyword #1 tied with a meaning #1 is usually the exact name or code asked for: measured on exact-lookup
 * questions, T-461), then id.
 */
export function fuseRanks(arms: { keyword?: string[]; meaning?: string[] }, k = RRF_K): FusedHit[] {
  const hits = new Map<string, FusedHit>();
  for (const arm of ["keyword", "meaning"] as const) {
    const ids = arms[arm];
    if (!ids) continue;
    ids.forEach((id, i) => {
      const hit = hits.get(id) ?? { id, score: 0, ranks: {} };
      if (hit.ranks[arm] !== undefined) return; // a duplicate id in one arm counts once
      hit.ranks[arm] = i + 1;
      hit.score += 1 / (k + i + 1);
      hits.set(id, hit);
    });
  }
  const best = (h: FusedHit) => Math.min(h.ranks.keyword ?? Infinity, h.ranks.meaning ?? Infinity);
  const kw = (h: FusedHit) => h.ranks.keyword ?? Infinity;
  return [...hits.values()].sort((a, b) => b.score - a.score || best(a) - best(b) || kw(a) - kw(b) || (a.id < b.id ? -1 : 1));
}
