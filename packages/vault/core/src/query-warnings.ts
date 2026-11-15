/**
 * The `warnings: []` channel (vault#550 — Reliability & Usability Program
 * WS1, "honest queries"). Ratified principle: if the vault can still answer
 * the question asked, answer it and attach a warning; if it would answer a
 * DIFFERENT question, return a structured named error. Silence is never the
 * third option.
 *
 * This module owns the ONE validated choke point for `unknown_tag`
 * warnings — both the REST structured-query path (`src/routes.ts`) and the
 * MCP `query-notes` tool call into `collectUnknownTagWarnings` so the two
 * surfaces can't drift. REST-only warnings (`removed_param` — a REST query
 * string concept with no MCP analog) stay in `src/routes.ts`.
 *
 * Tag-scope note (security review): this module is deliberately
 * SCOPE-UNAWARE — `collectUnknownTagWarnings` always resolves against the
 * full vault-wide tag catalog, exactly like `core/src/notes.ts:queryNotes`
 * itself. Callers on a tag-scoped session MUST NOT surface these warnings
 * (or must first narrow the candidate pool) — `did_you_mean` naming an
 * out-of-scope tag would leak its existence across the scope boundary,
 * which this codebase treats as a hard "no leak" invariant elsewhere (see
 * `docs/contracts/tag-scoped-tokens.md`). `src/routes.ts` skips this call
 * entirely for scoped sessions; `src/mcp-tools.ts`'s `query-notes` wrapper
 * strips any `warnings` core computed before returning to a scoped caller.
 */

import { Database } from "bun:sqlite";
import {
  DEFAULT_TAG_EXPAND_MODE,
  getTagExpansion,
  loadTagHierarchy,
  stripTagHash,
  suggestSimilarTag,
  type TagExpandMode,
  type TagHierarchy,
} from "./tag-hierarchy.js";
import { chunkForInClause } from "./sql-in.js";
import { escapeFtsToken } from "./search-query.js";
import { getIndexedField } from "./indexed-fields.js";
import { isOperatorObject, QueryError } from "./query-operators.js";

export interface QueryWarning {
  code: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Cap on `unknown_tag` warnings per query (vault#550 fold). A caller
 * passing a garbage `tags` array (hundreds of junk names) would otherwise
 * inflate the response — and the REST `X-Parachute-Warnings` header —
 * unboundedly. Past the cap, a single `warnings_truncated` entry reports
 * how many were suppressed.
 */
export const MAX_UNKNOWN_TAG_WARNINGS = 8;

/**
 * Membership counts for a specific set of candidate tag names — NOT a
 * full `listTags()` vault-wide scan. `listTags` additionally computes
 * `expanded_count` (a full `note_tags` pass over EVERY tag, vault#550),
 * which this function deliberately avoids: `collectUnknownTagWarnings` runs
 * on every tag-filtered structured query (a hot path), so paying for a
 * vault-wide rollup just to answer "does tag X have ANY notes" would be a
 * real perf regression. This scopes the `note_tags` scan to only the
 * (typically small) set of names actually reachable from the query's own
 * tag filter and its expansion.
 */
function countMembership(db: Database, names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  if (names.size === 0) return counts;
  for (const chunk of chunkForInClause([...names])) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.prepare(
      `SELECT tag_name, COUNT(*) as c FROM note_tags WHERE tag_name IN (${placeholders}) GROUP BY tag_name`,
    ).all(...chunk) as { tag_name: string; c: number }[];
    for (const row of rows) counts.set(row.tag_name, row.c);
  }
  return counts;
}

/**
 * Warn on each literal tag name in a `tags` filter that can contribute
 * NOTHING to the result set no matter what — the caller almost certainly
 * mistyped it, or is thinking of a different vault. A tag survives (no
 * warning) if ANY of the following holds:
 *
 *   - it has its own identity row (a `tags` table entry — created via
 *     `update-tag` or implicitly by tagging a note), OR
 *   - at least one note literally carries that tag, OR
 *   - its mode-aware expansion (subtypes/namespace/both/exact — whatever
 *     the query's `expand` axis resolves to) contains at least one tag
 *     name that itself has notes.
 *
 * `did_you_mean` names the closest existing tag (case variant, prefix
 * relationship, or small edit distance) when one exists — see
 * `suggestSimilarTag`.
 *
 * Scoped to the POSITIVE `tags` filter only — `excludeTags` is not
 * checked (excluding a nonexistent tag is a harmless no-op, not a sign of
 * a mistaken query) and this does not run under `search=` (out of scope
 * for this wave — see #551).
 *
 * Perf shape (vault#550 fold): this runs on EVERY tag-filtered structured
 * query, so the common all-tags-known case must cost ~nothing. Pass the
 * store's cached `hierarchy` (`Store.getTagHierarchy()` — invalidated on
 * tag writes) so no fresh `tags`-table scan happens per request; the
 * `note_tags` membership query below only runs for input tags MISSING
 * from the identity set (`h.allTags`), which for a well-formed query is
 * none — a tag with an identity row can never warn (`hasIdentity`
 * short-circuits), so there's nothing to look up. The `hierarchy` param
 * stays optional for direct-core callers/tests (falls back to a fresh
 * load).
 */
export function collectUnknownTagWarnings(
  db: Database,
  tags: string[] | undefined,
  expandMode: TagExpandMode | undefined,
  hierarchy?: TagHierarchy,
): QueryWarning[] {
  if (!tags || tags.length === 0) return [];

  const h = hierarchy ?? loadTagHierarchy(db);
  const mode = expandMode ?? DEFAULT_TAG_EXPAND_MODE;

  // Fast path: dedupe inputs and drop every tag with an identity row —
  // those can never warn. For a well-formed query this empties the list
  // and we return without touching the DB at all.
  const suspects: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = stripTagHash(raw);
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    if (h.allTags.has(tag)) continue; // identity row → never unknown
    suspects.push(tag);
  }
  if (suspects.length === 0) return [];

