/**
 * `vault doctor` — read-only taxonomy/metadata integrity scan (vault#552).
 *
 * NOT to be confused with `parachute-vault doctor` (the CLI's install/daemon
 * diagnostic in `src/cli.ts` — port reachability, config sanity, launchd/
 * systemd registration). This module answers a different question: "did my
 * tag reorg (rename/merge/delete) leak?" It never auto-fixes — every finding
 * carries a suggested `remedy` the caller applies deliberately (usually via
 * `rename-tag`/`merge-tags`/`prune-schema`/another `update-tag` call).
 *
 * Scans:
 *   - `dangling_parent_name`   — a `parent_names` entry naming a tag with no
 *     identity row.
 *   - `parent_names_cycle`     — a tag that reaches itself through its
 *     declared ancestor chain (traversal is cycle-safe; this just SURFACES
 *     data that predates the vault#552 write-time cycle guard, or was
 *     written by a path that bypasses it).
 *   - `mixed_type_indexed_field` — a note whose `metadata.<field>` JSON type
 *     disagrees with the field's declared indexed sqlite type. This is the
 *     WS4 typed-index "poison precursor": inconsistent column affinity
 *     coercion silently breaks ordering/comparison across rows. The finding
 *     shape here is intentionally reusable as WS4's migration pre-flight.
 *   - `orphaned_indexed_field_declarer` — an `indexed_fields` row naming a
 *     declarer tag with no `tags` row (overlaps `prune-schema`, which is the
 *     suggested remedy).
 *   - `dead_tag_metadata_reference` — HEURISTIC, always labeled `heuristic:
 *     true`. A metadata key is used elsewhere in the vault with values that
 *     ARE live tag names (establishing "this key holds tag-shaped values");
 *     a value under the same key that does NOT match any live tag is
 *     flagged as a possible stale reference to a renamed/merged/deleted tag
 *     — the PM's `metadata.epic` drift class from the #552 write-up. Vault
 *     has no history of past tag names, so this can never be certain —
 *     hence heuristic. Skips any key declared as an ENUM field on any tag
 *     schema (vault#570) — an enum is a closed, schema-governed vocabulary
 *     (drift there already surfaces as `enum_mismatch` validation, not this
 *     heuristic), so one enum value coincidentally matching an unrelated
 *     live tag name (e.g. a `status` enum with `"active"`/`"archived"`/
 *     `"done"` where some other tag happens to be named "archived") no
 *     longer drags the enum's OTHER legitimate values into a false
 *     "stale tag reference" finding.
 *
 *   - `mixed_type_field`        — (0.9.2) a field that ISN'T indexed, declared
 *     or not, holding values of more than one data type (string, number,
 *     boolean, array, object). Indexed fields keep their own finding above.
 *   - `declared_reference_gap`  — (0.9.2) a field whose text values name an
 *     existing record (its path, `[[path]]`, or id) in most records that
 *     carry it, but that no type declares `reference`.
 *   - `near_names`              — (0.9.2) two type names, or two field names,
 *     one edit apart (case aside). Advice only (`info`): `meeting` and
 *     `meetings` may both be meant.
 *
 *   The three 0.9.2 scans read every record's metadata once each (json_each);
 *   timed at 94k records, about 0.6 s and 0.5 s on a box.
 *
 * Tag-scope (vault#552): pass `allowedTags` (the caller's EXPANDED
 * allowlist, e.g. from `expandTokenTagScope`) to restrict every finding to
 * in-scope tags/fields/notes. `null` (or omitted) — the default — scans the
 * whole vault. The scan is re-run with the allowlist rather than filtering
 * an unscoped result afterward, so the `summary` counts never leak
 * out-of-scope activity.
 */

import { historyTablesPresent, deletedHistoryStats, historyStorageStats, topNotesByHistoryBytes } from "./history.js";
import { readCompactState, type CompactState } from "./history-compact-state.js";
import { Database } from "bun:sqlite";
import { loadTagHierarchy, findHierarchyCycles, levenshtein } from "./tag-hierarchy.js";
import { listIndexedFields } from "./indexed-fields.js";
import { pruneOrphanedIndexedFields } from "./indexed-fields.js";
import { loadSchemaConfig } from "./schema-defaults.js";
import { readBlobContent, hashContent, HistoryDeltaOrphanError } from "./history.js";
import { typeKindReport, KIND_SQL } from "./tag-kind.js";

function scanCompactStateDrift(db: Database): DoctorFinding[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_compact_state'").get()) return [];
  const sample = db.prepare("SELECT note_id,versions,stored,live FROM history_compact_state ORDER BY stored DESC LIMIT 200").all() as CompactState[];
  const drift = sample.filter(row => {
    const actual = readCompactState(db, row.note_id);
    return !actual || actual.versions !== row.versions || actual.stored !== row.stored || actual.live !== row.live;
  }).length;
  return drift ? [{ type: "history_compact_state_drift", severity: "warning", subject: "history compaction scheduling hints",
    detail: `${drift} of ${sample.length} sampled hint rows differ from history. Sample is bounded to the 200 largest hints; this is not a full audit.`,
    remedy: "Investigate missed history-write refreshes. Self-hosted: history rebuild-state --vault <name>. Cloud: deploy a core-pin migration that rebuilds hints; no operator repair API. This scan does not repair them." }] : [];
}

