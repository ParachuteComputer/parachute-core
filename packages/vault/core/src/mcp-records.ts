/**
 * The record surface (T-407; Aaron, 11-07: "record" is the noun). Five MCP
 * tools speak record words over the five note-named ones, through this one
 * translator; storage, the engine and every other tool stay as they are.
 *
 *   query-notes → query-records    create-note → create-record
 *   update-note → update-record    delete-note → delete-record
 *   list-tags   → list-types
 *
 * On the record tools a record's data is `fields` and its text is `body`
 * (`BODY` and `FIELDS` below: flip them to "content"/"metadata" and the new
 * tools speak the old wire words, nothing else moves). A batch is `records`,
 * an anchor is `{id}`. Every record carries `types` (what it is, several
 * allowed) and `tags` (plain labels: the names on it that aren't types).
 *
 * The note-named tools and the note-named parameters on the record tools stay
 * as aliases through 0.9 only; 1.0 removes them. Each use is counted by name
 * (the caller passes `onUse`), so the removal can wait on real use.
 *
 * Pure: no imports, so the cloud runtime can apply the same surface.
 */

/** A record's text on the record tools. "content" puts the old wire word back. */
import { HYBRID_TEXT } from "./hybrid.js";

export const BODY = "body";
/** A record's data on the record tools. "metadata" puts the old wire word back. */
export const FIELDS = "fields";

/** Note-named tool → its record-named replacement. */
export const RECORD_TOOL_NAMES: Readonly<Record<string, string>> = {
  "query-notes": "query-records",
  "create-note": "create-record",
  "update-note": "update-record",
  "delete-note": "delete-record",
  "list-tags": "list-types",
};
/** Record-named tool → the note-named tool it runs. */
export const NOTE_TOOL_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RECORD_TOOL_NAMES).map(([a, b]) => [b, a]),
);

/** Record-door parameter → the note-door parameter it is, per tool. Identity pairs (BODY = "content") drop out. */
const pairs = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).filter(([a, b]) => a !== b));
const BODYISH = pairs({
  [BODY]: "content",
  [`${BODY}_edit`]: "content_edit",
  [`include_${BODY}`]: "include_content",
  [`include_${FIELDS}`]: "include_metadata",
  [`${BODY}_offset`]: "content_offset",
  [`${BODY}_length`]: "content_length",
});
const PARAMS: Record<string, Record<string, string>> = {
  "query-records": pairs({ ...BODYISH, [FIELDS]: "metadata" }),
  "create-record": pairs({ [BODY]: "content", [FIELDS]: "metadata", records: "notes" }),
  "update-record": pairs({ [BODY]: "content", [`${BODY}_edit`]: "content_edit", [FIELDS]: "metadata", records: "notes" }),
  "delete-record": {},
  "list-types": { name: "tag" },
};
/** Inside these objects an anchor is `{id}` on the record door, `{note_id}` on the note door. */
const ANCHORS = ["near", "versions"];

/**
 * Output keys: note door → record door. A record's own fields are never walked, so a user's `content` key stays.
 * An anchor you pass is `{id}`; a key in an answer that points at another record is `record_id`.
 */
const KEYS_OUT: Record<string, string> = pairs({
  content: BODY,
  metadata: FIELDS,
  notes: "records",
  note_id: "record_id",
  note_path: "record_path",
  content_total_length: `${BODY}_total_length`,
  content_next_offset: `${BODY}_next_offset`,
  content_offset: `${BODY}_offset`,
  content_length: `${BODY}_length`,
});
/** Keys whose string values are the server's own words (quoted parts left alone: recordWords). */
const MESSAGE_KEYS = new Set(["error", "message", "hint", "how_to", "warning", "remedy", "reason", "use"]);