  // Slow path (only for identity-less names): pre-compute each suspect's
  // expansion set (memoized on `h.descendantsCache` — safe to share with
  // the store's cache, entries are pure derived state) so the membership
  // check is ONE batched IN-list query over the union, not one per tag.
  // An identity-less tag can still be "known" two ways: a `note_tags` row
  // exists without a `tags` row (not produced by current writers, but
  // contract-tolerated), or children declared it a parent (`childrenOf`
  // edges exist for undeclared parents) and a descendant has notes.
  const expansions = new Map<string, Set<string>>();
  for (const tag of suspects) expansions.set(tag, getTagExpansion(h, tag, mode));
  const candidateNames = new Set<string>();
  for (const set of expansions.values()) for (const name of set) candidateNames.add(name);
  const counts = countMembership(db, candidateNames);

  const warnings: QueryWarning[] = [];
  let suppressed = 0;
  for (const tag of suspects) {
    const hasOwnMembership = (counts.get(tag) ?? 0) > 0;
    let hasExpansionMembers = false;
    for (const t of expansions.get(tag)!) {
      if ((counts.get(t) ?? 0) > 0) {
        hasExpansionMembers = true;
        break;
      }
    }

    if (!hasOwnMembership && !hasExpansionMembers) {
      if (warnings.length >= MAX_UNKNOWN_TAG_WARNINGS) {
        suppressed++;
        continue;
      }
      const suggestion = suggestSimilarTag(h.allTags, tag);
      warnings.push({
        code: "unknown_tag",
        message: `tag "${tag}" has no identity row and no notes match it (directly or via expansion) — check spelling, or create it first with update-tag`,
        tag,
        ...(suggestion ? { did_you_mean: suggestion } : {}),
      });
    }
  }
  if (suppressed > 0) {
    warnings.push({
      code: "warnings_truncated",
      message: `${suppressed} additional unknown_tag warning(s) suppressed — at most ${MAX_UNKNOWN_TAG_WARNINGS} are reported per query.`,
      suppressed,
      limit: MAX_UNKNOWN_TAG_WARNINGS,
    });
  }
  return warnings;
}

/**
 * `empty_search` warning (vault#551) — the `search` string carried no
 * literal content: blank/whitespace-only, or (in literal mode, where a
 * manually-typed `"` is ordinary content rather than syntax) nothing but
 * quote characters. Rather than let this degenerate into an FTS5 syntax
 * error or a confusing always-empty-but-syntactically-valid query, the
 * search path short-circuits BEFORE ever calling FTS5 and reports this
 * warning alongside an honest `[]`. See `core/src/search-query.ts`
 * `buildLiteralSearchQuery`, which is the choke point that detects this.
 */
export function emptySearchWarning(): QueryWarning {
  return {
    code: "empty_search",
    message:
      "the search query has no literal content (blank, or only whitespace/quote characters) — returning no results without querying FTS5.",
  };
}

