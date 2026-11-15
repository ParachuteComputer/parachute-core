/**
 * Indexed-field lifecycle — manages generated columns + indexes on `notes`
 * for metadata fields declared `indexed: true` by one or more tag schemas.
 *
 * Semantic: the tag authorizes the index, but the index is universal across
 * all notes (not partitioned by tag). A generated column mirrors
 * `json_extract(metadata, '$.<field>')` and a B-tree index on that column
 * makes operator queries (eq/gt/lt/in/...) and `order_by` fast.
 *
 * Lifetime is tied to the declarer set: the column + index exist as long as
 * at least one tag schema declares `indexed: true` for the field. When the
 * last declarer releases (schema update or `delete-tag`), the column + index
 * are dropped. The `indexed_fields` table is the single source of truth and
 * is used by `rebuildIndexes` on vault init for idempotent reconstruction.
 *
 * See Parachute/Decisions/2026-04-19-metadata-indexing-via-tag-schemas.
 */

import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SqliteType = "TEXT" | "INTEGER";
// `reference` (vault#typed-reference-field) is stored as TEXT — same as
// `string` — because the metadata VALUE (an id/path/title) is what's
// indexed here; the resolved graph link is a separate concern maintained by
// `core/src/store.ts`'s write path. See tag-schemas.ts's `VALID_FIELD_TYPES`.
// `date` is also stored as TEXT: an indexed `date` field holds an ISO-8601
// string (validated by `tag-schemas.ts`'s `defaultMatchesType` /
// `schema-defaults.ts`'s `valueMatchesType`), and ISO-8601 strings are
// lexicographically comparable — the same reason TEXT-stored `updated_at`
// range queries already work — so `gt`/`gte`/`lt`/`lte`, `date_filter`, and
// `order_by` all fall out of the generic TEXT-column machinery with no
// type-specific SQL.
export type FieldType = "string" | "integer" | "boolean" | "reference" | "date";

export const TYPE_MAP: Record<FieldType, SqliteType> = {
  string: "TEXT",
  integer: "INTEGER",
  boolean: "INTEGER",
  reference: "TEXT",
  date: "TEXT",
};

export interface IndexedField {
  field: string;
  sqliteType: SqliteType;
  declarerTags: string[];
}

interface IndexedFieldRow {
  field: string;
  sqlite_type: string;
  declarer_tags: string;
}

export class IndexedFieldError extends Error {
  override name = "IndexedFieldError";
  // Stable error_type (vault#554) — additive; matches the string REST has
  // hardcoded in its json response since vault#478. Lets the generic MCP
  // domain-error mapping (src/mcp-http.ts) pick this class up.
  error_type: "invalid_indexed_field" | "indexed_field_limit" = "invalid_indexed_field";
  /**
   * Structured context for the CROSS-DECLARER sqlite-type conflict thrown
   * by `declareField` (vault#554 auth-and-scope fold): the message names
   * the other declarer tag(s), which a tag-scoped caller must not learn
   * when they're outside its allowlist. `declarer_tags` lets the server
   * layer (`scrubIndexedFieldConflictError` in src/tag-scope.ts) detect
   * that case and generalize the message. Absent on the solo own-field
   * throws (invalid name, unsupported type), whose messages name no other
   * tag.
   */
  field?: string;
  declarer_tags?: string[];
}

/**
 * The indexed-field ceiling (0.9.2, SPEC §8). Every indexed field is a
 * generated column on `notes`; cloud's SQLite allows 100 columns per table
 * and `notes` already uses 12, so 88 indexed fields is the most a vault can
 * hold on every door. Held on the box too (Aaron, 11-11: "every door"), so a
 * box vault can always move to cloud.
 *
 * Only a NEW field is refused: adding a declarer to an already-indexed field,
 * re-declaring, or a sole declarer's retype doesn't add a column. A vault
 * already over the ceiling keeps every column it has; `doctor` reports the
 * excess.
 */
export const INDEXED_FIELD_LIMIT = 88;

/** An indexed field the refusal suggests dropping, and why it's a candidate. */
export interface UnusedIndexedField {
  field: string;
  /**
   * `no_live_declarer`: every declaring type is gone (prune-schema drops it).
   * `no_values`: no record holds a value for it (drop `indexed` on its type).
   */
  reason: "no_live_declarer" | "no_values";
  declarer_tags: string[];
}

/**
 * Refusal for a write that would take the vault past
 * {@link INDEXED_FIELD_LIMIT}. `fields` are the new indexed fields the write
 * asked for (`field` is the first); `got` is how many the vault holds now.
 */
