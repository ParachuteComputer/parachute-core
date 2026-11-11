/**
 * Schema conformance check — count how many EXISTING notes would violate a
 * PROPOSED field spec for a tag, before the operator commits a tightening
 * (vault#283, the MW2/#314 tie-in).
 *
 * Motivation: marking a field `strict`/`required`, narrowing an `enum`, or
 * changing a `type` is a backwards-incompatible move — notes written under
 * the old contract may now reject on their next write
 * (`enforceStrictSchema` → `SchemaValidationError`). The Schema editor in
 * the admin SPA calls this BEFORE save so the operator sees "N existing
 * notes violate this — they'll reject on next write" and is pointed at the
 * `parachute-vault schema migrate-field` CLI (#314) rather than silently
 * shipping a contract their own data breaks.
 *
 * What "violate" means here: we overlay the PROPOSED `fields` for `tag` on
 * top of the live schema config, treating every proposed field as if it
 * were `strict:true` for the purpose of the count (so the count is "notes
 * that would hard-reject IF this field were strict" — the worst case the
 * operator is being warned about). We then walk every note carrying `tag`
 * (descendants included, per the hierarchy) and run the SAME `validateNote`
 * resolver the write path uses, counting notes with ≥1 violation on a field
 * the proposal touches.
 *
 * This is a READ — no mutation. It's deliberately scoped to the proposed
 * tag's own fields (the columns the operator is editing); inherited fields
 * from ancestors are already enforced and aren't what the operator is
 * tightening in this edit.
 */

import { Database } from "bun:sqlite";
import {
  loadSchemaConfig,
  parseFieldsJson,
  validateNote,
  type SchemaField,
  type ResolvedSchemas,
  type ReferenceTargetLookup,
} from "./schema-defaults.js";
import { resolveLinkTargetDetailed } from "./wikilinks.js";
import type { TagFieldSchema } from "./tag-schemas.js";
import { getTagDescendants, loadTagHierarchy } from "./tag-hierarchy.js";
import { getNotes, getNoteTagsForNotes } from "./notes.js";
import { chunkForInClause } from "./sql-in.js";

export interface ConformanceViolation {
  /** Note id of a non-conforming note. */
  id: string;
  /** Note path, when set (helps the operator find it). */
  path?: string | null;
  /** The proposed-field violations on this note (reasons + messages). */
  fields: { field: string; reason: string; message: string }[];
}

export interface ConformanceReport {
  tag: string;
  /** Total notes carrying the tag (descendants included). */
  total_notes: number;
  /** Count of notes that would violate the proposed spec. */
  violating_notes: number;
  /** The field names the proposal touches (the ones checked). */
  checked_fields: string[];
  /**
   * A bounded sample of violating notes (id + path + which fields), so the
   * SPA can show examples without paging the whole vault. Capped at
   * `sampleLimit` (default 20).
   */
  sample: ConformanceViolation[];
}

/**
 * Convert the on-disk `TagFieldSchema` shape to the resolver's `SchemaField`
 * shape, FORCING `strict:true` so `validateNote` flags every constraint as a
 * (strict) violation we can count. `indexed` is dropped — it's not a
 * note-data constraint. `type` is narrowed to the resolver's union; an
 * unknown type string is dropped (no type check) rather than throwing.
 */
function toStrictSchemaField(spec: TagFieldSchema): SchemaField {
  const out: SchemaField = { strict: true };
  if (
    spec.type === "string" ||
    spec.type === "number" ||
    spec.type === "integer" ||
    spec.type === "boolean" ||
    spec.type === "array" ||
    spec.type === "object" ||
    spec.type === "date"
  ) {
    out.type = spec.type;
  }
  if (Array.isArray(spec.enum)) out.enum = spec.enum;
  if (spec.required === true) out.required = true;
  if (spec.cardinality === "one" || spec.cardinality === "many") {
    out.cardinality = spec.cardinality;
  }
  if (typeof spec.description === "string") out.description = spec.description;
  return out;
}

/**
 * Build a `ResolvedSchemas` snapshot with the proposed fields overlaid on
 * `tag`'s OWN field map. We start from the live config (so inheritance +
 * other tags are intact) and replace just `tag`'s field declarations with
 * the strict-forced proposed set.
 */
function overlayProposedSchema(
  base: ResolvedSchemas,
  tag: string,
  proposedFields: Record<string, TagFieldSchema>,
): ResolvedSchemas {
  const tagToFields = new Map(base.tagToFields);
  const forced: Record<string, SchemaField> = {};
  for (const [name, spec] of Object.entries(proposedFields)) {
    forced[name] = toStrictSchemaField(spec);
  }
  if (Object.keys(forced).length > 0) {
    tagToFields.set(tag, forced);
  } else {
    tagToFields.delete(tag);
  }
  return {
    allTags: new Set(base.allTags).add(tag),
    tagToFields,
    tagToParents: base.tagToParents,
  };
}