/**
 * `ignored_param` warning (vault#551) — a query-shaping param was passed
 * but has no effect given the rest of the request. First (and so far only)
 * case: `search_mode` without `search` — the mode only shapes how `search`
 * text is turned into an FTS5 query, so passing it alone almost always
 * means the caller meant to pass `search` too. Generic over `param` /
 * `reason` so a future ignored-param case can reuse the same shape instead
 * of inventing a new warning code.
 */
export function ignoredParamWarning(param: string, reason: string): QueryWarning {
  return {
    code: "ignored_param",
    message: `\`${param}\` has no effect: ${reason}`,
    param,
  };
}

/**
 * `truncated` warning (vault contracts-brief V1.3) — a structured, non-
 * cursor list query returned exactly `limit` rows with no watermark to page
 * from. That's ambiguous on its own: it might be the whole result set
 * (coincidence), or there might be more rows silently cut off. Combined
 * with the engine's default order (`created_at ASC` — oldest first,
 * core/src/notes.ts) this is the concrete failure mode: a bare `GET
 * /api/notes` on a >limit-note vault returns the OLDEST rows with zero
 * signal that the NEWEST ones didn't make it. `?cursor=` (bootstrap or
 * watermark) sidesteps this entirely — the warning only fires in its
 * absence. Explicit `offset` is also exempt (vault#601): offset-paging is
 * deliberate pagination, not an accidental full default page.
 */
export function truncatedResultsWarning(
  limit: number,
  channel: "rest" | "mcp" = "rest",
): QueryWarning {
  const pageHint =
    channel === "mcp"
      ? `Pass cursor: "" to page, or sort: "desc" for newest-first.`
      : "Pass ?cursor= to page, or sort=desc for newest-first.";
  return {
    code: "truncated",
    message: `${limit} = limit rows returned; there may be more. ${pageHint}`,
    limit,
  };
}

/**
 * Cheap zero-result search suggestion (vault#551 WS2B — mirrors the tag
 * `did_you_mean` above via the SAME `suggestSimilarTag` scorer, just over a
 * different candidate pool). Callers MUST only invoke this AFTER a search
 * already returned zero rows — it is never on the hot non-empty path, so
 * the extra vocabulary scan costs nothing in the overwhelmingly common
 * case where the search actually found something.
 *
 * Candidates are drawn from two cheap-to-reach sources, unioned:
 *
 *   - the FTS5 vocabulary — a `notes_fts_vocab` `fts5vocab('row')` table
 *     created here LAZILY and BEST-EFFORT (not part of the schema/
 *     migration — see the try/catch below) — the terms actually indexed,
 *     POST-tokenization/stemming (porter). The closest CANDIDATE is found
 *     against this stemmed vocabulary (small, deduped, cheap to
 *     range-scan), but a stemmed candidate is never returned verbatim —
 *     see `resolveSurfaceForm` below, which maps it back to a real word
 *     before it's handed to the caller (vault#570 — a raw stem like
 *     "propoli" or "cactu" isn't a word anyone would type).
 *   - tag names, when the caller passes `tagNames` (already cached by the
 *     caller's tag hierarchy — free to include, and already real words —
 *     no de-stemming needed).
 *
 * `fts5vocab` is registered by the same FTS5 extension init as `notes_fts`
 * itself (not a separately-enabled module) so it's expected to be
 * available anywhere search already works — but this is NOT exercised
 * against Cloudflare DO SQLite (flagged for the wire reviewer). The WHOLE
 * function is wrapped in try/catch and degrades to "no suggestion" on ANY
 * failure — including a runtime where `fts5vocab` is unavailable — rather
 * than ever throwing; a spelling hint is a nicety, never worth risking the
 * search response itself.
 *
 * Per-token length filtering (`length(term) BETWEEN len-2 AND len+2`) keeps
 * the vocabulary scan bounded on a large vault without a hardcoded row cap
 * that could silently exclude the very term a caller needs (a `LIMIT`
 * ORDER-BY-frequency would bias toward common words, which is backwards
 * for a name/typo lookup — the word you're trying to find is often rare).
 */
