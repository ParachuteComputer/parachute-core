/**
 * What an agent reads before its first call: one short description and a
 * short input schema per core MCP tool (T-318 design §4, "a description
 * budget"). A writer session's whole tool list stays under 4,000 tokens,
 * `query-notes` under 1,500 and every other tool under 400; the contract
 * `contracts/suites/mcp/budget.test.ts` measures `tools/list` and fails over
 * budget.
 *
 * Nothing is lost: the full text and every parameter stay in
 * `MCP_TOOL_REFERENCE` (mcp-manifest.ts), which `vault-info { help: "<tool>" }`
 * returns, and every parameter the reference names is still accepted. A
 * parameter a tool doesn't know is named with its one-line fix (`unknownParams`):
 * refused by the tools 0.9 adds (REFUSES_UNKNOWN_PARAMS), ignored by the 0.8
 * names, as 0.8 ignored it. A misused nested key is refused (`nestedParamProblem`).
 *
 * These texts shipped only after `contracts/evals/mcp-tasks` showed agents do
 * as well with them as with the long ones, model by model. Change them the
 * same way: run the eval.
 *
 * Pure data (see mcp-manifest.ts's import-graph invariant): its one import,
 * mcp-records.ts, is pure too.
 */

import { BODY, FIELDS } from "./mcp-records.js";
import { HYBRID_TEXT } from "./hybrid.js";

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => (description ? { type: "string", description } : { type: "string" });
const bool = (description?: string): Schema => (description ? { type: "boolean", description } : { type: "boolean" });
const num = (description?: string): Schema => (description ? { type: "number", description } : { type: "number" });
const strs = (description?: string): Schema => ({ oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema>, required?: string[]): Schema => ({ type: "object", properties, ...(required ? { required } : {}) });

const HELP = (tool: string) => `Every parameter: vault-info {help: "${tool}"}.`;

export interface ShortTool {
  description: string;
  inputSchema: Schema;
}

const PATH_BETWEEN_REF: Schema = {
  ...obj({ source: str(), target: str(), max_depth: num() }, ["source", "target"]),
  description: "The shortest link path between two notes, instead of notes",
};

const LINKS = {
  type: "array",
  items: obj({ target: str("Note path or id"), relationship: str() }, ["target"]),
};

/** A type's field options, in its own schema (0.9.2: an AI that doesn't ask for help still sees all of them). */
const FIELD_SPEC =
  '{name: {type: "string"|"integer"|"number"|"boolean"|"date"|"reference", enum?, indexed?, default?, required?, strict?, cardinality?, target_tags?}}. reference: points at a record (target_tags: its types). required: should be set (refused only if strict). strict: refuse a wrong value. cardinality "many": a list.';

export const SHORT_TOOLS: Record<string, ShortTool> = {
  "query-notes": {
    description: `Read notes: one note, a filtered list, a search, a link neighbourhood or path, counts, or a note's history.
- One note: \`id\` (id, path or title). Lists leave content out unless \`include_content: true\`.
- Filters combine (AND). \`tag\` also matches subtypes (\`event\` finds \`event/meeting\`). \`metadata\` operators work on any field: an indexed one (vault-info lists them) is fastest, any other is read in full and the reply warns \`scan\`.
- Returns an array of notes, or \`{notes, next_cursor?, warnings?}\` with \`cursor\` or warnings, or \`[{group, value}]\` with \`aggregate\`.
- ${HYBRID_TEXT.line}
Rarer filters (has_links, order_by, expand_links, created_by, …) are accepted too. ${HELP("query-notes")}`,
    inputSchema: obj({
      id: str("One note by id, path or title"),
      tag: strs("Tag(s), subtypes included"),
      type: strs("Type(s), subtypes included"),
      tag_match: { type: "string", enum: ["any", "all"], description: "With several tags: any (default) or all" },
      exclude_tags: strs("Leave out notes with these tags"),
      path: str("Exact path"),
      path_prefix: str('e.g. "Projects/"'),
      search: str(HYBRID_TEXT.param),
      search_mode: { type: "string", enum: ["literal", "advanced", "hybrid"], description: HYBRID_TEXT.mode },
      metadata: { type: "object", description: "{field: value} or {field: {eq|ne|gt|gte|lt|lte|in|not_in|exists: v}}" },
      since: str("What changed: updated_at on or after (ISO date)"),
      date_from: str("created_at on or after (ISO date)"),
      date_to: str("created_at before (ISO date, exclusive)"),
      date_filter: { ...obj({ field: str("created_at (default), updated_at, or an indexed date field"), from: str(), to: str("exclusive") }), description: "Date range on another field" },
      near: {
        ...obj(
          {
            note_id: str("Anchor note id, path or title"),
            depth: num("Hops, default 2, max 5"),
            direction: { type: "string", enum: ["both", "inbound", "outbound"], description: "inbound = notes linking to it; outbound = notes it links to" },
            relationship: str("Only links of this relationship"),
          },
          ["note_id"],
        ),
        description: "Notes within N link hops of a note",
      },
      aggregate: {
        ...obj(
          {
            op: { type: "string", enum: ["count", "sum"] },
            group_by: str('"tag" or an indexed metadata field; omit for one total'),
            field: str("Indexed numeric field, for sum"),
          },
          ["op"],
        ),
        description: "Counts or sums per group instead of notes; other filters apply first",
      },
      versions: { ...obj({ note_id: str(), version_ix: { type: "integer", description: "Read this version (0 = oldest)" } }, ["note_id"]), description: "A note's earlier versions" },
      cursor: str('Changes since last call: "" first, then the returned next_cursor; an empty page means caught up, so stop'),
      sort: { type: "string", enum: ["asc", "desc"], description: "By created_at; search sorts by relevance unless set" },
      limit: num("Default 50"),
      offset: num(),
      include_content: bool(),
      include_metadata: bool(),
      include_links: bool(),
      include_attachments: bool(),
      content_offset: num("Byte offset, for long notes"),
      content_length: num("Bytes to return"),
      path_between: PATH_BETWEEN_REF,
    }),
  },

  "create-note": {
    description: `Create a note, or several with \`notes: [...]\`. If \`path\` is taken, \`if_exists\` decides: error (default), ignore, update (merge into it) or replace. ${HELP("create-note")}`,
    inputSchema: obj({
      content: str(),
      path: str('e.g. "Projects/Alder"'),
      tags: { type: "array", items: { type: "string" } },
      types: { type: "array", items: { type: "string" }, description: "Types; land with the tags" },
      metadata: { type: "object" },
      links: LINKS,
      created_at: str("ISO timestamp, default now"),
      if_exists: { type: "string", enum: ["error", "ignore", "update", "replace"] },
      notes: { type: "array", items: { type: "object" }, description: "Batch: each item takes the fields above" },
      why: str("Why, in a few words: kept with the change in history"),
    }),
  },

  "update-note": {
    description: `Change a note (id, path or title), or several with \`notes: [{id, …}]\`.
- Content: \`content\` (replace all), \`append\`/\`prepend\`, or \`content_edit\` (old_text must occur once).
- \`metadata\` merges (null deletes a key); \`tags\`/\`links\` take {add, remove}.
- Except append/prepend, pass \`if_updated_at\` (the updated_at you read) or \`force: true\`.
- \`if_missing: "create"\` makes the note if missing. ${HELP("update-note")}`,
    inputSchema: obj(
      {
        id: str("Note id, path or title"),
        content: str(),
        append: str(),
        prepend: str(),
        content_edit: obj({ old_text: str(), new_text: str() }, ["old_text", "new_text"]),
        metadata: { type: "object" },
        tags: obj({ add: { type: "array", items: { type: "string" } }, remove: { type: "array", items: { type: "string" } } }),
        types: { type: "object", description: "{add, remove}, as tags" },
        links: { type: "object", description: "{add: [{target, relationship?}], remove: [...]}" },
        path: str("Rename to"),
        if_updated_at: str(),
        force: bool(),
        if_missing: { type: "string", enum: ["fail", "create"] },
        notes: { type: "array", items: { type: "object" } },
        why: str("Why, in a few words: kept with the change in history"),
      },
    ),
  },

  "delete-note": {
    description: "Delete a note (by id, path or title), with its tags and links.",
    // T-412 (next): `ids` deletes several, `erase_history` (admin) forgets every version too. The merge with next
    // kept them in the reference schema but not here, so a client reading tools/list couldn't find them.
    inputSchema: obj({ id: str(), ids: { type: "array", items: { type: "string" } }, erase_history: bool(), why: str("Why, in a few words: kept with the change in history") }),
  },

  "list-tags": {
    description: "Tags with counts (`count` exact, `expanded_count` with subtypes). `tag` gives one tag's record (fields, parents); `include_schema: true` gives every record.",
    inputSchema: obj({ tag: str(), include_schema: bool() }),
  },

  "update-tag": {
    description: `Create or update a tag: description, \`fields\` (metadata schema, merged) and \`parent_names\` (makes it a subtype, replaced). ${HELP("update-tag")}`,
    inputSchema: obj(
      {
        tag: str(),
        description: str(),
        fields: { type: "object", description: FIELD_SPEC },
        parent_names: { type: "array", items: { type: "string" } },
        relationships: { type: "object" },
        kind: { type: "string", enum: ["type", "tag"] },
        force: bool("Go ahead although a key's tag limit, private_tags or the published tag reaches this name (the refusal names them, except to a tag-scoped pass)"),
      },
      ["tag"],
    ),
  },

  "delete-tag": {
    description: "Delete a tag and untag its notes (the notes stay). If another tag names it as a parent, pass `detach: true`.",
    inputSchema: obj({ tag: str(), detach: bool(), force: bool("Go ahead although a key's tag limit, private_tags or the published tag reaches this name (the refusal names them, except to a tag-scoped pass)"), }, ["tag"]),
  },

  "rename-tag": {
    description: "Rename a tag everywhere (notes, parents, #mentions); its sub-tags follow. If a key's tag limit, private_tags or the published tag reaches it (or the caller is tag-scoped), refused until you pass `force: true` (the refusal names them).",
    inputSchema: obj({ old_name: str(), new_name: str(), force: bool("Go ahead although a key's tag limit, private_tags or the published tag reaches this name (the refusal names them, except to a tag-scoped pass)"), }, ["old_name", "new_name"]),
  },

  "merge-tags": {
    description: "Retag every note of the `sources` with `target`, then drop the sources.",
    inputSchema: obj({ sources: { type: "array", items: { type: "string" } }, target: str(), force: bool("Go ahead although a key's tag limit, private_tags or the published tag reaches this name (the refusal names them, except to a tag-scoped pass)"), }, ["sources", "target"]),
  },

  "find-path": {
    description: "The shortest link path between two notes, or null.",
    inputSchema: obj({ source: str("Note id, path or title"), target: str(), max_depth: num() }, ["source", "target"]),
  },

  "vault-info": {
    description: "The vault's description, types and their fields, indexed fields, and counts (`include_stats`). `help: \"<tool>\"` returns a tool's full reference. Admins may set `description`.",
    inputSchema: obj({ include_stats: bool(), help: str("A tool name"), description: str() }),
  },

  "prune-schema": {
    description: "Drop indexed-field columns that no live tag declares. A dry run unless `apply: true`.",
    inputSchema: obj({ apply: bool() }),
  },

  // Reached only as manage-types {action: "migrate"} (FOLD_ONLY below); never listed.
  "migrate-field": {
    description: "Change a field's values on every record of a type. A dry run unless `apply: true`.",
    inputSchema: obj(
      {
        tag: str(),
        field: str(),
        transform: { type: "object", description: '{kind: "to_string"|"to_int"|"to_number"|"to_boolean"|"rename"|"remap"|"set_default", ...}' },
        apply: bool(),
        continue_on_error: bool(),
      },
      ["tag", "field", "transform"],
    ),
  },

  doctor: {
    description: `Read-only check of types, tags and fields (dangling parents, cycles, a field holding two data types, a field that names records but isn't a reference, names one letter apart). Returns findings, each with a remedy; fixes nothing. ${HELP("doctor")}`,
    inputSchema: obj({ deep: bool("Also check history") }),
  },

  "request-attachment-upload": {
    description: "A one-use URL to upload a file to a note. PUT the file's bytes to `url` (the reply has a curl_example). The size must be exact.",
    inputSchema: obj(
      { note: str("Note id or path"), filename: str(), size_bytes: num(), mime_type: str("Default: from the filename"), transcribe: bool("Audio: transcribe it") },
      ["note", "filename", "size_bytes"],
    ),
  },

  "request-attachment-download": {
    description: "A one-use download URL for an attachment. Ids come from query-notes with `include_attachments: true`.",
    inputSchema: obj({ attachment_id: str() }, ["attachment_id"]),
  },

  "read-attachment": {
    description: "Read an attachment into the conversation: text in byte slices, images as images.",
    inputSchema: obj({ attachment_id: str(), content_offset: num(), content_length: num() }, ["attachment_id"]),
  },
};

// ---------------------------------------------------------------------------
// Errors that teach
// ---------------------------------------------------------------------------

/** Names agents reach for that a tool calls something else. Checked before edit distance. */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  "query-notes": { query: "search", q: "search", text: "search", tags: "tag", note_id: "id", note: "id", ids: "id", filter: "metadata", where: "metadata", page_size: "limit", until: "date_filter", order: "sort" },
  // The record tools (mcp-records.ts). Their old names (content, metadata, notes, note_id) are accepted, not unknown.
  "query-records": { query: "search", q: "search", text: "search", tags: "tag", types: "type", record_id: "id", note_id: "id", record: "id", note: "id", ids: "id", filter: FIELDS, where: FIELDS, page_size: "limit", until: "date_filter", order: "sort" },
  "update-record": { record_id: "id", note_id: "id", record: "id", note: "id", path_or_id: "id", text: BODY, add_tags: "tags", edit: `${BODY}_edit` },
  "create-record": { text: BODY, tag: "tags", type: "types", title: "path" },
  "delete-record": { record_id: "id", note_id: "id", record: "id", note: "id", path: "id" },
  "list-types": { type: "name" },
  "update-note": { note_id: "id", note: "id", path_or_id: "id", text: "content", body: "content", add_tags: "tags", edit: "content_edit" },
  "create-note": { body: "content", text: "content", tag: "tags", title: "path" },
  "delete-note": { note_id: "id", note: "id", path: "id" },
  "request-attachment-upload": { note_id: "note", id: "note", size: "size_bytes", name: "filename" },
  "request-attachment-download": { id: "attachment_id" },
  "read-attachment": { id: "attachment_id" },
};