export interface RecordToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  requiredVerb: "read" | "write" | "admin";
  /** The MCP content blocks for a result, when not the one JSON text block (the note aliases' refresh nudge). */
  resultContent?: (result: unknown) => ({ type: "text"; text: string } | { type: string; [k: string]: unknown })[];
  /** A note alias's nudge, for a reply that also goes out as `structuredContent` (mcp-result.ts). */
  deprecation?: { tool: string; use: string; removed_in: string; notice: string };
}

/** What a use is counted as: `tool` for a tool name, `tool param` for a parameter on it. */
export type OnUse = (name: string, kind: "old" | "new") => void;

// ---------------------------------------------------------------------------
// Words: the server's own text, in record words
// ---------------------------------------------------------------------------

const TOOL_RE = new RegExp(`\\b(${Object.keys(RECORD_TOOL_NAMES).join("|")})\\b`, "g");

/**
 * The server's own text (descriptions, messages, hints) in record words. Never
 * applied to vault data: names, paths, a record's fields or body.
 */
export function recordWords(s: string): string {
  // Quoted text is what the caller passed in (a path, a tag, a field name, a value): echoed back as it was.
  // A single quote counts only at a word's edge, so an apostrophe (a record's body, it's) never opens one.
  return s.split(/("[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w))/).map((part, i) => (i % 2 === 1 ? part : prose(part))).join("");
}
function prose(s: string): string {
  return s
    .replace(TOOL_RE, (m) => RECORD_TOOL_NAMES[m]!)
    .replace(/\bnote_id\b/g, "id")
    .replace(/\bnote_path\b/g, "record_path")
    .replace(/\bcontent_edit\b/g, `${BODY}_edit`)
    .replace(/\binclude_content\b/g, `include_${BODY}`)
    .replace(/\binclude_metadata\b/g, `include_${FIELDS}`)
    .replace(/\bcontent_(offset|length|total_length|next_offset)\b/g, `${BODY}_$1`)
    .replace(/`metadata`/g, `\`${FIELDS}\``)
    .replace(/`content`/g, `\`${BODY}\``)
    .replace(/`notes`/g, "`records`")
    .replace(/\bindexed metadata fields?\b/g, (m) => m.replace("metadata ", ""))
    .replace(/\bmetadata (fields?)\b/g, "$1")
    .replace(/\bmetadata\b/g, FIELDS)
    .replace(/\bMetadata\b/g, FIELDS[0]!.toUpperCase() + FIELDS.slice(1))
    .replace(/\bnote's\b/g, "record's")
    .replace(/\bnotes'\b/g, "records'")
    .replace(/\b([Nn])ote(s?)\b/g, (_m, c: string, pl: string) => (c === "N" ? "Record" : "record") + pl);
}

/** A JSON Schema in record words: property names through the tool's map, descriptions through recordWords. */
function schemaOut(s: unknown, tool: string, top = true): unknown {
  if (Array.isArray(s)) return s.map((x) => schemaOut(x, tool, top));
  if (!s || typeof s !== "object") return s;
  const back = Object.fromEntries(Object.entries(PARAMS[tool] ?? {}).map(([a, b]) => [b, a]));
  const name = (p: string, anchor: boolean) => (anchor && p === "note_id" ? "id" : top ? (back[p] ?? p) : p);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "description" && typeof v === "string") out[k] = recordWords(v);
    else if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([p, d]) => [name(p, false), ANCHORS.includes(p) ? anchorSchema(d, tool) : schemaOut(d, tool, false)]),
      );
    } else if (k === "required" && Array.isArray(v)) out[k] = v.map((p) => name(String(p), false));
    else out[k] = schemaOut(v, tool, false);
  }
  return out;
}
function anchorSchema(d: unknown, tool: string): unknown {
  const s = schemaOut(d, tool, false) as Record<string, any>;
  if (s?.properties?.note_id) {
    const { note_id, ...rest } = s.properties;
    s.properties = { id: note_id, ...rest };
  }
  if (Array.isArray(s?.required)) s.required = s.required.map((p: string) => (p === "note_id" ? "id" : p));
  return s;
}