export function computeSearchDidYouMean(
  db: Database,
  rawQuery: string,
  tagNames?: Iterable<string>,
): string | undefined {
  try {
    const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return undefined;

    const tagNameSet = tagNames ? new Set(tagNames) : undefined;

    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_vocab USING fts5vocab(notes_fts, 'row')");
    const exactStmt = db.prepare("SELECT 1 FROM notes_fts_vocab WHERE term = ? LIMIT 1");
    const rangeStmt = db.prepare("SELECT term FROM notes_fts_vocab WHERE length(term) BETWEEN ? AND ?");

    let changed = false;
    const corrected = tokens.map((tok) => {
      // Strip leading/trailing punctuation for the lookup (the FTS5
      // vocabulary never contains punctuation) but leave short tokens
      // (numbers, "a", "of", ...) alone — too little signal to safely
      // "correct" without a high false-positive rate.
      const clean = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (clean.length < 3) return tok;
      const lower = clean.toLowerCase();

      // Already indexed verbatim (post-stemming) — no typo signal.
      if (exactStmt.get(lower)) return tok;

      const lo = Math.max(1, clean.length - 2);
      const hi = clean.length + 2;
      const rows = rangeStmt.all(lo, hi) as { term: string }[];
      const candidates = new Set<string>(rows.map((r) => r.term));
      if (tagNameSet) for (const t of tagNameSet) candidates.add(t);

      const suggestion = suggestSimilarTag(candidates, lower);
      if (!suggestion || suggestion.toLowerCase() === lower) return tok;

      changed = true;
      // A literal tag name is already a real word — return it verbatim. A
      // vocabulary hit, though, came out of the PORTER-STEMMED index, so
      // it's usually a truncated stem ("cactu" for "cactus") rather than a
      // word a user would ever type (vault#570) — recover the real surface
      // form before handing it back.
      if (tagNameSet?.has(suggestion)) return suggestion;
      return resolveSurfaceForm(db, suggestion) ?? suggestion;
    });

    if (!changed) return undefined;
    return corrected.join(" ");
  } catch {
    return undefined;
  }
}

/**
 * Map a porter-stemmed vocabulary term ("cactu") back to the real
 * dictionary word a note actually contains ("cactus") — vault#570 (issue
 * #570's search polish item). `notes_fts` is porter-tokenized, so MATCHing
 * the bare stem finds any note carrying a word that stems to it (the stem
 * came FROM `notes_fts_vocab` in the first place, so at least one match is
 * guaranteed). From there, tokenize that note's own path/content/field text —
 * unstemmed, done here in JS with the same punctuation-stripping rule used
 * above — and return the first token that literally STARTS WITH the stem.
 * This works because Porter's rules are almost entirely suffix-stripping:
 * the stem is near-always a prefix of the original word. Irregular cases
 * (a stem that isn't a literal prefix) are a known, accepted limitation —
 * same class as the porter tokenizer's irregular-plural gap documented in
 * docs/HTTP_API.md — and simply fall back to the raw stem via the caller's
 * `?? suggestion`, never worse than the pre-fix behavior.
 *
 * Bounded to a handful of rows (`LIMIT 5`) and wrapped in try/catch same as
 * the caller — a nicety, never worth risking the search response itself.
 */