/** Nested misuses worth one line each: `[tool, param, wrong key, right key]`. */
const NESTED: [string, string, string, string][] = [
  ["query-notes", "near", "id", "note_id"],
  ["query-notes", "near", "note", "note_id"],
  ["query-notes", "versions", "id", "note_id"],
  ["query-notes", "versions", "note", "note_id"],
  ["update-note", "content_edit", "old", "old_text"],
  ["update-note", "content_edit", "new", "new_text"],
  ["update-note", "content_edit", "find", "old_text"],
  ["update-note", "content_edit", "replace", "new_text"],
  ["query-records", "near", "note", "id"],
  ["query-records", "near", "record_id", "id"],
  ["query-records", "versions", "note", "id"],
  ["query-records", "versions", "record_id", "id"],
  ["update-record", `${BODY}_edit`, "old", "old_text"],
  ["update-record", `${BODY}_edit`, "new", "new_text"],
  ["update-record", `${BODY}_edit`, "find", "old_text"],
  ["update-record", `${BODY}_edit`, "replace", "new_text"],
  ["update-record", "content_edit", "old", "old_text"],
  ["update-record", "content_edit", "new", "new_text"],
  ["update-record", "content_edit", "find", "old_text"],
  ["update-record", "content_edit", "replace", "new_text"],
];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

