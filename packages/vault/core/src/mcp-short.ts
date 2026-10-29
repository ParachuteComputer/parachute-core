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
 * parameter a tool doesn't know is refused with the one-line fix
 * (`checkToolParams`) instead of being silently ignored.
 *
 * These texts shipped only after `contracts/evals/mcp-tasks` showed agents do
 * as well with them as with the long ones, model by model. Change them the
 * same way: run the eval.
 *
 * Pure data (see mcp-manifest.ts's import-graph invariant): no imports.
 */

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

export const SHORT_TOOLS: Record<string, ShortTool> = {
  "query-notes": {
    description: `Read notes: one note, a filtered list, a search, a link neighbourhood or path, counts, or a note's history.
- One note: \`id\` (id, path or title). Lists leave content out unless \`include_content: true\`.
- Filters combine (AND). \`tag\` also matches subtypes (\`event\` finds \`event/meeting\`). \`metadata\` operators need an indexed field (vault-info lists them).
- Returns an array of notes, or \`{notes, next_cursor?, warnings?}\` with \`cursor\` or warnings, or \`[{group, value}]\` with \`aggregate\`.
Rarer filters (has_links, order_by, expand_links, created_by, search_mode, …) are accepted too. ${HELP("query-notes")}`,
    inputSchema: obj({
      id: str("One note by id, path or title"),
      tag: strs("Tag(s), subtypes included"),
      tag_match: { type: "string", enum: ["any", "all"], description: "With several tags: any (default) or all" },
      exclude_tags: strs("Leave out notes with these tags"),
      path: str("Exact path"),
      path_prefix: str('e.g. "Projects/"'),
      search: str("Full-text search over title and content"),
      metadata: { type: "object", description: "{field: value} or {field: {eq|ne|gt|gte|lt|lte|in|not_in|exists: v}}" },
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
      cursor: str('Paging: "" for the first page, then the returned next_cursor'),
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
      metadata: { type: "object" },
      links: LINKS,
      created_at: str("ISO timestamp, default now"),
      if_exists: { type: "string", enum: ["error", "ignore", "update", "replace"] },
      notes: { type: "array", items: { type: "object" }, description: "Batch: each item takes the fields above" },
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
        links: { type: "object", description: "{add: [{target, relationship?}], remove: [...]}" },
        path: str("Rename to"),
        if_updated_at: str(),
        force: bool(),
        if_missing: { type: "string", enum: ["fail", "create"] },
        notes: { type: "array", items: { type: "object" } },
      },
    ),
  },

  "delete-note": {
    description: "Delete a note (by id, path or title), with its tags and links.",
    inputSchema: obj({ id: str() }, ["id"]),
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
        fields: { type: "object", description: '{name: {type: "string"|"integer"|"boolean"|"date"|…, enum?, indexed?, default?, strict?}}' },
        parent_names: { type: "array", items: { type: "string" } },
        relationships: { type: "object" },
      },
      ["tag"],
    ),
  },

  "delete-tag": {
    description: "Delete a tag and untag its notes (the notes stay). If another tag names it as a parent, pass `detach: true`.",
    inputSchema: obj({ tag: str(), detach: bool() }, ["tag"]),
  },

  "rename-tag": {
    description: "Rename a tag everywhere (notes, parents, keys, #mentions); its sub-tags follow.",
    inputSchema: obj({ old_name: str(), new_name: str() }, ["old_name", "new_name"]),
  },

  "merge-tags": {
    description: "Retag every note of the `sources` with `target`, then drop the sources.",
    inputSchema: obj({ sources: { type: "array", items: { type: "string" } }, target: str() }, ["sources", "target"]),
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

  doctor: {
    description: `Read-only check of tags and metadata (dangling parents, cycles, mixed field types). Returns findings, each with a remedy; fixes nothing. ${HELP("doctor")}`,
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
  "query-notes": { query: "search", q: "search", text: "search", tags: "tag", note_id: "id", note: "id", ids: "id", filter: "metadata", where: "metadata", page_size: "limit", since: "date_from", until: "date_to", order: "sort" },
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
 * Check a call's arguments against every parameter the tool accepts
 * (`accepted`: the names in its full reference schema). Returns the one-line
 * fix for the first problem, or null. Names starting with `_` and the account
 * door's `vault` are always allowed.
 */
export function checkToolParams(tool: string, params: Record<string, unknown>, accepted: readonly string[]): ParamProblem | null {
  const known = new Set(accepted);
  for (const key of Object.keys(params ?? {})) {
    if (known.has(key) || key === "vault" || key.startsWith("_")) continue;
    const alias = PARAM_ALIASES[tool]?.[key];
    const near = alias && known.has(alias) ? alias : [...known].map((k) => [k, distance(key, k)] as const).sort((a, b) => a[1] - b[1]).find(([, d]) => d <= 2)?.[0];
    const fix = near ? ` Did you mean \`${near}\`?` : "";
    return {
      message: `${tool} has no parameter \`${key}\`.${fix} ${HELP(tool)}`,
      error_type: "unknown_parameter",
      field: key,
      hint: near ? `use ${near}` : `see vault-info {help: "${tool}"}`,
    };
  }
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
    description: `Change the vault's types and tags. \`action\`: update (default: create or change a tag, its \`fields\` and \`parent_names\`), rename {old_name, new_name}, merge {sources, target}, delete {tag, detach?}, prune (drop unused indexed columns; a dry run unless \`apply: true\`). ${HELP("manage-types")}`,
    inputSchema: obj(
      {
        action: { type: "string", enum: ["update", "rename", "merge", "delete", "prune"] },
        tag: str(),
        description: str(),
        fields: { type: "object", description: '{name: {type: "string"|"integer"|"boolean"|"date"|…, enum?, indexed?, default?}}' },
        parent_names: { type: "array", items: { type: "string" } },
        old_name: str(),
        new_name: str(),
        sources: { type: "array", items: { type: "string" } },
        target: str(),
        detach: bool(),
        apply: bool(),
      },
    ),
    folds: { update: "update-tag", rename: "rename-tag", merge: "merge-tags", delete: "delete-tag", prune: "prune-schema" },
  },
  "attachment-url": {
    description: `A one-use URL for an attachment's bytes. upload: \`note\`, \`filename\` and exact \`size_bytes\`, then PUT the bytes to \`url\`. download: \`attachment_id\` (from query-notes \`include_attachments: true\`). ${HELP("attachment-url")}`,
    inputSchema: obj(
      {
        action: { type: "string", enum: ["upload", "download"] },
        note: str("upload: note id or path"),
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

/** The nine old names 0.9 keeps as listed, working aliases until 1.0 (Prism allow-lists some by name). */
export const TOOL_ALIASES: Record<string, string> = {
  "find-path": "query-notes {path_between: {source, target}}",
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

/** The order tools/list sends: the eleven, then the aliases. */
export const TOOL_ORDER = [
  "query-notes", "create-note", "update-note", "delete-note", "list-tags", "vault-info", "doctor",
  "read-attachment", "attachment-url", "manage-types", "manage-keys",
  ...Object.keys(TOOL_ALIASES),
];