export interface HistoryAuditPage {
  checked: number;
  corrupt: number;
  examples: string[];
  complete: boolean;
  next_after: string | null;
}

/** Read-only keyset page. Budgets apply between blobs, not inside one decode.
 * A sequence of pages is not a snapshot: use a consistent backup for a complete audit.
 */
export function auditHistoryBlobs(db: Database, after = "", maxBlobs = 100, budgetMs = 250): HistoryAuditPage {
  if (after !== "" && !/^[a-f0-9]{64}$/.test(after)) throw new Error("history_after must be a SHA-256 hash");
  if (!Number.isInteger(maxBlobs) || maxBlobs < 1 || maxBlobs > 500) throw new Error("history_max_blobs must be an integer from 1 to 500");
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 1000) throw new Error("history_budget_ms must be an integer from 1 to 1000");
  const page: HistoryAuditPage = { checked: 0, corrupt: 0, examples: [], complete: true, next_after: null };
  if (!historyTablesPresent(db)) return page;
  const start = performance.now();
  const rows = db.prepare("SELECT hash FROM note_blobs WHERE hash > ? ORDER BY hash LIMIT ?").all(after, maxBlobs + 1) as { hash: string }[];
  let cursor = after;
  for (const row of rows) {
    if (page.checked >= maxBlobs || (page.checked > 0 && performance.now() - start >= budgetMs)) {
      page.complete = false;
      page.next_after = cursor;
      break;
    }
    let damaged = false;
    try {
      const body = readBlobContent(db, row.hash);
      damaged = body === null || hashContent(body) !== row.hash;
    } catch (error) {
      // Operational database failures must abort, not masquerade as corruption.
      if (!(error instanceof HistoryDeltaOrphanError)) throw error;
      damaged = true;
    }
    page.checked++;
    cursor = row.hash;
    if (damaged) { page.corrupt++; if (page.examples.length < 5) page.examples.push(row.hash); }
  }
  return page;
}

export type DoctorFindingType =
  | "dangling_parent_name"
  | "parent_names_cycle"
  | "mixed_type_indexed_field"
  | "orphaned_indexed_field_declarer"
  | "dead_tag_metadata_reference"
  | "deleted_note_history"
  | "history_storage"
  | "history_delta_orphan"
  | "history_content_audit"
  | "history_compact_state_drift"
  | "tag_used_like_type"
  | "mixed_type_field"
  | "declared_reference_gap"
  | "near_names";

export type DoctorSeverity = "error" | "warning" | "info";

export interface DoctorFinding {
  type: DoctorFindingType;
  severity: DoctorSeverity;
  /** The tag / field / metadata-key this finding is about. */
  subject: string;
  detail: string;
  remedy: string;
  /**
   * True ONLY for `dead_tag_metadata_reference` — flags the finding as a
   * best-effort inference (no tag-rename history exists to confirm it),
   * never present (not even `false`) on the other, structurally-certain
   * finding types.
   */
  heuristic?: true;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  summary: string;
  scanned_at: string;
  history_audit?: HistoryAuditPage;
}

export interface DoctorScanOpts {
  /**
   * The caller's expanded tag allowlist (root ∪ descendants). `null`
   * (default) scans the whole vault. See the module doc comment for how
   * each finding type is scoped.
   */
  allowedTags?: Set<string> | null;
  /**
   * Per-note visibility predicate over a note's FULL tag set (vault#766).
   * The server layer builds it from `noteWithinTagScope`, so a note hidden
   * by a private co-tag (deny wins) is out of scope here too. When omitted,
   * a scoped run falls back to "any tag in `allowedTags`" (core callers
   * without a server-layer scope). Ignored when `allowedTags` is null.
   */
  noteTagsInScope?: (tags: string[]) => boolean;
  deep?: boolean;
  history_after?: string;
  history_max_blobs?: number;
  history_budget_ms?: number;
}

/** Cap on exemplar note IDs embedded in a finding's `detail` (vault#552 — keep report bodies bounded). */
const MAX_EXEMPLARS = 5;

/**
 * Build a per-note in-scope predicate for a tag-scoped doctor run (vault#552
 * auth fold). A note is in-scope per `noteTagsInScope` (the server's
 * `noteWithinTagScope`, which applies the private-tags deny — vault#766),
 * else iff at least one of its tags is in `allowedTags`; an unscoped run (`allowedTags === null`) treats every note
 * as in-scope. Caches each note's tag lookup so repeated checks across scans
 * cost one query per note. Shared by the mixed-type-indexed-field and
 * dead-tag-metadata scans, both of which query notes vault-wide and must NOT
 * surface an out-of-scope note id (or count, or exemplar) to a scoped caller.
 */
function makeNoteInScope(
  db: Database,
  allowedTags: Set<string> | null,
  noteTagsInScope?: (tags: string[]) => boolean,
): (id: string) => boolean {
  if (!allowedTags) return () => true;
  const admit = noteTagsInScope ?? ((tags: string[]) => tags.some((t) => allowedTags.has(t)));
  const cache = new Map<string, boolean>();
  return (id: string): boolean => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const tags = (db.query("SELECT tag_name FROM note_tags WHERE note_id = ?").all(id) as { tag_name: string }[]).map((r) => r.tag_name);
    const inScope = admit(tags);
    cache.set(id, inScope);
    return inScope;
  };
}