/** A tool's short or reference schema, renamed for its record tool. */
export function recordSchema(noteTool: string, schema: Record<string, unknown>): Record<string, unknown> {
  return schemaOut(schema, RECORD_TOOL_NAMES[noteTool] ?? noteTool) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Calls in and answers out
// ---------------------------------------------------------------------------

function conflict(tool: string, a: string, b: string): Error {
  return Object.assign(new Error(`${tool}: pass \`${a}\` or \`${b}\`, not both (\`${b}\` is its old name).`), {
    error_type: "invalid_query",
    field: a,
    hint: `use ${a}`,
  });
}

/**
 * A record-door call → the note-door call. Old names are taken too, counted, and
 * refused only beside their new name. A record's fields are never walked.
 */
export function paramsIn(tool: string, params: Record<string, unknown>, onUse?: OnUse): Record<string, unknown> {
  const map = PARAMS[tool] ?? {};
  const olds = new Set(Object.values(map));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (olds.has(k)) {
      const fresh = Object.keys(map).find((a) => map[a] === k)!;
      if (fresh in (params ?? {})) throw conflict(tool, fresh, k);
      onUse?.(`${tool} ${k}`, "old");
    }
    out[map[k] ?? k] = v;
  }
  for (const a of ANCHORS) {
    const v = out[a];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ("note_id" in o) {
        if ("id" in o) throw conflict(tool, `${a}.id`, `${a}.note_id`);
        onUse?.(`${tool} ${a}.note_id`, "old");
      } else if ("id" in o) {
        const { id, ...rest } = o;
        out[a] = { note_id: id, ...rest };
      }
    }
  }
  if (Array.isArray(out.notes)) {
    out.notes = out.notes.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? paramsIn(tool, item as Record<string, unknown>, onUse) : item));
  }
  return out;
}

/** Plain labels: the names on a record that aren't its types. */
function labels(tags: unknown, types: unknown): unknown {
  if (!Array.isArray(tags) || !Array.isArray(types)) return tags;
  const t = new Set(types);
  return tags.filter((x) => !t.has(x));
}

/**
 * A person's own names and values, passed through untouched: a record's fields, a link's relationships, and the
 * schema check's report (its `field`, enum values and type names are theirs, not the server's parameters).
 */
const OPAQUE = new Set(["metadata", "fields", "relationships", "validation_status"]);

function walkOut(tool: string, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => walkOut(tool, x));
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Only a warning about the call's own parameters names a parameter in `field`.
  const aboutParams = o.code === "unknown_parameter" || o.error_type === "unknown_parameter";
  for (const [k, val] of Object.entries(o)) {
    const nk = KEYS_OUT[k] ?? k;
    if (OPAQUE.has(k)) out[nk] = val;
    else if (k === "tags" && Array.isArray(o.types)) out[nk] = labels(val, o.types);
    else if (k === "field" && typeof val === "string") out[nk] = aboutParams ? fieldOut(tool, val) : val;
    else if (MESSAGE_KEYS.has(k) && typeof val === "string") out[nk] = recordWords(val);
    else out[nk] = walkOut(tool, val);
  }
  return out;
}

/** A parameter name the server reports on this tool (`warnings[].field`, an error's `field`), in record words. */
function fieldOut(tool: string, f: string): string {
  const back: Record<string, string> = { note_id: "id" };
  for (const [a, b] of Object.entries(PARAMS[tool] ?? {})) back[b] = a;
  const [head, ...rest] = f.split(".");
  const anchor = ANCHORS.includes(head!);
  return [back[head!] ?? head, ...rest.map((p) => (anchor && p === "note_id" ? "id" : p))].join(".");
}

/** A note-door answer → the record door's. Only the server's keys and words move; vault data stays as it is. */
export function resultOut(tool: string, r: unknown): unknown {
  if (tool === "list-types") return r; // tag rows: name, kind, counts, fields — already the right words
  return walkOut(tool, r);
}

