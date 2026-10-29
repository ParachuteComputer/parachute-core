/**
 * Types and tags (T-318 design §8a). One membership store (`note_tags`,
 * unchanged); each tag record carries an explicit `kind`:
 *
 *   - `type`: has fields and/or a hierarchy (`parent_names`), or is named as
 *     another tag's parent. `person`, `task`, `event/meeting`.
 *   - `tag`: a flat label. `a/b` names are allowed, but they are just names.
 *
 * Fields and parents belong to types only. Setting either on a tag record
 * makes it a type, unless the caller explicitly says `kind: "tag"`, which is
 * refused with the fix. A record made implicitly (a note tagged with a new
 * name) has `kind` NULL and is read by the same rule the migration applies,
 * so it reads as a tag until it gains fields or children.
 *
 * Notes keep `tags` (every name, as before, so 0.8 clients and Prism's
 * contract hold through 0.9) and gain `types`, the subset that are types.
 */
import type { Database } from "bun:sqlite";
import { stripTagHash } from "./tag-hierarchy.js";

export type TagKind = "type" | "tag";

/** SQL for "this row has fields or parents" (stored as JSON text; '{}' / '[]' / 'null' are empty). */
const HAS_STRUCTURE = `((t.fields IS NOT NULL AND t.fields NOT IN ('', '{}', 'null'))
  OR (t.parent_names IS NOT NULL AND t.parent_names NOT IN ('', '[]', 'null')))`;

/** SQL for "some tag names this row as a parent". */
const IS_PARENT = `t.name IN (SELECT DISTINCT p.value FROM tags pt, json_each(CASE WHEN json_valid(pt.parent_names) THEN pt.parent_names ELSE '[]' END) p)`;

/** The rule: what a row's kind is when nothing explicit is recorded (and what the v33 migration records). */
const DERIVED_KIND = `CASE WHEN ${HAS_STRUCTURE} OR ${IS_PARENT} THEN 'type' ELSE 'tag' END`;

/** A row's effective kind, as SQL over `tags t`. */
export const KIND_SQL = `COALESCE(t.kind, ${DERIVED_KIND})`;

/** Every tag record's effective kind. */
export function tagKinds(db: Database): Map<string, TagKind> {
  const rows = db.prepare(`SELECT t.name AS name, COALESCE(t.kind, ${DERIVED_KIND}) AS kind FROM tags t`).all() as { name: string; kind: TagKind }[];
  return new Map(rows.map((r) => [r.name, r.kind]));
}

/** The names whose effective kind is `type`. */
export function typeNames(db: Database): Set<string> {
  const rows = db.prepare(`SELECT t.name AS name FROM tags t WHERE COALESCE(t.kind, ${DERIVED_KIND}) = 'type'`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * The v33 migration's rule (§8a step 1): every row gets an explicit kind,
 * `type` when it has fields or parents or is named as a parent, else `tag`.
 * Idempotent: rows that already have a kind keep it.
 */
export function recordTagKinds(db: Database): { types: number; tags: number } {
  db.exec(`UPDATE tags AS t SET kind = ${DERIVED_KIND} WHERE t.kind IS NULL`);
  const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM tags GROUP BY kind").all() as { kind: TagKind; n: number }[];
  return { types: rows.find((r) => r.kind === "type")?.n ?? 0, tags: rows.find((r) => r.kind === "tag")?.n ?? 0 };
}

/**
 * The dry-run report (§8a step 2): plain tags used like a type, for the owner
 * to promote with `manage-types {tag, kind: "type"}`. "Used like a type" is
 * a plain tag on at least `minNotes` notes. Counts and names only.
 */
export function typeKindReport(db: Database, minNotes = 20): {
  types: number;
  tags: number;
  look_like_types: { name: string; notes: number }[];
  slash_tags: number;
} {
  const kinds = tagKinds(db);
  const counts = db.prepare("SELECT tag_name AS name, COUNT(*) AS n FROM note_tags GROUP BY tag_name").all() as { name: string; n: number }[];
  const look = counts
    .filter((c) => (kinds.get(c.name) ?? "tag") === "tag" && c.n >= minNotes)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, notes: c.n }));
  const all = [...kinds.values()];
  return {
    types: all.filter((k) => k === "type").length,
    tags: all.filter((k) => k === "tag").length,
    look_like_types: look,
    slash_tags: [...kinds.entries()].filter(([name, k]) => k === "tag" && name.includes("/")).length,
  };
}

/** A structured, teaching error (mcp-http maps `error_type` to JSON-RPC invalid params; REST to 400/422). */
export function kindError(message: string, field: string, hint: string): Error {
  return Object.assign(new Error(message), { error_type: "tag_kind", field, hint });
}

