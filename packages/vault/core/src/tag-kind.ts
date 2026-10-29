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

/**
 * A row's effective kind, as SQL over `tags t`: a type when it has fields or
 * parents or is named as a parent (whatever was recorded: an older program
 * may have added fields to a record this one called a tag), else its recorded
 * kind (a type promoted with no fields stays one), else a tag. Being a parent is
 * read, never written onto the parent's record, so declaring a parent can't
 * change a record the caller may not be allowed to touch.
 */
export const KIND_SQL = `CASE WHEN ${IS_PARENT} OR ${HAS_STRUCTURE} THEN 'type' ELSE COALESCE(t.kind, 'tag') END`;

/** Every tag record's effective kind. */
export function tagKinds(db: Database): Map<string, TagKind> {
  const rows = db.prepare(`SELECT t.name AS name, ${KIND_SQL} AS kind FROM tags t`).all() as { name: string; kind: TagKind }[];
  return new Map(rows.map((r) => [r.name, r.kind]));
}

/** Which of `names` are types (only those rows are read: cheap on every note read). */
export function typeNamesAmong(db: Database, names: string[]): Set<string> {
  if (!names.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < names.length; i += 500) {
    const chunk = names.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT t.name AS name FROM tags t WHERE t.name IN (${chunk.map(() => "?").join(", ")}) AND ${KIND_SQL} = 'type'`)
      .all(...chunk) as { name: string }[];
    for (const r of rows) out.add(r.name);
  }
  return out;
}

/** The names whose effective kind is `type`. */
export function typeNames(db: Database): Set<string> {
  const rows = db.prepare(`SELECT t.name AS name FROM tags t WHERE ${KIND_SQL} = 'type'`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * The v33 migration's rule (§8a step 1): every row records its kind, `type`
 * when it has fields or parents, else `tag`. Being named as a parent is not
 * recorded: it is read live (KIND_SQL), on a migrated vault as on a new one,
 * so dropping the last child reads the same everywhere. Returns the effective
 * counts (parents included). Idempotent: rows that already have a kind keep it.
 */
export function recordTagKinds(db: Database): { types: number; tags: number } {
  db.exec(`UPDATE tags AS t SET kind = CASE WHEN ${HAS_STRUCTURE} THEN 'type' ELSE 'tag' END WHERE t.kind IS NULL`);
  // An older program may have given fields or parents to a record recorded as a tag.
  db.exec(`UPDATE tags AS t SET kind = 'type' WHERE t.kind = 'tag' AND ${HAS_STRUCTURE}`);
  const kinds = [...tagKinds(db).values()];
  return { types: kinds.filter((k) => k === "type").length, tags: kinds.filter((k) => k === "tag").length };
}

/** Whether some tag names `name` as a parent. */
export function isParent(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM tags t WHERE t.name = ? AND ${IS_PARENT}`).get(name);
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
 * The `types` a write names (§8a "writes accept both"): each must be a type
 * or a new name. A plain tag is refused with the fix, never silently promoted.
 * Reads only: nothing is made until the write has succeeded (markTypes).
 */
export function validateTypes(db: Database, names: string[]): string[] {
  const kinds = tagKinds(db);
  const out = [...new Set(names.map(stripTagHash).filter(Boolean))];
  for (const name of out) {
    if (kinds.get(name) === "tag") {
      throw kindError(
        `"${name}" is a plain tag, not a type. Use tags: ["${name}"], or make it a type first: manage-types {tag: "${name}", kind: "type"}.`,
        "types",
        `manage-types {tag: "${name}", kind: "type"}`,
      );
    }
  }
  return out;
}

/** After a write that named `types` succeeded: their records say type (the write itself made any that were new). */
export function markTypes(db: Database, names: string[]): void {
  const now = new Date().toISOString();
  for (const name of new Set(names)) {
    db.prepare("INSERT OR IGNORE INTO tags (name, kind, created_at, updated_at) VALUES (?, 'type', ?, ?)").run(name, now, now);
    db.prepare("UPDATE tags SET kind = 'type' WHERE name = ? AND kind IS NULL").run(name);
  }
}

/** Validate and mark at once, for a caller with no write to wait for. */
export function ensureTypes(db: Database, names: string[]): void {
  markTypes(db, validateTypes(db, names));
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
  // One filter carries both: only "all of them" can be said exactly. Anything else is refused, not guessed.
  if (types.length > 1 || (tags.length > 1 && rest.tag_match !== "all")) {
    throw kindError(
      "type with tag matches notes carrying all of them: pass one type, and one tag or tag_match: \"all\". For either-or, make two queries.",
      "type",
      'one type, and tag_match: "all"',
    );
  }
  return { ...rest, tag: [...tags, ...types], tag_match: "all" };
}

/**
 * A write's `types`, ready for it: validated (a plain tag is refused) and
 * merged into its tags, plus the names to mark as types once the write has
 * succeeded. An update that names no note (no id: the write will be refused for
 * that) is only merged, so nothing about a type, or a hidden tag's kind, is
 * looked at on the way. `named`: the caller names the note elsewhere (REST
 * PATCH, in its URL).
 */
export function prepareTypes(
  db: Database,
  item: Record<string, unknown>,
  mode: "create" | "update",
  opts: { named?: boolean } = {},
): { item: Record<string, unknown>; types: string[] } {
  if (!item || item.types === undefined) return { item, types: [] };
  assertNoBatchLevelTypes(item);
  if (mode === "update" && !opts.named && !item.id) return { item: mergeTypesIntoTags(item, mode), types: [] };
  const types = validateTypes(db, typesAdded(item, mode));
  return { item: mergeTypesIntoTags(item, mode), types };
}

/** prepareTypes over a call: its own types, or each batch item's. */
export function prepareCallTypes(
  db: Database,
  params: Record<string, unknown>,
  mode: "create" | "update",
  opts: { named?: boolean } = {},
): { params: Record<string, unknown>; types: string[] } {
  const top = prepareTypes(db, params, mode, opts);
  if (!Array.isArray(top.item.notes)) return { params: top.item, types: top.types };
  const types = [...top.types];
  const notes = (top.item.notes as Record<string, unknown>[]).map((n) => {
    const r = prepareTypes(db, n, mode);
    types.push(...r.types);
    return r.item;
  });
  return { params: { ...top.item, notes }, types };
}

const typesShapeError = (hint: string) => kindError(`types takes ${hint}.`, "types", hint);
const asList = (v: unknown, hint = "a list of names"): string[] => {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.some((x) => typeof x !== "string")) throw typesShapeError(hint);
  return list.map((x) => stripTagHash(x as string)).filter(Boolean);
};