/** A note-door error, rewritten in place for the record door (frozen errors keep their own words). */
export function errorOut(err: unknown, tool = ""): unknown {
  const e = err as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return err;
  try {
    if (err instanceof Error) err.message = recordWords(err.message);
    for (const k of ["hint", "how_to"]) if (typeof e[k] === "string") e[k] = recordWords(e[k] as string);
    // Only an error about the call's parameters names a parameter; a schema or transition error names a person's field.
    const aboutParams = ["unknown_parameter", "invalid_query", "missing_required_field", "content_edit_not_found", "content_edit_ambiguous", "invalid_content_edit"].includes(String(e.error_type));
    if (typeof e.field === "string" && aboutParams) e.field = fieldOut(tool, e.field);
  } catch {}
  return err;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const HELP = (tool: string) => `Every parameter: vault-info {help: "${tool}"}.`;

/** The record tools' own descriptions: #21's short text with the 0.9 sentences, in record words. */
export const RECORD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "query-records": `Read records: one record, a filtered list, a search, a link neighbourhood or path, counts, or a record's history.
- One record: \`id\` (id, path or title). Lists leave the ${BODY} out unless \`include_${BODY}: true\`.
- Filters combine (AND). \`type\` matches a type and its subtypes (\`event\` finds \`event/meeting\`); \`tag\` matches a label. \`${FIELDS}\` operators work on any field: an indexed one (vault-info lists them) is fastest, any other is read in full and the reply warns \`scan\`.
- Each record has \`types\` (what it is), \`tags\` (labels), \`${FIELDS}\` and a \`${BODY}\`.
- Returns an array of records, or \`{records, next_cursor?, warnings?}\` with \`cursor\` or warnings, or \`[{group, value}]\` with \`aggregate\`. An empty page means done.
- ${HYBRID_TEXT.line}
Rarer filters (has_links, order_by, expand_links, created_by, …) are accepted too. ${HELP("query-records")}`,
  "create-record": `Create a record, or several with \`records: [...]\`. \`types\` names its types (existing types or new names); \`tags\` adds labels. If \`path\` is taken, \`if_exists\` decides: error (default), ignore, update (merge into it) or replace. ${HELP("create-record")} If no existing type fits what the record is, name a new type for it rather than using the nearest one.`,
  "update-record": `Change a record (id, path or title), or several with \`records: [{id, …}]\`.
- ${BODY[0]!.toUpperCase() + BODY.slice(1)}: \`${BODY}\` (replace all), \`append\`/\`prepend\`, or \`${BODY}_edit\` (old_text must occur once).
- \`${FIELDS}\` merges (null deletes a key); \`types\`/\`tags\`/\`links\` take {add, remove}.
- Except append/prepend, pass \`if_updated_at\` (the updated_at you read) or \`force: true\`.
- \`if_missing: "create"\` makes the record if missing. ${HELP("update-record")}`,
  "delete-record": "Delete a record (by id, path or title), with its tags and links.",
  "list-types": "Every type and tag with its `kind` and counts (`count` exact, `expanded_count` with subtypes). `name` gives one in full (fields, parents); `include_schema: true` gives all of them.",
};

/** A deprecated note-named tool's description: one line, as #21's other aliases have. */
export function noteAliasDescription(noteTool: string): string {
  return `Deprecated (gone in 1.0): use ${RECORD_TOOL_NAMES[noteTool]}. Same parameters as before.`;
}

/**
 * The refresh nudge (0.9.1): the second content block on a successful call to a note-named tool. A client that
 * cached 0.8's tool list (ChatGPT keeps one per connector) never sees the record tools, so it is told what to do
 * either way. The first block, the JSON, stays exactly what it was. A reply that also goes out as
 * `structuredContent` (a note read by id, mcp-result.ts) carries it there as `deprecation.notice`.
 */