/**
 * Count existing notes that would violate the PROPOSED field spec for `tag`.
 *
 * `proposedFields` is the full merged field map the operator intends to save
 * (the same object the PUT body carries). Only the fields in this map are
 * checked — the violation count answers "if I tighten THESE fields, how many
 * notes break?" The check runs against every note carrying `tag` or any of
 * its descendants.
 *
 * Pure read; no mutation. Returns 0 violating notes when `proposedFields` is
 * empty (nothing to enforce).
 *
 * The walk is UNBOUNDED — every note carrying the tag or a descendant, not a
 * `queryNotes` page (vault#592). `total_notes` is a real total.
 */
export function countConformanceViolations(
  db: Database,
  tag: string,
  proposedFields: Record<string, TagFieldSchema>,
  opts: { sampleLimit?: number } = {},
): ConformanceReport {
  const sampleLimit = opts.sampleLimit ?? 20;
  const checkedFields = Object.keys(proposedFields);

  const empty: ConformanceReport = {
    tag,
    total_notes: 0,
    violating_notes: 0,
    checked_fields: checkedFields,
    sample: [],
  };

  // Resolve the tag's descendant set so we count notes on subtype tags too
  // (a strict field on `#dev` applies to `#dev/log` notes via inheritance).
  const hierarchy = loadTagHierarchy(db);
  const tagSet = Array.from(getTagDescendants(hierarchy, tag));
  if (tagSet.length === 0) return empty;

  // All notes carrying the tag (or a descendant) — a note on ANY of these
  // tags is in scope.
  //
  // UNBOUNDED id sweep (vault#592). This used to call
  // `queryNotes(db, { tags: tagSet, tagMatch: "any" })` with no `limit`,
  // which silently inherits that function's default `LIMIT 100`
  // (`notes.ts`) — so on a tag with more than 100 notes both `total_notes`
  // and the violation scan reported the first page only. The operator was
  // told "3 of 100 notes violate this" for a 1,200-note tag, and violations
  // living past note 100 were never even looked at. A conformance count that
  // undercounts is worse than no count: it is the number the operator
  // decides on.
  //
  // Same shape as `SqliteStore.backfillReferenceFieldLinks` (store.ts),
  // which fixed the identical inherited-cap bug on the reference backfill: a
  // direct `note_tags` scan chunked under the IN-param cap, deduped across
  // tags (a note carrying both `dev` and `dev/log` is ONE note), then
  // hydrated in a batch. Still a pure read.
  const idSet = new Set<string>();
  for (const chunk of chunkForInClause(tagSet)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT DISTINCT note_id FROM note_tags WHERE tag_name IN (${placeholders})`)
      .all(...chunk) as { note_id: string }[];
    for (const r of rows) idSet.add(r.note_id);
  }
  if (idSet.size === 0) return empty;

  const notes = getNotes(db, Array.from(idSet));
  if (notes.length === 0) return empty;

  if (checkedFields.length === 0) {
    return { ...empty, total_notes: notes.length };
  }

  const base = loadSchemaConfig(db);
  const resolved = overlayProposedSchema(base, tag, proposedFields);
  const checkedSet = new Set(checkedFields);

  const tagsById = getNoteTagsForNotes(
    db,
    notes.map((n) => n.id),
  );

  let violating = 0;
  const sample: ConformanceViolation[] = [];

  for (const note of notes) {
    const tags = tagsById.get(note.id) ?? note.tags ?? [];
    const status = validateNote(resolved, {
      path: note.path ?? null,
      tags,
      metadata: note.metadata ?? {},
    });
    if (!status) continue;
    // Keep only violations on a field the PROPOSAL touches (ignore conflicts
    // + violations on inherited/other fields the operator isn't editing).
    // Only the proposal's own violations (`schema === tag`): 0.9.2 also
    // checks a record's other types (advisory), which this edit doesn't touch.
    const relevant = status.warnings.filter(
      (w) => w.reason !== "schema_conflict" && checkedSet.has(w.field) && w.schema === tag,
    );
    if (relevant.length === 0) continue;
    violating++;
    if (sample.length < sampleLimit) {
      sample.push({
        id: note.id,
        path: note.path ?? null,
        fields: relevant.map((w) => ({
          field: w.field,
          reason: w.reason,
          message: w.message,
        })),
      });
    }
  }

  return {
    tag,
    total_notes: notes.length,
    violating_notes: violating,
    checked_fields: checkedFields,
    sample,
  };
}

// ---------------------------------------------------------------------------
// Retype refusal (0.9.2 "safe schema change")
// ---------------------------------------------------------------------------

/** One field a proposed type change would strand records on. */
export interface RetypeConflict {
  field: string;
  /** The field's declared type today. */
  from: string | null;
  /** The type the proposal declares. */
  to: string | null;
  /** Records carrying the type (or a subtype) whose value the new spec refuses. */
  count: number;
  /** A few of them (id, path), for the person fixing the data. */
  sample: { id: string; path: string | null }[];
}

/**
 * The fields whose declared `type` this proposal changes, with the records
 * the change would strand: records whose current value the NEW spec refuses
 * as a strict violation, so their next edit would be refused (422) until the
 * value is fixed. Counted with the write path's own `validateNote`, on the
 * proposal overlaid as it would be saved (its real `strict` and `indexed`,
 * not forced strict as the conformance warning above does), so a retype this
 * accepts can't be followed by an edit the validator refuses, and the other
 * way round.
 *
 * Only a change of `type` on a field the tag already declares is a retype. A
 * new field, a removed field, or a tightened enum is not checked here (the
 * conformance count above warns about those). A retype of a loose field
 * (neither strict nor indexed) strands nothing: its records keep advisory
 * warnings.
 */
export function findRetypeConflicts(
  db: Database,
  tag: string,
  proposedFields: Record<string, TagFieldSchema> | null,
  opts: { sampleLimit?: number } = {},
): RetypeConflict[] {
  if (!proposedFields) return [];
  const row = db.prepare("SELECT fields FROM tags WHERE name = ?").get(tag) as { fields: string | null } | null;
  const current = parseFieldsJson(row?.fields ?? null);
  const proposed = parseFieldsJson(JSON.stringify(proposedFields));
  const retyped = Object.keys(proposed).filter(
    (f) => current[f] !== undefined && (current[f]!.type ?? null) !== (proposed[f]!.type ?? null),
  );
  if (retyped.length === 0) return [];

  // The records the tag's fields apply to: those carrying it or a subtype.
  // `_default` applies to every record, tagged or not.
  const idSet = new Set<string>();
  if (tag === "_default") {
    for (const r of db.prepare("SELECT id FROM notes").all() as { id: string }[]) idSet.add(r.id);
  } else {
    const tagSet = Array.from(getTagDescendants(loadTagHierarchy(db), tag));
    for (const chunk of chunkForInClause(tagSet)) {
      const rows = db
        .prepare(`SELECT DISTINCT note_id FROM note_tags WHERE tag_name IN (${chunk.map(() => "?").join(", ")})`)
        .all(...chunk) as { note_id: string }[];
      for (const r of rows) idSet.add(r.note_id);
    }
  }
  const conflicts = new Map<string, RetypeConflict>(
    retyped.map((f) => [f, { field: f, from: current[f]!.type ?? null, to: proposed[f]!.type ?? null, count: 0, sample: [] }]),
  );
  if (idSet.size > 0) {
    const base = loadSchemaConfig(db);
    const tagToFields = new Map(base.tagToFields);
    tagToFields.set(tag, proposed);
    const resolved: ResolvedSchemas = { ...base, allTags: new Set(base.allTags).add(tag), tagToFields };
    // The write path's reference check (store.validateNoteAgainstSchemas), so a
    // strict `target_tags` is counted. Unscoped: the refusal counts every record.
    const lookup: ReferenceTargetLookup = (value) => {
      const hit = resolveLinkTargetDetailed(db, value);
      if (!hit.resolved || !hit.note_id) return { status: "unresolved" };
      const rows = db.prepare("SELECT tag_name FROM note_tags WHERE note_id = ?").all(hit.note_id) as { tag_name: string }[];
      return { status: "resolved", tags: rows.map((r) => r.tag_name) };
    };
    const strictOn = (status: ReturnType<typeof validateNote>) =>
      new Set((status?.warnings ?? []).filter((w) => w.strict === true && conflicts.has(w.field)).map((w) => w.field));
    const sampleLimit = opts.sampleLimit ?? 5;
    for (const chunk of chunkForInClause(Array.from(idSet))) {
      const notes = getNotes(db, chunk);
      const tagsById = getNoteTagsForNotes(db, notes.map((n) => n.id));
      for (const note of notes) {
        const n = { path: note.path ?? null, tags: tagsById.get(note.id) ?? note.tags ?? [], metadata: note.metadata ?? {} };
        const after = strictOn(validateNote(resolved, n, lookup));
        if (after.size === 0) continue;
        // Stranded BY this change: refused under the proposal, not already
        // refused under the type as it is (that record is stuck either way,
        // and migrating can't be what frees it).
        const before = strictOn(validateNote(base, n, lookup));
        for (const f of after) {
          if (before.has(f)) continue;
          const c = conflicts.get(f)!;
          c.count++;
          if (c.sample.length < sampleLimit) c.sample.push({ id: note.id, path: note.path ?? null });
        }
      }
    }
  }
  return [...conflicts.values()].filter((c) => c.count > 0);
}

/** The hint a retype refusal carries: what to run instead, on either door. */
export function retypeHint(tag: string, c: RetypeConflict): string {
  const kind = c.to === "string" ? "to_string" : c.to === "integer" ? "to_int" : c.to === "number" ? "to_number" : c.to === "boolean" ? "to_boolean" : null;
  const transform = kind ? `{kind: "${kind}"}` : `{kind: "remap", map: {<old value>: <new value>}}`;
  const n = c.count === 1 ? "1 record holds" : `${c.count} records hold`;
  return `${n} a "${c.field}" value a ${c.to ?? "changed"} field refuses, and couldn't be edited after this change. Change the values first with migrate: manage-types {action: "migrate", tag: "${tag}", field: "${c.field}", transform: ${transform}} (or POST /api/types/${encodeURIComponent(tag)}/migrate with the same body). It is a dry run that says what would change; add apply: true to write. Then retype.`;
}