export function runDoctorScan(db: Database, opts?: DoctorScanOpts): DoctorReport {
  const allowedTags = opts?.allowedTags ?? null;
  if (opts?.deep && allowedTags !== null) throw new Error("deep history audit requires an unrestricted session");
  const findings: DoctorFinding[] = [
    ...scanDanglingParentNames(db, allowedTags),
    ...scanParentNamesCycles(db, allowedTags),
    ...scanMixedTypeIndexedFields(db, allowedTags, opts?.noteTagsInScope),
    ...scanOrphanedIndexedFieldDeclarers(db, allowedTags),
    ...scanDeadTagMetadataReferences(db, allowedTags, opts?.noteTagsInScope),
    ...(allowedTags === null ? scanDeletedNoteHistory(db) : []),
    ...(allowedTags === null ? scanHistoryStorage(db) : []),
    ...(allowedTags === null ? scanDeltaOrphans(db) : []),
    ...(allowedTags === null ? scanCompactStateDrift(db) : []),
    ...(allowedTags === null ? scanTagsUsedLikeTypes(db) : []),
    ...scanFieldShapes(db, allowedTags, opts?.noteTagsInScope),
  ];

  const audit = opts?.deep ? auditHistoryBlobs(db, opts.history_after, opts.history_max_blobs, opts.history_budget_ms) : undefined;
  if (audit) findings.push({ type: "history_content_audit", severity: audit.corrupt ? "error" : audit.complete ? "info" : "warning",
    subject: "history content audit page",
    detail: `Checked ${audit.checked} blob(s); ${audit.corrupt} corrupt. ${audit.complete ? "End of scan reached." : "Incomplete: continue with next_after."} Examples: ${audit.examples.join(", ") || "none"}.`,
    remedy: "Continue incomplete scans with history_after=next_after. For snapshot-level assurance, audit a consistent backup. Preserve backups and investigate corruption; this audit never repairs or erases history." });

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const summary =
    findings.length === 0
      ? "clean — no integrity findings"
      : `${findings.length} finding(s): ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;

  return { findings, summary, scanned_at: new Date().toISOString(),
    ...(audit ? { history_audit: audit } : {}) };
}

// ---------------------------------------------------------------------------
// A. dangling parent_names
// ---------------------------------------------------------------------------

function scanDanglingParentNames(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const rows = db
    .prepare("SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL")
    .all() as { name: string; parent_names: string }[];
  const allTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );

  const findings: DoctorFinding[] = [];
  for (const row of rows) {
    if (allowedTags && !allowedTags.has(row.name)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.parent_names); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const parent of parsed) {
      if (typeof parent !== "string" || parent.length === 0) continue;
      if (allTags.has(parent)) continue;
      findings.push({
        type: "dangling_parent_name",
        severity: "warning",
        subject: row.name,
        detail: `tag "${row.name}" declares parent "${parent}", which has no identity row — a typo, a tag that was never created, or a rename/delete that didn't update this reference.`,
        remedy: `remove "${parent}" from "${row.name}"'s parent_names (update-tag), or create the missing "${parent}" tag if it's meant to exist`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// B. parent_names cycles (pre-existing data — the write-time guard blocks
//    NEW ones; this surfaces anything already on disk)
// ---------------------------------------------------------------------------

function scanParentNamesCycles(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const hierarchy = loadTagHierarchy(db);
  const cycles = findHierarchyCycles(hierarchy);
  const findings: DoctorFinding[] = [];
  for (const tag of cycles) {
    if (allowedTags && !allowedTags.has(tag)) continue;
    findings.push({
      type: "parent_names_cycle",
      severity: "error",
      subject: tag,
      detail: `tag "${tag}" reaches itself through its declared parent_names ancestor chain. Query expansion tolerates this (a visited-set stops it looping), but it's confusing hierarchy state.`,
      remedy: `clear or correct parent_names on one of the tags in "${tag}"'s ancestor chain (update-tag) to break the cycle`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// C. mixed-type values in an indexed column (WS4 poison precursor)
// ---------------------------------------------------------------------------

/** `json_type()` results consistent with each declared indexed sqlite storage class. */
const EXPECTED_JSON_TYPES: Record<string, Set<string>> = {
  INTEGER: new Set(["integer", "real", "true", "false"]),
  TEXT: new Set(["text"]),
};

/** One vault-wide-scan result row from {@link findMixedTypeIndexedFieldNotes}. */
export interface MixedTypeIndexedFieldRow {
  id: string;
  /** SQLite `json_type()` of the CURRENT `metadata.<field>` value — "text", "integer", "real", "true", "false", "array", "object" (never "null": absent/null keys are excluded upstream). */
  jt: string;
}

/**
 * Vault-wide detector: every note whose `metadata.<field>` JSON type
 * disagrees with `sqliteType` (the field's declared indexed storage class —
 * "INTEGER" or "TEXT"). Returns `[]` for an unknown `sqliteType` or when
 * nothing mismatches. UNSCOPED — no tag-scope filtering (that's the caller's
 * job; see `scanMixedTypeIndexedFields` below for the tag-scoped doctor
 * finding, and `migrateToV24` in `core/src/schema.ts` for the unscoped
 * migration consumer). `json_type(metadata, ?)` returns NULL when the key is
 * absent — those notes simply don't declare the field and aren't a mismatch.
 *
 * Extracted (vault#553 Decision D) so the SAME detection query backs both
 * the `mixed_type_indexed_field` doctor finding AND the `migrateToV24`
 * startup migration's poison scan — one source of truth for "what counts as
 * mismatched," so a fix to one can't silently diverge from the other.
 */
export function findMixedTypeIndexedFieldNotes(
  db: Database,
  field: string,
  sqliteType: string,
): MixedTypeIndexedFieldRow[] {
  const expected = EXPECTED_JSON_TYPES[sqliteType];
  if (!expected) return []; // unknown sqlite_type — nothing to compare against
  const path = `$."${field}"`;
  const rows = db
    .prepare(
      `SELECT id, json_type(metadata, ?) as jt FROM notes WHERE metadata IS NOT NULL AND metadata != '' AND json_valid(metadata)`,
    )
    .all(path) as { id: string; jt: string | null }[];
  return rows.filter((r): r is MixedTypeIndexedFieldRow => r.jt !== null && !expected.has(r.jt));
}

function scanMixedTypeIndexedFields(
  db: Database,
  allowedTags: Set<string> | null,
  noteTagsInScope?: (tags: string[]) => boolean,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const noteInScope = makeNoteInScope(db, allowedTags, noteTagsInScope);
  for (const f of listIndexedFields(db)) {
    if (allowedTags && !f.declarerTags.some((t) => allowedTags.has(t))) continue;

    const rows = findMixedTypeIndexedFieldNotes(db, f.field, f.sqliteType);
    if (rows.length === 0) continue;

    // Tag-scope (vault#552 auth fold): the note query above is vault-wide —
    // filter mismatches to IN-SCOPE notes so a scoped caller never sees an
    // out-of-scope note id (nor a count/exemplar reflecting one). If every
    // mismatch is on an out-of-scope note, the finding is dropped entirely.
    const mismatches = rows.filter((r) => noteInScope(r.id));
    if (mismatches.length === 0) continue;

    // Also generalize the "Declared by" list to in-scope declarers only —
    // the field can be co-declared by an out-of-scope tag whose name must
    // not leak (the caller sees this field only via its in-scope declarer).
    const visibleDeclarers = allowedTags
      ? f.declarerTags.filter((t) => allowedTags.has(t))
      : f.declarerTags;
    const exemplars = mismatches.slice(0, MAX_EXEMPLARS).map((r) => `${r.id} (${r.jt})`);
    findings.push({
      type: "mixed_type_indexed_field",
      severity: "error",
      subject: f.field,
      detail: `field "${f.field}" is indexed as ${f.sqliteType} but ${mismatches.length} note(s) carry a metadata."${f.field}" value of a disagreeing JSON type — the generated column's affinity coercion makes ordering/filtering across these rows inconsistent. Declared by: ${visibleDeclarers.join(", ") || "(no live declarer)"}. Example note(s): ${exemplars.join(", ")}${mismatches.length > exemplars.length ? ", …" : ""}`,
      remedy: `backfill each listed note's metadata."${f.field}" to a value matching the declared type, or relax the field's declared type (update-tag) if the mixed values are intentional`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// D. orphaned indexed_fields declarers (overlaps prune-schema)
// ---------------------------------------------------------------------------

function scanOrphanedIndexedFieldDeclarers(db: Database, allowedTags: Set<string> | null): DoctorFinding[] {
  const plan = pruneOrphanedIndexedFields(db, { dryRun: true });
  const findings: DoctorFinding[] = [];
  for (const p of plan) {
    if (allowedTags && !p.deadDeclarers.some((t) => allowedTags.has(t))) {
      // Dead declarer names never survive `allowedTags` (it's derived from
      // LIVE tags only) — this branch exists for completeness; in practice
      // a scoped caller only sees this finding when the report is unscoped.
      continue;
    }
    findings.push({
      type: "orphaned_indexed_field_declarer",
      severity: p.dropped ? "warning" : "info",
      subject: p.field,
      detail: p.dropped
        ? `field "${p.field}" has NO surviving live declarer (dead: ${p.deadDeclarers.join(", ")}) — the generated column + index are stale and will be dropped on next prune (metadata values are never lost, only the index).`
        : `field "${p.field}" has dead declarer tag(s) [${p.deadDeclarers.join(", ")}] still listed alongside live ones — cosmetic, no functional impact.`,
      remedy: `run the prune-schema tool (apply: true) to drop the dead declarer(s)${p.dropped ? " and the now-unreferenced column/index" : ""}`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// E. metadata values equal to a tag name that no longer exists (heuristic)
// ---------------------------------------------------------------------------

function scanDeadTagMetadataReferences(
  db: Database,
  allowedTags: Set<string> | null,
  noteTagsInScope?: (tags: string[]) => boolean,
): DoctorFinding[] {
  const liveTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );

  // Schema-declared enum fields (vault#570) — a metadata key declared as an
  // enum on ANY tag's schema is a closed, schema-governed vocabulary; skip
  // it from this heuristic entirely so the enum's own values coincidentally
  // colliding with an unrelated live tag name can't drag its OTHER
  // legitimate values into a false "stale tag reference" finding (see the
  // module doc comment above).
  const enumFieldKeys = new Set<string>();
  for (const fields of loadSchemaConfig(db).tagToFields.values()) {
    for (const [key, spec] of Object.entries(fields)) {
      if (Array.isArray(spec.enum) && spec.enum.length > 0) enumFieldKeys.add(key);
    }
  }

  const rows = db
    .prepare("SELECT id, metadata FROM notes WHERE metadata IS NOT NULL AND metadata != ''")
    .all() as { id: string; metadata: string }[];

  // key -> value -> note ids carrying that (key, value) pair.
  const byKey = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.metadata); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (enumFieldKeys.has(key)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      let valueMap = byKey.get(key);
      if (!valueMap) { valueMap = new Map(); byKey.set(key, valueMap); }
      let ids = valueMap.get(value);
      if (!ids) { ids = []; valueMap.set(value, ids); }
      ids.push(row.id);
    }
  }

  // Tag-scope (vault#552 auth fold): a note is in-scope iff at least one of
  // its tags is in `allowedTags` (unscoped → every note in-scope).
  const noteInScope = makeNoteInScope(db, allowedTags, noteTagsInScope);

  const findings: DoctorFinding[] = [];
  for (const [key, valueMap] of byKey) {
    // Signal: does this metadata key hold tag-shaped values on IN-SCOPE
    // notes? Computed over in-scope notes ONLY (not vault-wide) so the
    // example live value quoted in `detail` can never leak an out-of-scope
    // tag name — a scoped caller must not learn a tag exists just because a
    // note it can't see uses it as a metadata value. Only flag mismatches
    // under a key that demonstrably holds tag-shaped values in-scope.
    const liveValuesInScope = [...valueMap.entries()]
      .filter(([v, ids]) => liveTags.has(v) && ids.some(noteInScope))
      .map(([v]) => v);
    if (liveValuesInScope.length === 0) continue;

    for (const [value, noteIds] of valueMap) {
      if (liveTags.has(value)) continue;
      const inScopeIds = noteIds.filter(noteInScope);
      if (inScopeIds.length === 0) continue;
      const exemplars = inScopeIds.slice(0, MAX_EXEMPLARS);
      findings.push({
        type: "dead_tag_metadata_reference",
        severity: "info",
        subject: `metadata.${key}`,
        detail: `${inScopeIds.length} note(s) carry metadata.${key} = "${value}", which matches no current tag — other notes' metadata.${key} values ARE live tags (e.g. "${liveValuesInScope[0]}"), suggesting "${value}" may be a stale reference to a tag that was renamed, merged, or deleted. Example note(s): ${exemplars.join(", ")}${inScopeIds.length > exemplars.length ? ", …" : ""}`,
        remedy: `if "${value}" was renamed/merged/deleted, update these notes' metadata.${key} to the current tag name; if "${value}" was never a tag, ignore this finding`,
        heuristic: true,
      });
    }
  }
  return findings;
}

/** Deleted rows have no tags to authorize against; callers omit this for scoped sessions. */
function scanDeletedNoteHistory(db: Database): DoctorFinding[] {
  if (!historyTablesPresent(db)) return [];
  const stats = deletedHistoryStats(db);
  if (stats.versions === 0) return [];
  return [{ type: "deleted_note_history", severity: "info",
    subject: `${stats.notes} deleted note(s)`,
    detail: `${stats.versions} version row(s) retained for notes that no longer exist, holding ~${stats.bytes} bytes of blob content. Blobs shared with a live note's history are counted here as well, so this is an upper bound, not an exact figure.`
      + (stats.overflow_tombstones > 0 ? ` ${stats.overflow_tombstones} of these are overflow tombstone(s): the note exceeded the 2 MB version ceiling, so its deletion, size and metadata were recorded but its content was not and cannot be restored.` : ``),
    remedy: "Set `history.deleted_retention_days` in the vault's vault.yaml to sweep these automatically (null — the default — keeps them until an explicit erase), or erase one note's history permanently with DELETE /api/notes/<id>/versions.",
  }];
}

function scanHistoryStorage(db: Database): DoctorFinding[] {
  if (!historyTablesPresent(db)) return [];
  const s = historyStorageStats(db);
  if (s.whole_blobs + s.delta_blobs === 0) return [];
  const top = topNotesByHistoryBytes(db, 5);
  return [{ type: "history_storage", severity: "info",
    subject: `${s.whole_blobs + s.delta_blobs} history blob(s)`,
    detail: `${s.whole_bytes} byte(s) stored whole across ${s.whole_blobs} blob(s) and ${s.delta_bytes} byte(s) stored as fossil deltas across ${s.delta_blobs} blob(s). Largest histories by stored bytes: ${top.map(t => `${t.note_id} (${t.bytes} bytes, ${t.versions} versions)`).join(", ")}.`,
    remedy: "Run POST /api/history/compact (vault:admin) to compact now, or set history.max_bytes_per_note in the vault's vault.yaml to bound per-note history. Turning history.compact_enabled off also stops max_bytes_per_note being enforced." }];
}
function scanDeltaOrphans(db: Database): DoctorFinding[] {
  if (!historyTablesPresent(db)) return [];
  const s = historyStorageStats(db);
  if (s.orphan_deltas + s.unknown_encoding_blobs === 0) return [];
  return [{ type: "history_delta_orphan", severity: "error",
    subject: `${s.orphan_deltas + s.unknown_encoding_blobs} unrecoverable history blob(s)`,
    detail: `${s.orphan_deltas} blob(s) are stored as fossil deltas whose base blob is missing or is itself a delta, and ${s.unknown_encoding_blobs} carry an encoding this version does not know how to read, so the versions referencing them cannot be reconstructed. Reading one answers 409 history_unrecoverable; listing versions still works.`,
    remedy: "Erase the affected note's history with DELETE /api/notes/<id>/versions, or restore the vault database from backup. This is a corruption finding, not a retention setting." }];
}


/**
 * T-318 §8a step 2, the dry run: a plain tag on many notes is probably a kind
 * of thing (a type) waiting to be named one. Advisory; nothing changes until
 * the owner promotes it.
 */
function scanTagsUsedLikeTypes(db: Database): DoctorFinding[] {
  return typeKindReport(db).look_like_types.map((t) => ({
    type: "tag_used_like_type" as const,
    severity: "info" as const,
    subject: t.name,
    detail: `"${t.name}" is a plain tag on ${t.notes} notes; it may be a type (a kind of thing, with fields).`,
    remedy: `If it is: manage-types {tag: "${t.name}", kind: "type"}. If it is a label, nothing to do.`,
  }));
}

// ---------------------------------------------------------------------------
// 0.9.2: field shapes (mixed data types, the reference gap, near names)
// ---------------------------------------------------------------------------

/** A field's data type as a person names it; JSON's integer and real are both a number. */
const DATA_TYPE: Record<string, string> = {
  text: "string", integer: "number", real: "number", true: "boolean", false: "boolean", array: "array", object: "object",
};

interface FieldStat {
  key: string;
  /** data type → number of records holding it */
  types: Map<string, number>;
  /** data type → one record id holding it */
  examples: Map<string, string>;
  records: number;
}

/**
 * The ids of the notes a scoped doctor run may see, as a JSON array for
 * `json_each`, or null for an unscoped run. Candidates are the notes holding
 * an allowed tag; the server's predicate then applies the private-tag deny.
 */
function inScopeIdsJson(
  db: Database,
  allowedTags: Set<string> | null,
  noteTagsInScope?: (tags: string[]) => boolean,
): string | null {
  if (!allowedTags) return null;
  const inScope = makeNoteInScope(db, allowedTags, noteTagsInScope);
  const ids = (db
    .prepare("SELECT DISTINCT note_id AS id FROM note_tags WHERE tag_name IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify([...allowedTags])) as { id: string }[]).map((r) => r.id).filter(inScope);
  return JSON.stringify(ids);
}

const META_ROWS = `FROM notes n, json_each(n.metadata) j
  WHERE n.metadata IS NOT NULL AND n.metadata != '' AND json_valid(n.metadata) AND json_type(n.metadata) = 'object'`;

function fieldStats(db: Database, scopeIds: string | null): FieldStat[] {
  const scope = scopeIds === null ? "" : " AND n.id IN (SELECT value FROM json_each(?))";
  const rows = db
    .prepare(`SELECT j.key AS key, j.type AS type, COUNT(*) AS c, MIN(n.id) AS ex ${META_ROWS} AND j.type != 'null'${scope} GROUP BY j.key, j.type`)
    .all(...(scopeIds === null ? [] : [scopeIds])) as { key: string; type: string; c: number; ex: string }[];
  const byKey = new Map<string, FieldStat>();
  for (const r of rows) {
    let st = byKey.get(r.key);
    if (!st) byKey.set(r.key, (st = { key: r.key, types: new Map(), examples: new Map(), records: 0 }));
    const t = DATA_TYPE[r.type] ?? r.type;
    st.types.set(t, (st.types.get(t) ?? 0) + r.c);
    if (!st.examples.has(t)) st.examples.set(t, r.ex);
    st.records += r.c;
  }
  return [...byKey.values()];
}

/** Field name → [type, its declared data type] for every type (in scope) that declares it. */
function declaredFields(db: Database, allowedTags: Set<string> | null): Map<string, { tag: string; type?: string }[]> {
  const out = new Map<string, { tag: string; type?: string }[]>();
  const rows = db.prepare("SELECT name, fields FROM tags WHERE fields IS NOT NULL").all() as { name: string; fields: string }[];
  for (const r of rows) {
    if (allowedTags && !allowedTags.has(r.name)) continue;
    let fields: unknown;
    try { fields = JSON.parse(r.fields); } catch { continue; }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    for (const [k, spec] of Object.entries(fields as Record<string, any>)) {
      const list = out.get(k) ?? [];
      list.push({ tag: r.name, type: typeof spec?.type === "string" ? spec.type : undefined });
      out.set(k, list);
    }
  }
  return out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function scanFieldShapes(
  db: Database,
  allowedTags: Set<string> | null,
  noteTagsInScope?: (tags: string[]) => boolean,
): DoctorFinding[] {
  const scopeIds = inScopeIdsJson(db, allowedTags, noteTagsInScope);
  const stats = fieldStats(db, scopeIds);
  const declared = declaredFields(db, allowedTags);
  return [
    ...mixedTypeFields(db, stats, declared),
    ...referenceGaps(db, scopeIds, declared),
    ...nearNames(db, stats, declared, allowedTags, scopeIds),
  ];
}

function mixedTypeFields(
  db: Database,
  stats: FieldStat[],
  declared: Map<string, { tag: string; type?: string }[]>,
): DoctorFinding[] {
  const indexed = new Set(listIndexedFields(db).map((f) => f.field));
  const findings: DoctorFinding[] = [];
  for (const st of stats) {
    if (st.types.size < 2 || indexed.has(st.key)) continue;
    const counts = [...st.types.entries()].sort((a, b) => b[1] - a[1]);
    const decl = declared.get(st.key) ?? [];
    const declText = decl.length > 0
      ? `Declared by ${decl.map((d) => `${d.tag}${d.type ? ` (${d.type})` : ""}`).join(", ")}.`
      : "No type declares it.";
    findings.push({
      type: "mixed_type_field",
      severity: "warning",
      subject: st.key,
      detail: `field "${st.key}" holds values of ${counts.length} data types: ${counts.map(([t, c]) => `${t} (${plural(c, "record")})`).join(", ")}. ${declText} Examples: ${counts.map(([t]) => `${st.examples.get(t)} (${t})`).join(", ")}.`,
      remedy: `Give "${st.key}" one data type: update the records holding the odd values${decl.length > 0 ? " to the declared type" : ""}, or, if they are different things, move one kind into a field of its own. A field holds one data type per vault in 1.0.`,
    });
  }
  return findings;
}

function referenceGaps(
  db: Database,
  scopeIds: string | null,
  declared: Map<string, { tag: string; type?: string }[]>,
): DoctorFinding[] {
  // A value names a record when it is that record's path (any case, as
  // wikilinks resolve), the path in `[[...]]`, or its id. A scoped run only
  // counts records it may see, so the count can't reveal a hidden path.
  // `[[path]]`, `[[path|alias]]` and `[[path#heading]]` all name `path`.
  const inner = `(CASE WHEN j.value LIKE '[[%]]' THEN substr(j.value, 3, length(j.value) - 4) ELSE j.value END)`;
  const noAlias = `(CASE WHEN instr(${inner}, '|') > 0 THEN substr(${inner}, 1, instr(${inner}, '|') - 1) ELSE ${inner} END)`;
  const target = `(CASE WHEN instr(${noAlias}, '#') > 1 THEN substr(${noAlias}, 1, instr(${noAlias}, '#') - 1) ELSE ${noAlias} END)`;
  const scope = scopeIds === null ? "" : " AND t.id IN (SELECT value FROM json_each(?))";
  const scopeN = scopeIds === null ? "" : " AND n.id IN (SELECT value FROM json_each(?))";
  const rows = db
    .prepare(`SELECT j.key AS key, COUNT(*) AS total,
        SUM(EXISTS (SELECT 1 FROM notes t WHERE t.path = ${target} COLLATE NOCASE${scope})
            OR EXISTS (SELECT 1 FROM notes t WHERE t.id = j.value${scope})) AS hits
      ${META_ROWS} AND j.type = 'text' AND length(j.value) BETWEEN 1 AND 512${scopeN}
      GROUP BY j.key`)
    .all(...(scopeIds === null ? [] : [scopeIds, scopeIds, scopeIds])) as { key: string; total: number; hits: number }[];
  const findings: DoctorFinding[] = [];
  for (const r of rows) {
    // "Most": more than half the records holding text in this field, and at least two.
    if (r.hits < 2 || r.hits * 2 <= r.total) continue;
    const decl = declared.get(r.key) ?? [];
    if (decl.some((d) => d.type === "reference")) continue;
    const on = decl.length > 0 ? decl.map((d) => d.tag) : topTypeHolding(db, r.key, scopeIds);
    const call = on.length > 0
      ? `manage-types {tag: "${on[0]}", fields: {"${r.key}": {type: "reference"}}}${on.length > 1 ? ` (and on ${on.slice(1).join(", ")})` : ""}`
      : `manage-types {tag: <the type its records carry>, fields: {"${r.key}": {type: "reference"}}}`;
    findings.push({
      type: "declared_reference_gap",
      severity: "info",
      subject: r.key,
      detail: `field "${r.key}" names another record in ${r.hits} of ${plural(r.total, "record")} that hold text in it, but no type declares it a reference, so the vault keeps it as plain text: it isn't a link, renames don't follow it, and near and backlinks don't see it.`,
      remedy: `If it points at records, declare it a reference: ${call}.`,
    });
  }
  return findings;
}

/** The type most of the records holding `key` carry (none when they carry no type). */
function topTypeHolding(db: Database, key: string, scopeIds: string | null): string[] {
  if (/["\\]/.test(key)) return [];
  const scope = scopeIds === null ? "" : " AND n.id IN (SELECT value FROM json_each(?))";
  const row = db
    .prepare(`SELECT nt.tag_name AS name, COUNT(*) AS c FROM notes n JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.name = nt.tag_name
      WHERE json_valid(n.metadata) AND json_type(n.metadata, '$."' || ? || '"') IS NOT NULL AND ${KIND_SQL} = 'type'${scope}
      GROUP BY nt.tag_name ORDER BY c DESC LIMIT 1`)
    .get(...(scopeIds === null ? [key] : [key, scopeIds])) as { name: string } | null;
  return row ? [row.name] : [];
}

/**
 * Two names one edit apart, case aside, that aren't the same name. Names
 * that differ in one digit (`item1`, `item2`), add a number at the end
 * (`item`, `item2`) or differ in a last letter after a separator (`phase-a`,
 * `phase-b`) are a series, not a slip, and are left out, as are names under
 * three characters.
 */
function nearPair(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  // Short names (`x`, `y`, `id`) are one letter from many others by nature.
  if (a.length < 3 || b.length < 3) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return true;
  if (levenshtein(x, y) !== 1) return false;
  // `item` and `item2`: a number added at the end starts a series.
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (long.length > short.length && long.startsWith(short) && /\d/.test(long[long.length - 1]!)) return false;
  if (x.length === y.length) {
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (/\d/.test(x[i]!) && /\d/.test(y[i]!)) return false;
      if (i === x.length - 1 && i > 0 && /[-_/. ]/.test(x[i - 1]!)) return false;
      return true;
    }
  }
  return true;
}

const MAX_NEAR_NAMES = 25;

function nearNames(
  db: Database,
  stats: FieldStat[],
  declared: Map<string, { tag: string; type?: string }[]>,
  allowedTags: Set<string> | null,
  scopeIds: string | null,
): DoctorFinding[] {
  // A scoped run counts only the records it may see (a private co-tag hides one).
  const inScope = scopeIds === null ? "" : " AND nt.note_id IN (SELECT value FROM json_each(?))";
  const typeRows = db
    .prepare(`SELECT t.name AS name, (SELECT COUNT(*) FROM note_tags nt WHERE nt.tag_name = t.name${inScope}) AS c FROM tags t WHERE ${KIND_SQL} = 'type'`)
    .all(...(scopeIds === null ? [] : [scopeIds])) as { name: string; c: number }[];
  const types = typeRows.filter((r) => !allowedTags || allowedTags.has(r.name)).map((r) => ({ name: r.name, c: r.c }));
  const fieldUse = new Map<string, number>();
  for (const st of stats) fieldUse.set(st.key, st.records);
  for (const k of declared.keys()) if (!fieldUse.has(k)) fieldUse.set(k, 0);
  const fields = [...fieldUse.entries()].map(([name, c]) => ({ name, c }));

  const pairs: { kind: "type" | "field"; a: { name: string; c: number }; b: { name: string; c: number } }[] = [];
  for (const [kind, list] of [["type", types], ["field", fields]] as const) {
    const sorted = [...list].sort((p, q) => p.name.length - q.name.length || (p.name < q.name ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let k = i + 1; k < sorted.length && sorted[k]!.name.length - sorted[i]!.name.length <= 1; k++) {
        if (nearPair(sorted[i]!.name, sorted[k]!.name)) pairs.push({ kind, a: sorted[i]!, b: sorted[k]! });
      }
    }
  }
  pairs.sort((p, q) => q.a.c + q.b.c - (p.a.c + p.b.c));
  const findings: DoctorFinding[] = pairs.slice(0, MAX_NEAR_NAMES).map(({ kind, a, b }) => ({
    type: "near_names" as const,
    severity: "info" as const,
    subject: `${a.name}, ${b.name}`,
    detail: `two ${kind} names ${a.name.toLowerCase() === b.name.toLowerCase() ? "that differ only in case" : "one letter apart"}: "${a.name}" (${plural(a.c, "record")}) and "${b.name}" (${plural(b.c, "record")}).`,
    remedy: kind === "type"
      ? `If they mean the same thing, merge them: manage-types {action: "merge", sources: ["${b.c > a.c ? a.name : b.name}"], target: "${b.c > a.c ? b.name : a.name}"}. If both are meant, nothing to do.`
      : `If they mean the same thing, move the records holding "${b.c > a.c ? a.name : b.name}" to "${b.c > a.c ? b.name : a.name}" (update each record's fields). If both are meant, nothing to do.`,
  }));
  if (pairs.length > MAX_NEAR_NAMES) {
    findings.push({
      type: "near_names",
      severity: "info",
      subject: "more near names",
      detail: `${pairs.length - MAX_NEAR_NAMES} more pairs of names one letter apart; the ${MAX_NEAR_NAMES} most used are listed.`,
      remedy: "Look at the listed pairs first; run doctor again after merging.",
    });
  }
  return findings;
}

