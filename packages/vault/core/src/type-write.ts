/**
 * Write access may add a new type (T-476; docs/contracts/write-defines-types.md).
 *
 * A caller with `write` and not `admin`, and no tag scope, may define a type nobody has defined yet, and add fields to
 * a type it made itself (its creator stamp, `created_by` + `created_via` on the `tags` row, equals the caller's write
 * stamp). Everything else on types stays admin. One rule for both doors: MCP `manage-types {action: "update"}`
 * (mcp-surface.ts) and REST `PUT /api/tags/:name` (src/routes.ts).
 */
import type { Database } from "bun:sqlite";
import { getTagRecord } from "./tag-schemas.js";
import { DEFAULT_TAG_NAME } from "./tag-hierarchy.js";

/** The caller's write stamp: the same two facts its record writes carry. */
export interface TypeWriter {
  by: string | null;
  via: string | null;
}

/** What a write-only caller asks to change on a type. Keys absent from the request are absent here. */
export interface TypeChange {
  description?: unknown;
  fields?: unknown;
  relationships?: unknown;
  parent_names?: unknown;
  kind?: unknown;
  /** REST only: replace the field map instead of merging. */
  replace_fields?: unknown;
}

/** What write access may do with types, for the refusal's words. */
export const WRITE_MAY = "With write access you can make a new type, and add fields to a type you made.";

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function empty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return v === "";
}

/** The type's creator stamp, or null when it has none (made before this rule, by tagging, or imported). */
export function typeCreator(db: Database, name: string): TypeWriter | null {
  const row = db.prepare("SELECT created_by, created_via FROM tags WHERE name = ?").get(name) as
    | { created_by: string | null; created_via: string | null }
    | null;
  if (!row || (row.created_by === null && row.created_via === null)) return null;
  return { by: row.created_by, via: row.created_via };
}

/** Does any type name `name` among its parents (whether or not `name` has a row)? Fields flow to a parent's children. */
export function namedAsParent(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM tags t, json_each(CASE WHEN json_valid(t.parent_names) THEN t.parent_names ELSE '[]' END) p WHERE p.value = ? LIMIT 1").get(name);
}

/**
 * Has anyone defined this name as a type yet? No row, or a bare type row that records made by naming it as a type
 * (`create-record {types: ["book"]}`). A plain label (`tags: ["pinned"]`) is not a type nobody defined: making it one
 * stays admin's.
 */
export function typeIsUndefined(db: Database, name: string): boolean {
  const t = getTagRecord(db, name);
  if (!t) return true;
  if (t.kind !== "type" || typeCreator(db, name)) return false;
  return empty(t.fields) && empty(t.description) && empty(t.parent_names) && empty(t.relationships);
}

/**
 * Why a write-only caller may not make this change to type `name`, or null when it may. `scoped`: the caller is
 * tag-scoped (it may not). Read-only: changes nothing.
 */
export function writeTypeProblem(db: Database, name: string, change: TypeChange, writer: TypeWriter | null, scoped: boolean): string | null {
  const needs = (what: string) => `${what} needs admin. ${WRITE_MAY}`;
  if (scoped) return needs("Defining a type with a tag-scoped key");
  if (change.parent_names !== undefined) return needs("Setting parent_names");
  if (change.relationships !== undefined) return needs("Setting relationships");
  if (change.replace_fields !== undefined && change.replace_fields !== false) return needs("Replacing a type's fields");
  if (change.kind !== undefined && change.kind !== "type") return needs(`Making "${name}" a plain tag`);
  if (change.fields === null) return needs("Removing a type's fields");
  if (change.fields !== undefined && (typeof change.fields !== "object" || Array.isArray(change.fields))) {
    return "fields is an object: {field_name: {type, enum?, indexed?, default?}}.";
  }
  // Names whose fields reach other types' records: `_default` (every record's implicit parent), any `_` name the
  // vault keeps, and a name some type lists as its parent (its fields flow to that type's records).
  if (name === DEFAULT_TAG_NAME || name.startsWith("_")) return needs(`Changing "${name}", which every record inherits from,`);
  if (namedAsParent(db, name)) return needs(`Changing "${name}", another type's parent,`);
  if (typeIsUndefined(db, name)) return null;
  const creator = typeCreator(db, name);
  const own = creator !== null && writer !== null && writer.by !== null && writer.via !== null &&
    creator.by === writer.by && creator.via === writer.via;
  if (!own) return needs(`Changing "${name}", which you didn't make,`);
  const existing = (getTagRecord(db, name)?.fields ?? {}) as Record<string, unknown>;
  for (const [field, spec] of Object.entries((change.fields ?? {}) as Record<string, unknown>)) {
    if (field in existing && stable(existing[field]) !== stable(spec)) return needs(`Changing the field "${field}" of "${name}"`);
  }
  return null;
}

/**
 * Record who defined a type, once: when it had no creator stamp and no definition before this call. `wasUndefined` is
 * typeIsUndefined read before the write. Never overwrites a stamp.
 */
export function stampTypeCreator(db: Database, name: string, writer: TypeWriter | null, wasUndefined: boolean): void {
  if (!wasUndefined || !writer || (writer.by === null && writer.via === null)) return;
  db.prepare("UPDATE tags SET created_by = ?, created_via = ? WHERE name = ? AND created_by IS NULL AND created_via IS NULL")
    .run(writer.by, writer.via, name);
}