export class IndexedFieldLimitError extends IndexedFieldError {
  override name = "IndexedFieldLimitError";
  override error_type = "indexed_field_limit" as const;
  readonly limit = INDEXED_FIELD_LIMIT;
  constructor(
    readonly fields: string[],
    readonly got: number,
    readonly unused: UnusedIndexedField[],
    /** Set by the tag-scope scrub when it held back unused fields the caller can't see. */
    readonly hiddenUnused = false,
  ) {
    super(indexedFieldLimitMessage(fields, got, unused, hiddenUnused));
    this.field = fields[0];
  }
}

function indexedFieldLimitMessage(fields: string[], got: number, unused: UnusedIndexedField[], hiddenUnused: boolean): string {
  const room = Math.max(0, INDEXED_FIELD_LIMIT - got);
  const head =
    fields.length === 1
      ? `cannot index "${fields[0]}": this vault has ${got} indexed fields and the limit is ${INDEXED_FIELD_LIMIT} on every Parachute.`
      : `cannot index ${fields.map((f) => `"${f}"`).join(", ")}: this vault has ${got} indexed fields, this write would add ${fields.length}, and the limit is ${INDEXED_FIELD_LIMIT} on every Parachute${room > 0 ? ` (room for ${room} more)` : ""}.`;
  const hidden = hiddenUnused ? " Some unused indexed fields are outside this token's scope; an admin can prune them." : "";
  if (unused.length === 0) {
    return `${head}${hidden}${hiddenUnused ? "" : " No indexed field looks unused."} Drop \`indexed\` from a field you don't filter or sort by (update-tag, on every type that declares it), or leave the new field unindexed: it can still be filtered, by a scan.`;
  }
  const list = unused
    .slice(0, 20)
    .map((u) => `${u.field} (${u.reason === "no_live_declarer" ? "no type declares it; prune-schema drops it" : "no record holds a value"})`)
    .join(", ");
  const more = unused.length > 20 ? `, and ${unused.length - 20} more` : "";
  return `${head} Unused indexed fields you can prune first: ${list}${more}.${hidden} Run prune-schema for fields no type declares; for the others drop \`indexed\` (update-tag, on every type that declares the field).`;
}

/**
 * Refuse, before any column is added, a write whose new indexed fields would
 * take the vault past the limit. `fields` may include fields already indexed;
 * only the others count. Call after the write's releases.
 */
export function assertIndexedFieldRoom(db: Database, fields: Iterable<string>): void {
  const fresh = [...fields].filter((f) => !getIndexedField(db, f));
  if (fresh.length === 0) return;
  const got = countIndexedFields(db);
  if (got + fresh.length > INDEXED_FIELD_LIMIT) {
    throw new IndexedFieldLimitError(fresh, got, findUnusedIndexedFields(db));
  }
}

// Restrict field names to safe SQL identifiers. This also bounds the
// generated column and index names, which are derived from the field.
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function validateFieldName(field: string): void {
  if (!FIELD_NAME_RE.test(field)) {
    throw new IndexedFieldError(
      `invalid field name "${field}": must start with a letter or underscore and contain only [A-Za-z0-9_] (max 63 chars)`,
    );
  }
}

/** Map a tag-schema field type to the backing SQLite storage class. */
export function mapFieldType(type: string): SqliteType | null {
  return TYPE_MAP[type as FieldType] ?? null;
}

function columnName(field: string): string {
  return `meta_${field}`;
}

function indexName(field: string): string {
  return `idx_meta_${field}`;
}