export interface ParamProblem {
  message: string;
  error_type: "unknown_parameter";
  field: string;
  hint: string;
}

/**
 * The tools 0.9 adds. Nobody called them before 0.9, so they refuse a parameter they don't take (audit L7-12: a
 * misspelt filter on query-records returned the whole vault). Every name a 0.8 client can call keeps 0.8's rule:
 * the call runs with the name ignored, and the answer says so (SPEC v2 §4.3, the same split as `tag` naming a type:
 * refused on the record door, warned and counted on the note door).
 */
export const REFUSES_UNKNOWN_PARAMS: ReadonlySet<string> = new Set([
  "query-records",
  "create-record",
  "update-record",
  "delete-record",
  "list-types",
  "manage-types",
  "attachment-url",
  "manage-keys",
]);

/**
 * The call's top-level names the tool doesn't accept (`accepted`: the names in
 * its full reference schema), each with its one-line fix. 0.8 ignored such a
 * name and ran the call; on a 0.8 name 0.9 still does (nothing a 0.8 client
 * sends is refused before 1.0), and reports each one (src/mcp-tools.ts: a
 * warning on the answer and a counted log line), so 1.0 can decide from real use
 * whether to refuse them. A tool in REFUSES_UNKNOWN_PARAMS refuses the call
 * instead (`refused` words the message so). Names starting with `_` and the
 * account door's `vault` are always allowed.
 */