/** The type names a write adds. */
function typesAdded(item: Record<string, unknown>, mode: "create" | "update"): string[] {
  const t = item.types as { add?: unknown } | string[] | string | undefined;
  if (mode === "create") return asList(t, "a list of names, e.g. types: [\"task\"]");
  if (Array.isArray(t) || typeof t === "string") return asList(t);
  if (!t || typeof t !== "object") throw typesShapeError('a list of names or {add, remove}');
  return asList(t.add, "{add: [names], remove: [names]}");
}

/**
 * The same write with its `types` moved into `tags`, with no side effects: what
 * a scope check must see (a tag-scoped writer's types are memberships like any
 * other). create: tags ∪ types; update: tags.add ∪ types.add, tags.remove ∪ types.remove.
 */
export function mergeTypesIntoTags(item: Record<string, unknown>, mode: "create" | "update"): Record<string, unknown> {
  if (!item || item.types === undefined) return item;
  assertNoBatchLevelTypes(item);
  const { types, ...rest } = item as { types: unknown } & Record<string, unknown>;
  const add = typesAdded(item, mode);
  if (mode === "create") return { ...rest, tags: [...new Set([...asList(rest.tags), ...add])] };
  const t = types as { remove?: unknown } | string[] | string;
  const remove = Array.isArray(t) || typeof t === "string" ? [] : asList(t?.remove, "{add: [names], remove: [names]}");
  const tags = rest.tags as { add?: unknown; remove?: unknown } | string[] | undefined;
  const tagAdd = Array.isArray(tags) ? asList(tags) : asList(tags?.add);
  const tagRemove = Array.isArray(tags) ? [] : asList(tags?.remove);
  return { ...rest, tags: { add: [...new Set([...tagAdd, ...add])], remove: [...new Set([...tagRemove, ...remove])] } };
}

/** `types` belongs to each note of a batch, never beside `notes`: refused before anything is checked or made. */
function assertNoBatchLevelTypes(item: Record<string, unknown>): void {
  if (Array.isArray(item.notes)) {
    throw kindError("types goes inside each note of a batch, not beside notes: notes: [{…, types: [...]}].", "types", "notes: [{…, types: [...]}]");
  }
}

/** After markTypes: the `types` of the notes a write returned, read again (they were computed before the marking). */
export function refreshTypes<T>(db: Database, out: T): T {
  const fix = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(fix);
    if (!n || typeof n !== "object") return n;
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.notes)) return { ...o, notes: o.notes.map(fix) };
    if (Array.isArray(o.tags) && "types" in o) {
      const types = typeNamesAmong(db, o.tags as string[]);
      return { ...o, types: (o.tags as string[]).filter((t) => types.has(t)) };
    }
    return n;
  };
  return fix(out) as T;
}