function rowToField(row: IndexedFieldRow): IndexedField {
  let declarerTags: string[] = [];
  try {
    const parsed = JSON.parse(row.declarer_tags);
    if (Array.isArray(parsed)) {
      declarerTags = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {}
  return {
    field: row.field,
    sqliteType: row.sqlite_type as SqliteType,
    declarerTags,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listIndexedFields(db: Database): IndexedField[] {
  const rows = db
    .prepare("SELECT field, sqlite_type, declarer_tags FROM indexed_fields ORDER BY field")
    .all() as IndexedFieldRow[];
  return rows.map(rowToField);
}

export function countIndexedFields(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM indexed_fields").get() as { n: number }).n;
}

/**
 * Indexed fields that look safe to drop, surest first: no live declarer (what
 * prune-schema drops), then no record holding a value (the column's index answers the
 * `IS NOT NULL` probe, so this is one index seek per field).
 */
export function findUnusedIndexedFields(db: Database): UnusedIndexedField[] {
  const liveTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );
  const out: UnusedIndexedField[] = [];
  for (const f of listIndexedFields(db)) {
    if (!f.declarerTags.some((t) => liveTags.has(t))) {
      out.push({ field: f.field, reason: "no_live_declarer", declarer_tags: f.declarerTags });
      continue;
    }
    let held = true;
    try {
      held = db.prepare(`SELECT 1 FROM notes WHERE "${columnName(f.field)}" IS NOT NULL LIMIT 1`).get() != null;
    } catch {
      // Column missing (a failed rebuild): don't guess, leave it out.
    }
    if (!held) out.push({ field: f.field, reason: "no_values", declarer_tags: f.declarerTags });
  }
  // prune-schema's own (no live declarer) first: the surest to drop.
  return [...out.filter((u) => u.reason === "no_live_declarer"), ...out.filter((u) => u.reason === "no_values")];
}

export function getIndexedField(db: Database, field: string): IndexedField | null {
  const row = db
    .prepare("SELECT field, sqlite_type, declarer_tags FROM indexed_fields WHERE field = ?")
    .get(field) as IndexedFieldRow | null;
  return row ? rowToField(row) : null;
}

// ---------------------------------------------------------------------------
// DDL helpers
// ---------------------------------------------------------------------------

function hasNotesColumn(db: Database, col: string): boolean {
  // `table_xinfo` includes generated (VIRTUAL) columns, which `table_info`
  // omits. We use xinfo here so re-declaration paths detect the existing
  // generated column and stay idempotent.
  const rows = db.prepare("PRAGMA table_xinfo(notes)").all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

function createColumnAndIndex(db: Database, field: string, sqliteType: SqliteType): void {
  const col = columnName(field);
  if (!hasNotesColumn(db, col)) {
    // SQLite requires VIRTUAL (not STORED) for generated columns added via
    // ALTER TABLE. VIRTUAL is also what we want here: the value isn't stored
    // twice (just indexed), so writes stay cheap.
    db.exec(
      `ALTER TABLE notes ADD COLUMN "${col}" ${sqliteType} GENERATED ALWAYS AS (json_extract(metadata, '$."${field}"')) VIRTUAL`,
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS "${indexName(field)}" ON notes("${col}")`);
}

function dropColumnAndIndex(db: Database, field: string): void {
  db.exec(`DROP INDEX IF EXISTS "${indexName(field)}"`);
  if (hasNotesColumn(db, columnName(field))) {
    db.exec(`ALTER TABLE notes DROP COLUMN "${columnName(field)}"`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle operations
// ---------------------------------------------------------------------------

/**
 * Register `tag` as a declarer of indexed `field` with the given storage type.
 *
 * - First declarer: inserts the row, creates the generated column + index.
 *   Refused with `IndexedFieldLimitError` when the vault already holds
 *   `INDEXED_FIELD_LIMIT` indexed fields.
 * - Additional declarer (matching type): adds tag to the set. Idempotent if
 *   the tag is already a declarer.
 * - Type mismatch with an existing *other* declarer: throws. This is a
 *   defensive check; the MCP layer should have already rejected the call
 *   with a more descriptive cross-tag error message.
 * - Type mismatch when this tag is the sole declarer: drops + recreates the
 *   column with the new type. Allowed because no other schema's contract
 *   depends on the prior type.
 */
export function declareField(
  db: Database,
  field: string,
  sqliteType: SqliteType,
  tag: string,
): void {
  validateFieldName(field);
  const existing = getIndexedField(db, field);
  if (!existing) {
    assertIndexedFieldRoom(db, [field]);
    db.prepare(
      "INSERT INTO indexed_fields (field, sqlite_type, declarer_tags) VALUES (?, ?, ?)",
    ).run(field, sqliteType, JSON.stringify([tag]));
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  if (existing.sqliteType !== sqliteType) {
    const others = existing.declarerTags.filter((t) => t !== tag);
    if (others.length > 0) {
      // `field` + `declarer_tags` stamped so the server's tag-scope layer
      // can generalize this message when a declarer is outside a scoped
      // caller's allowlist (see IndexedFieldError's doc comment).
      throw Object.assign(
        new IndexedFieldError(
          `field "${field}" is declared by tag(s) [${others.join(", ")}] with sqlite type ${existing.sqliteType}; tag "${tag}" requested ${sqliteType}`,
        ),
        { field, declarer_tags: others },
      );
    }
    dropColumnAndIndex(db, field);
    db.prepare(
      "UPDATE indexed_fields SET sqlite_type = ?, declarer_tags = ? WHERE field = ?",
    ).run(sqliteType, JSON.stringify([tag]), field);
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  if (existing.declarerTags.includes(tag)) {
    createColumnAndIndex(db, field, sqliteType);
    return;
  }
  const next = [...existing.declarerTags, tag];
  db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
    JSON.stringify(next),
    field,
  );
  createColumnAndIndex(db, field, sqliteType);
}

/**
 * Remove `tag` from `field`'s declarer set. If the set becomes empty, drop
 * the row, the generated column, and the index. Returns true if the column
 * was dropped.
 */
export function releaseField(db: Database, field: string, tag: string): boolean {
  const existing = getIndexedField(db, field);
  if (!existing) return false;
  const next = existing.declarerTags.filter((t) => t !== tag);
  if (next.length === 0) {
    db.prepare("DELETE FROM indexed_fields WHERE field = ?").run(field);
    dropColumnAndIndex(db, field);
    return true;
  }
  db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
    JSON.stringify(next),
    field,
  );
  return false;
}

/**
 * Reconcile the generated columns + indexes with `indexed_fields` rows.
 * Idempotent — safe to call on every vault init.
 *
 * `indexed_fields` is authoritative. Any row without its column/index gets
 * one created. Extras (columns beginning with `meta_` but not backed by a
 * row) are not touched — cleanup happens through the normal release path.
 */
export function rebuildIndexes(db: Database): void {
  for (const f of listIndexedFields(db)) {
    try {
      createColumnAndIndex(db, f.field, f.sqliteType);
    } catch (err) {
      console.error(
        `[indexed-fields] could not rebuild column for "${f.field}":`,
        err,
      );
    }
  }
}

export interface PrunedField {
  /** The field whose `indexed_fields` row was affected. */
  field: string;
  /** Declarer tags that no longer have a `tags` row (removed from the set). */
  deadDeclarers: string[];
  /**
   * True when the field had NO surviving live declarer and was fully dropped
   * (row + generated column + index). False when at least one live declarer
   * remained and only the dead declarers were pruned from the set.
   */
  dropped: boolean;
}

/**
 * Prune orphaned `indexed_fields` declarers — the gitcoin defect.
 *
 * A declarer tag is "dead" when no `tags` row carries that name (the tag was
 * deleted, or its schema was cleared, without releasing the field). For every
 * `indexed_fields` row:
 *
 *   - Drop dead declarers from the set.
 *   - If NO live declarer remains, drop the whole field — row + generated
 *     column + index. This is the only data-loss-free drop: the generated
 *     column is `json_extract(metadata, …)` so the source values stay in
 *     `notes.metadata`; only the (now-dead) index is lost.
 *   - If at least one live declarer remains (co-declaration), keep the column
 *     and just trim the dead names from the declarer set.
 *
 * `dryRun` (default) computes the plan without mutating; pass `dryRun: false`
 * to apply. Returns the per-field plan either way so the CLI / MCP surface can
 * print what it would (or did) drop.
 */
export function pruneOrphanedIndexedFields(
  db: Database,
  opts: { dryRun?: boolean } = {},
): PrunedField[] {
  const dryRun = opts.dryRun ?? true;
  const liveTags = new Set(
    (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((r) => r.name),
  );
  const plan: PrunedField[] = [];
  for (const f of listIndexedFields(db)) {
    const deadDeclarers = f.declarerTags.filter((t) => !liveTags.has(t));
    if (deadDeclarers.length === 0) continue; // every declarer is live — leave it
    const liveDeclarers = f.declarerTags.filter((t) => liveTags.has(t));
    const dropped = liveDeclarers.length === 0;
    plan.push({ field: f.field, deadDeclarers, dropped });
    if (dryRun) continue;
    if (dropped) {
      db.prepare("DELETE FROM indexed_fields WHERE field = ?").run(f.field);
      dropColumnAndIndex(db, f.field);
    } else {
      db.prepare("UPDATE indexed_fields SET declarer_tags = ? WHERE field = ?").run(
        JSON.stringify(liveDeclarers),
        f.field,
      );
    }
  }
  return plan;
}

/**
 * Replay `declareField` for every field a tag schema marks `indexed: true`.
 * Idempotent — used by the portable-md import path so a fresh import ends with
 * the same generated columns a live vault would have (the import writes
 * `tags.fields` via `upsertTagRecord` but never materializes the backing
 * columns). Without this, an imported vault's schemas say `indexed: true` but
 * queries fall back to full scans until each tag is next `update-tag`'d.
 *
 * `tagSchemas` is the post-import set of (tag, fields) pairs. Returns the
 * number of (tag, field) declarations replayed.
 */
export function reconcileDeclaredIndexes(
  db: Database,
  tagSchemas: { tag: string; fields?: Record<string, { type: string; indexed?: boolean }> }[],
): number {
  let declared = 0;
  for (const schema of tagSchemas) {
    if (!schema.fields) continue;
    for (const [fieldName, spec] of Object.entries(schema.fields)) {
      if (spec.indexed !== true) continue;
      const mapped = mapFieldType(spec.type);
      if (!mapped) continue; // unsupported type for indexing — skip, don't throw
      try {
        validateFieldName(fieldName);
        declareField(db, fieldName, mapped, schema.tag);
        declared++;
      } catch (err) {
        console.error(
          `[indexed-fields] could not re-declare "${fieldName}" for tag "${schema.tag}" on import:`,
          err,
        );
      }
    }
  }
  return declared;
}