/**
 * The `types` a write names (§8a "writes accept both"): each must be a type, or
 * a new name, which is then recorded as a type. A plain tag is refused with
 * the fix, never silently promoted.
 */
export function ensureTypes(db: Database, names: string[]): void {
  const kinds = tagKinds(db);
  const now = new Date().toISOString();
  for (const name of names.map(stripTagHash).filter(Boolean)) {
    const kind = kinds.get(name);
    if (kind === "tag") {
      throw kindError(
        `"${name}" is a plain tag, not a type. Use tags: ["${name}"], or make it a type first: manage-types {tag: "${name}", kind: "type"}.`,
        "types",
        `manage-types {tag: "${name}", kind: "type"}`,
      );
    }
    if (kind === undefined) {
      db.prepare("INSERT OR IGNORE INTO tags (name, kind, created_at, updated_at) VALUES (?, 'type', ?, ?)").run(name, now, now);
    }
  }
}

/**
 * For a query's `type` filter: a plain tag is refused with the fix. A name
 * with no record matches nothing, as `tag` does: no error, so a tag-scoped
 * caller (whose hidden names the server rewrites before this runs) can't tell
 * a hidden type from an absent one.
 */
export function assertTypes(db: Database, names: string[]): void {
  const kinds = tagKinds(db);
  for (const name of names.map(stripTagHash)) {
    if (kinds.get(name) !== "tag") continue;
    throw kindError(`"${name}" is a plain tag, not a type: filter with tag: "${name}".`, "type", `tag: "${name}"`);
  }
}

/**
 * query-notes `type` (§8a "queries"): a type and its subtypes. Folded into the
 * tag filter, which already expands subtypes: several types match any of them;
 * `type` with `tag` matches all of them.
 */
export function foldTypeFilter(db: Database, params: Record<string, unknown>): Record<string, unknown> {
  if (params.type === undefined) return params;
  const types = (Array.isArray(params.type) ? params.type : [params.type]).map(String);
  assertTypes(db, types);
  if (params.expand !== undefined && params.expand !== "subtypes") {
    throw kindError("type always includes subtypes; drop expand, or use tag.", "expand", "drop expand");
  }
  const { type: _type, ...rest } = params;
  if (rest.tag === undefined) return { ...rest, tag: types, tag_match: rest.tag_match ?? "any" };
  const tags = (Array.isArray(rest.tag) ? rest.tag : [rest.tag]).map(String);
  return { ...rest, tag: [...tags, ...types], tag_match: "all" };
}

/**
 * create-note / update-note `types` (§8a "writes accept both"): each name must
 * be a type (or new, then made one) and lands in the one membership store as
 * a tag does. create takes an array; update takes an array (add) or {add, remove}.
 */
export function foldTypesIntoTags(db: Database, item: Record<string, unknown>, mode: "create" | "update"): Record<string, unknown> {
  if (!item || item.types === undefined) return item;
  ensureTypes(db, typesAdded(item, mode));
  return mergeTypesIntoTags(item, mode);
}

const asList = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map((x) => stripTagHash(String(x))).filter(Boolean));

/** The type names a write adds. */
function typesAdded(item: Record<string, unknown>, mode: "create" | "update"): string[] {
  const t = item.types as { add?: unknown } | string[] | string | undefined;
  return mode === "create" || Array.isArray(t) || typeof t === "string" ? asList(t) : asList(t?.add);
}

/**
 * The same write with its `types` moved into `tags`, with no side effects: what
 * a scope check must see (a tag-scoped writer's types are memberships like any
 * other). create: tags ∪ types; update: tags.add ∪ types.add, tags.remove ∪ types.remove.
 */
export function mergeTypesIntoTags(item: Record<string, unknown>, mode: "create" | "update"): Record<string, unknown> {
  if (!item || item.types === undefined) return item;
  const { types, ...rest } = item as { types: unknown } & Record<string, unknown>;
  const add = typesAdded(item, mode);
  if (mode === "create") return { ...rest, tags: [...new Set([...asList(rest.tags), ...add])] };
  const t = types as { remove?: unknown } | string[] | string;
  const remove = Array.isArray(t) || typeof t === "string" ? [] : asList(t?.remove);
  const tags = rest.tags as { add?: unknown; remove?: unknown } | string[] | undefined;
  const tagAdd = Array.isArray(tags) ? asList(tags) : asList(tags?.add);
  const tagRemove = Array.isArray(tags) ? [] : asList(tags?.remove);
  return { ...rest, tags: { add: [...new Set([...tagAdd, ...add])], remove: [...new Set([...tagRemove, ...remove])] } };
}