export function refreshNudge(noteTool: string): string {
  return `\`${noteTool}\` is deprecated and goes away in 1.0. If \`create-record\` isn't among your tools, ask your user to refresh this connector so you get the new tools. Otherwise use \`${RECORD_TOOL_NAMES[noteTool]}\` from now on.`;
}

/**
 * A deprecated note tool's schema: its old top-level parameter names and their types, without descriptions or
 * nested shapes, so a 0.8 client still sees what it can pass while each alias stays inside the 400-token budget
 * (contracts/suites/mcp/budget.test.ts). The full shapes are in the record tool and in vault-info {help}.
 */
export function noteAliasSchema(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as { properties?: Record<string, any>; required?: string[] };
  // An array keeps `items` (its item type): function-calling APIs refuse an array schema without one.
  const bare = (d: any): Record<string, unknown> =>
    d?.type === "array" ? { type: "array", items: d.items?.type ? { type: d.items.type } : {} } : d?.type ? { type: d.type } : {};
  const props = Object.fromEntries(
    Object.entries(s.properties ?? {}).map(([k, d]) => [k, d?.oneOf ? { oneOf: d.oneOf.map(bare) } : bare(d)]),
  );
  return { type: "object", properties: props, ...(s.required ? { required: s.required } : {}) };
}

/**
 * A check a record tool runs on its translated call before the note tool does (the runtime's: the record door's
 * `tags` refusing a type's name needs the vault and the caller's scope, tag-kind.ts refuseTypesInTags).
 */
export type RecordCheck = (tool: string, translated: Record<string, unknown>) => void | Promise<void>;

/**
 * The five record tools, built over the note tools in `tools` (each a wrapper:
 * a record tool can never do more than its note tool), and the note tools
 * relisted as aliases. `shortSchema` gives a note tool's advertised schema.
 * Returns the new list: record tools where the note tools were, aliases at the end.
 */
export function addRecordTools<T extends RecordToolDef>(tools: T[], onUse?: OnUse, check?: RecordCheck): T[] {
  const out: T[] = [];
  const aliases: T[] = [];
  for (const t of tools) {
    const name = RECORD_TOOL_NAMES[t.name];
    if (!name) {
      out.push(t);
      continue;
    }
    const execute = t.execute;
    out.push({
      ...t,
      name,
      description: RECORD_DESCRIPTIONS[name]!,
      inputSchema: recordSchema(t.name, t.inputSchema),
      execute: async (params: Record<string, unknown>) => {
        onUse?.(name, "new");
        const translated = paramsIn(name, params ?? {}, onUse); // its own refusals are already in record words
        let result: unknown;
        try {
          await check?.(name, translated);
          result = await execute(translated);
        } catch (err) {
          throw errorOut(err, name);
        }
        return resultOut(name, result);
      },
    });
    aliases.push({
      ...t,
      description: noteAliasDescription(t.name),
      inputSchema: noteAliasSchema(t.inputSchema),
      execute: async (params: Record<string, unknown>) => {
        onUse?.(t.name, "old");
        return execute(params);
      },
      resultContent: (result: unknown) => [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
        { type: "text" as const, text: refreshNudge(t.name) },
      ],
      // ChatGPT reads only structuredContent when there is one (a note read by id: mcp-result.ts), so the nudge rides there too.
      deprecation: { tool: t.name, use: name, removed_in: "1.0", notice: refreshNudge(t.name) },
    });
  }
  return [...out, ...aliases];
}

/**
 * The parameter names a record tool accepts, from its note tool's: each in
 * record words, and each old name that has a record word too (an alias).
 */
export function recordParamNames(recordTool: string, noteParams: readonly string[]): string[] {
  const map = PARAMS[recordTool] ?? {};
  const back = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  return [...new Set([...noteParams.map((p) => back[p] ?? p), ...noteParams])];
}