export function unknownParams(tool: string, params: Record<string, unknown>, accepted: readonly string[], refused = false): ParamProblem[] {
  const known = new Set(accepted);
  const out: ParamProblem[] = [];
  for (const key of Object.keys(params ?? {})) {
    if (known.has(key) || key === "vault" || key.startsWith("_")) continue;
    const alias = PARAM_ALIASES[tool]?.[key];
    const near = alias && known.has(alias) ? alias : [...known].map((k) => [k, distance(key, k)] as const).sort((a, b) => a[1] - b[1]).find(([, d]) => d <= 2)?.[0];
    const fix = near ? ` Did you mean \`${near}\`?` : "";
    out.push({
      message: `${tool} has no parameter \`${key}\`${refused ? "." : ", so it was ignored."}${fix} ${HELP(tool)}`,
      error_type: "unknown_parameter",
      field: key,
      hint: near ? `use ${near}` : `see vault-info {help: "${tool}"}`,
    });
  }
  return out;
}

/**
 * A misused nested key (`near: {id}` for `{note_id}`), refused with its fix.
 * 0.8 refused every one of these too, with a less helpful error.
 */
export function nestedParamProblem(tool: string, params: Record<string, unknown>): ParamProblem | null {
  for (const [t, param, wrong, right] of NESTED) {
    const v = params?.[param];
    if (t === tool && v && typeof v === "object" && !Array.isArray(v) && wrong in v && !(right in v)) {
      return {
        message: `${param} takes {${right}}, not {${wrong}}. ${HELP(tool)}`,
        error_type: "unknown_parameter",
        field: `${param}.${wrong}`,
        hint: `use ${param}.${right}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 0.9's eleven tools (T-318 §4): three new names fold nine old ones
// ---------------------------------------------------------------------------

/** The tools 0.9 adds; each runs the old tools underneath (src/mcp-tools.ts). */
export const NEW_TOOLS: Record<string, ShortTool & { folds: Record<string, string> }> = {
  "manage-types": {
    description: `Change the vault's types and tags. \`action\`: update (default: create or change one; \`fields\` and \`parent_names\` make it a type), rename {old_name, new_name}, merge {sources, target}, delete {tag, detach?}, prune (drop unused indexed columns), migrate {tag, field, transform} (change a field's values, e.g. before a retype); both a dry run unless \`apply: true\`. ${HELP("manage-types")}`,
    inputSchema: obj(
      {
        action: { type: "string", enum: ["update", "rename", "merge", "delete", "prune", "migrate"] },
        tag: str(),
        kind: { type: "string", enum: ["type", "tag"], description: "type: has fields/parents; tag: a flat label" },
        description: str(),
        fields: { type: "object", description: FIELD_SPEC },
        parent_names: { type: "array", items: { type: "string" } },
        old_name: str(),
        new_name: str(),
        sources: { type: "array", items: { type: "string" } },
        target: str(),
        detach: bool(),
        field: str(),
        transform: { type: "object", description: '{kind: "to_string"|"to_int"|"remap"|…}' },
        continue_on_error: bool(),
        apply: bool(),
        force: bool(),
      },
    ),
    folds: { update: "update-tag", rename: "rename-tag", merge: "merge-tags", delete: "delete-tag", prune: "prune-schema", migrate: "migrate-field" },
  },
  "attachment-url": {
    description: `A one-use URL for an attachment's bytes. upload: \`record\`, \`filename\` and exact \`size_bytes\`, then PUT the bytes to \`url\`. download: \`attachment_id\` (from query-records \`include_attachments: true\`). ${HELP("attachment-url")}`,
    inputSchema: obj(
      {
        action: { type: "string", enum: ["upload", "download"] },
        record: str("upload: record id or path"),
        filename: str(),
        size_bytes: num(),
        mime_type: str(),
        transcribe: bool("Audio: transcribe it"),
        attachment_id: str("download"),
      },
      ["action"],
    ),
    folds: { upload: "request-attachment-upload", download: "request-attachment-download" },
  },
};

/** `query-notes {path_between}` replaces find-path. */
export const PATH_BETWEEN: Schema = PATH_BETWEEN_REF;

/** Tools reached only through a 0.9 tool's `action`, never listed on their own. */
export const FOLD_ONLY: ReadonlySet<string> = new Set(["migrate-field"]);

/** The nine old names 0.9 keeps as listed, working aliases until 1.0 (Prism allow-lists some by name). */
export const TOOL_ALIASES: Record<string, string> = {
  "find-path": "query-records {path_between: {source, target}}",
  "update-tag": 'manage-types {action: "update"}',
  "rename-tag": 'manage-types {action: "rename"}',
  "merge-tags": 'manage-types {action: "merge"}',
  "delete-tag": 'manage-types {action: "delete"}',
  "prune-schema": 'manage-types {action: "prune"}',
  "request-attachment-upload": 'attachment-url {action: "upload"}',
  "request-attachment-download": 'attachment-url {action: "download"}',
  "manage-token": "manage-keys",
};

/** An alias's description: the one deprecation line, then nothing else (the schema stays as it was). */
export function aliasDescription(tool: string): string {
  return `Deprecated (gone in 1.0): use ${TOOL_ALIASES[tool]}. Same parameters as before.`;
}

/** The order tools/list sends: the eleven (record tools first, T-407), then the aliases, note-named ones first. */
export const TOOL_ORDER = [
  "query-records", "create-record", "update-record", "delete-record", "list-types", "vault-info", "doctor",
  "read-attachment", "attachment-url", "manage-types", "manage-keys",
  "query-notes", "create-note", "update-note", "delete-note", "list-tags",
  ...Object.keys(TOOL_ALIASES),
];