function resolveSurfaceForm(db: Database, stem: string): string | undefined {
  try {
    const rows = db
      .prepare("SELECT path, content, fields FROM notes_fts WHERE notes_fts MATCH ? LIMIT 5")
      .all(escapeFtsToken(stem)) as { path: string | null; content: string | null; fields: string | null }[];
    for (const row of rows) {
      const text = `${row.path ?? ""} ${row.content ?? ""} ${row.fields ?? ""}`;
      for (const raw of text.split(/[^\p{L}\p{N}]+/gu)) {
        if (!raw) continue;
        const lower = raw.toLowerCase();
        if (lower.length > stem.length && lower.startsWith(stem)) return lower;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `search_did_you_mean` warning (vault#551 WS2B) — wraps
 * {@link computeSearchDidYouMean}'s suggestion in the standard warning
 * shape, mirroring `unknown_tag`'s `did_you_mean` field. Returns
 * `undefined` (nothing to push) when no suggestion clears the bar — a
 * zero-result search is a perfectly ordinary outcome on its own and does
 * NOT warrant a warning by itself; only an actual spelling suggestion does.
 *
 * Scope-unaware by construction, exactly like `collectUnknownTagWarnings`
 * (see this file's top-of-file doc comment) — the FTS5 vocabulary spans
 * the WHOLE vault regardless of any caller's tag scope. Callers on a
 * tag-scoped session MUST NOT surface this warning directly:
 * `src/mcp-tools.ts`'s `query-notes` wrapper already strips the entire
 * `warnings` array for a scoped caller (so MCP is safe with no extra
 * work); `src/routes.ts` must gate the call itself behind
 * `tagScope.allowed === null`, same as it already does for
 * `collectUnknownTagWarnings`.
 */
export function searchDidYouMeanWarning(rawQuery: string, suggestion: string): QueryWarning {
  return {
    code: "search_did_you_mean",
    message: `no results for "${rawQuery}" — did you mean "${suggestion}"?`,
    query: rawQuery,
    did_you_mean: suggestion,
  };
}

/**
 * `embeddings_pending` warning (semantic search MVP, EXPERIMENTAL —
 * `SEMANTIC-MVP-PLAN.md`) — a `semantic: true` query ran and returned
 * REAL results, but `pending` of the `total_candidates` structured-filter
 * matches have no vector yet for the active embedding model (a fresh
 * note, or the backfill sweep hasn't reached it yet). Attached alongside
 * honest (possibly incomplete) results — NEVER instead of them, and never
 * a silent keyword fallback: the caller always knows it got a partial
 * semantic ranking, not a complete one. Callers only push this when
 * `pending > 0` (the common steady-state case attaches nothing).
 */
export function embeddingsPendingWarning(pending: number, totalCandidates: number): QueryWarning {
  return {
    code: "embeddings_pending",
    message: `${pending} of ${totalCandidates} candidate note(s) have no embedding yet for the active model — results may be incomplete until the backfill catches up.`,
    pending,
    total_candidates: totalCandidates,
  };
}

/** `order_by` values that name a notes column (or a computed degree), never a metadata field: they don't scan. */
export const NATIVE_ORDER_BY: ReadonlySet<string> = new Set(["created_at", "updated_at", "link_count"]);

/**
 * The fields a structured query will scan rather than read from an index
 * (0.9.2 "filter any field"): a `metadata` operator object, `orderBy` or
 * `dateFilter.field` naming a field that isn't indexed. Mirrors the routing in
 * `notes.ts:buildFilterConditions` and `queryNotes`'s order_by, so the warning
 * appears exactly when a scan runs. Bare `{field: value}` equality is left
 * out: it has always read the JSON, and stays unwarned.
 */
export function scanFields(
  db: Database,
  opts: { metadata?: Record<string, unknown>; orderBy?: string; dateFilter?: { field?: string } },
): string[] {
  const fields = new Set<string>();
  for (const [key, value] of Object.entries(opts.metadata ?? {})) {
    if (isOperatorObject(value) && !getIndexedField(db, key)) fields.add(key);
  }
  const ob = opts.orderBy;
  if (ob && !NATIVE_ORDER_BY.has(ob) && !getIndexedField(db, ob)) fields.add(ob);
  const df = opts.dateFilter?.field;
  if (df && df !== "created_at" && df !== "updated_at" && !getIndexedField(db, df)) fields.add(df);
  return [...fields];
}

/**
 * `scan`: the query read every record its other filters left, because it
 * filtered or sorted on fields that aren't indexed. It carries no tag or
 * record information (only the caller's own field names), so it is safe on a
 * tag-scoped session. On cloud a scan is billed as rows read; the warning is
 * how a caller (or its developer) learns which fields to index.
 */
export function collectScanWarnings(
  db: Database,
  opts: { metadata?: Record<string, unknown>; orderBy?: string; dateFilter?: { field?: string } },
): QueryWarning[] {
  const fields = scanFields(db, opts);
  if (fields.length === 0) return [];
  const names = fields.map((f) => `"${f}"`).join(", ");
  return [
    {
      code: "scan",
      message: `${names} ${fields.length === 1 ? "isn't" : "aren't"} indexed, so this query read every record to answer. It's correct, only slower on a large vault. To make it fast, declare the field indexed: true on its type (a "number" field can't be indexed: store an integer instead).`,
      fields,
    },
  ];
}

/**
 * An aggregate reply is a bare `[{group, value}]` list with no warnings
 * channel, so it doesn't scan: a `metadata` operator or `date_filter` on a
 * field that isn't indexed is refused there, as it always was. Called by
 * `aggregateNotes` and by the REST and MCP aggregate paths before their
 * tag-scoped branch (which lists the matching notes first, then aggregates
 * their ids).
 */
export function assertNoAggregateScan(
  db: Database,
  opts: { metadata?: Record<string, unknown>; dateFilter?: { field?: string } },
): void {
  const fields = scanFields(db, { metadata: opts.metadata, dateFilter: opts.dateFilter });
  if (fields.length === 0) return;
  throw new QueryError(
    `metadata field "${fields[0]}" is not indexed. aggregate needs every field it filters on to be indexed: declare it via update-tag with indexed: true, or run the same filter without aggregate (a list scans any field).`,
    "FIELD_NOT_INDEXED",
    { error_type: "field_not_indexed", field: fields[0], hint: `declare ${fields.map((f) => `"${f}"`).join(", ")} indexed: true, or drop aggregate` },
  );
}

