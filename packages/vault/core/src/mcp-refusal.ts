/**
 * One way to refuse (T-476, approved by Aaron 11-24): every refusal of a `tools/call`, at every door, is a normal
 * result with `isError: true` and `structuredContent: {error_type, message, ...fields}`, its one text block that
 * object as JSON. Before, a refusal came three ways: a JSON-RPC error carrying `data.error_type` (a conflict, a bad
 * query), a normal reply `{error, error_type}` (a missing record), or an `isError` result of bare text (an unknown
 * tool). A client had to read all three, and a host that turns a JSON-RPC error into its own generic one (Claude's
 * artifact runtime calls it `upstream_error`) lost the vault's words; a reply that looked like data could be taken for
 * a record. MCP says a tool's own errors belong in the result, with `isError`, so the model and an app see them.
 *
 * What stays a JSON-RPC error: the protocol's own (bad JSON, an unknown method, a missing session), never a tool's.
 *
 * - `error_type`: the stable word to branch on (the same vocabulary as before: `conflict`, `not_found`, …; a tool the
 *   caller can't see or that doesn't exist is `unknown_tool`; a crash nobody tagged is `internal_error`).
 * - `message`: the words for a person, without the `[error_type]` prefix the JSON-RPC message carried.
 * - every other field the refusal had before (`current_updated_at`, `violations`, `hint`, `how_to`, …), unchanged.
 *
 * Pure: no imports, so the cloud runtime answers the same (`mcp-result.ts`).
 */

export interface McpRefusal {
  [k: string]: unknown;
  error_type: string;
  message: string;
}

export interface McpRefusalResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: McpRefusal;
  isError: true;
}

/** The result a door answers for a refusal. */
export function refusalResult(r: McpRefusal): McpRefusalResult {
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], structuredContent: r, isError: true };
}

/** A refusal from its type, its words and its fields; fields left undefined are dropped. */
export function refusal(error_type: string, message: string, fields: Record<string, unknown> = {}): McpRefusal {
  const out: McpRefusal = { error_type, message };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && k !== "error_type" && k !== "message") out[k] = v;
  return out;
}

/** The JSON-RPC prefix the MCP SDK bakes into an `McpError`'s message, and the `[error_type]` one the box added. */
const PREFIXES = /^(?:MCP error -?\d+:\s*)?(?:\[[a-z0-9_]+\]\s*)?/;
export const plainMessage = (m: string): string => m.replace(PREFIXES, "");

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CODE_WORD = /^[a-z][a-z0-9_]*$/;
/** `"Forbidden"` → `forbidden`, `"TagInUseByTokens"` → `tag_in_use_by_tokens`: an in-band reply's `error` as a type. */
const typeWord = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "refused";

/**
 * A tool's reply that is a refusal said as data (`{error: "Record not found", error_type: "not_found", id}`,
 * manage-keys' `{action, ok: false, error: "invalid_request", message}`), as a refusal; null for any other reply. A
 * reply is one when it is a plain object whose `error` is a string: no success reply carries a top-level `error`
 * (records keep a person's own keys under `fields`).
 */
export function refusalOfReply(result: unknown): McpRefusal | null {
  if (!isPlainObject(result) || typeof result.error !== "string") return null;
  const { error, error_type, message, ...rest } = result;
  const words = typeof message === "string" && message ? message : (error as string);
  const type = typeof error_type === "string" && error_type ? error_type : CODE_WORD.test(error as string) ? (error as string) : typeWord(error as string);
  return refusal(type, words, rest);
}

/** The fields an error object may carry, by name (the domain error classes and `structuredError` leaves). */
type Tagged = {
  name?: string; code?: unknown; error_type?: unknown; note_id?: string; origin?: unknown; import_ix?: unknown;
  note_path?: string | null; current_updated_at?: string | null; expected_updated_at?: string; field?: string;
  expected_from?: unknown; to?: unknown; current?: unknown; violations?: unknown; got?: unknown; unused?: unknown;
  fields?: unknown; hint?: string; path?: string; candidates?: unknown; extension?: string; reason?: string;
  limit?: number; tag?: string; cycle?: unknown; how_to?: string; size?: number; max_bytes?: number; mime_type?: string;
  done?: unknown; failed?: unknown; missing?: unknown; index?: number;
  /** An `McpError` already formed (a door's own, or one passed through): its `data`. */
  data?: unknown;
};

/**
 * A thrown error as a refusal, or null when nobody tagged it (a crash: the door logs it and answers
 * `internal_error`). The mapping is the one the box's door made into JSON-RPC errors (vault#554, every domain error
 * class by a branch of its own, then any error carrying `error_type`), with the same fields.
 */
export function refusalOfError(err: unknown): McpRefusal | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Tagged;
  const message = plainMessage(err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? ""));
  // an McpError a tool or a door already formed: its data is the refusal's fields
  if (isPlainObject(e.data) && typeof e.data.error_type === "string") {
    const { error_type, ...rest } = e.data;
    return refusal(error_type as string, message, rest);
  }
  // index: which item of a batch (create-note's shape check, T-476)
  if (e.error_type === "invalid_query") return refusal("invalid_query", message, { field: e.field, got: e.got, hint: e.hint, how_to: e.how_to, index: e.index });
  if (e.error_type === "invalid_search_syntax") return refusal("invalid_search_syntax", message, { field: e.field, got: e.got, hint: e.hint });
  if (e.code === "CONFLICT") {
    return refusal("conflict", message, {
      current_updated_at: e.current_updated_at ?? null, your_updated_at: e.expected_updated_at, path: e.note_path ?? null, note_id: e.note_id,
      hint: "re-read the note (query-notes) and re-apply your change against its current updated_at, or pass force: true to overwrite",
    });
  }
  // a state transition's compare-and-set (vault#299 Part B): the value didn't match, not the updated_at token
  if (e.code === "TRANSITION_CONFLICT") {
    return refusal("transition_conflict", message, {
      note_id: e.note_id, path: e.note_path ?? null, field: e.field, expected_from: e.expected_from, to: e.to, current: e.current ?? null,
      hint: "re-read the note's current value for this field and retry the transition from its actual current state",
    });
  }
  if (e.code === "PUBLISH_OUT_OF_SCOPE") return refusal("tag_scope_violation", message);
  // a skill is instructions every connected AI may follow; only an admin key adds or changes one (T-476)
  if (e.code === "SKILL_NEEDS_ADMIN") return refusal("skill_needs_admin", message, { hint: e.hint });
  if (e.code === "SCHEMA_VALIDATION") return refusal("schema_validation", message, { violations: e.violations ?? [], hint: "fix every field listed in violations and retry — none of this write was applied" });
  if (e.code === "PRECONDITION_REQUIRED") {
    return refusal("precondition_required", message, { note_id: e.note_id, path: e.note_path ?? null, hint: "re-read the note and pass its updatedAt as if_updated_at, or pass force: true to skip the check" });
  }
  // any other QueryError (FIELD_NOT_INDEXED, UNKNOWN_OPERATOR, …): the umbrella REST uses for the class
  if (e.name === "QueryError") return refusal(typeof e.error_type === "string" ? e.error_type : "invalid_query", message, { code: e.code, field: e.field, got: e.got, hint: e.hint });
  // a malformed or stale cursor: its code is the word ("cursor_invalid", "cursor_query_mismatch")
  if (e.name === "CursorError" && typeof e.code === "string") return refusal(e.code, message);
  if (e.code === "PATH_CONFLICT") return refusal("path_conflict", message, { path: e.path });
  if (e.code === "AMBIGUOUS_PATH") return refusal("ambiguous_path", message, { path: e.path, candidates: e.candidates });
  if (e.code === "INVALID_EXTENSION") return refusal("invalid_extension", message, { extension: e.extension, reason: e.reason });
  if (e.code === "BATCH_TOO_LARGE") return refusal("batch_too_large", message, { limit: e.limit, got: e.got });
  if (e.code === "TAG_FIELD_CONFLICT") return refusal("tag_field_conflict", message, { tag: e.tag, violations: e.violations ?? [] });
  if (e.code === "PARENT_CYCLE") return refusal("parent_cycle", message, { tag: e.tag, cycle: e.cycle ?? [] });
  if (e.code === "HISTORY_UNRECOVERABLE") {
    const imported = e.origin === "git-import" && typeof e.import_ix === "number" && Number.isSafeInteger(e.import_ix) && e.import_ix >= 0;
    return refusal("history_unrecoverable", message, imported ? { origin: "git-import", import_ix: e.import_ix } : { field: e.field, hint: e.hint });
  }
  // any other error that carries a stable `error_type` (a domain class that stamps it, or a `structuredError` leaf):
  // its known fields go with it
  if (typeof e.error_type === "string") {
    return refusal(e.error_type, message, {
      field: e.field, hint: e.hint, limit: e.limit, got: e.got, unused: e.unused, fields: e.fields, extension: e.extension,
      how_to: e.how_to, size: e.size, max_bytes: e.max_bytes, mime_type: e.mime_type,
      // delete's refusals (core/src/mcp.ts): which were done, which failed, which weren't there; a path's candidates
      done: e.done, failed: e.failed, missing: e.missing, path: e.path, candidates: e.candidates,
    });
  }
  return null;
}

/** What a connection at each level is told it has, when it calls a tool it can't see (T-476). */
const LEVEL_WORDS: Record<"read" | "write" | "admin", string> = {
  read: "This connection can read; tools that write or need admin aren't listed for it.",
  write: "This connection can read and write; tools that need admin aren't listed for it.",
  admin: "tools/list names every tool this connection has.",
};

/**
 * What a door answers for a tool it doesn't offer this caller. It never says whether the tool exists at another level
 * (the same words for a tool above the caller and for none at all); given the caller's own `level`, it says what that
 * level is, so an AI can tell the person "this needs admin" (T-476; the `docs` page says how the person grants it).
 */
export const unknownToolRefusal = (name: string, level?: "read" | "write" | "admin"): McpRefusal =>
  refusal("unknown_tool", `Unknown tool: ${name}${level ? `. ${LEVEL_WORDS[level]}` : ""}`, { tool: name });

/** What a door answers for an error nobody tagged: a crash, not a refusal; the door logs it (mcp-error-log.ts). */
export const internalRefusal = (err: unknown): McpRefusal => refusal("internal_error", `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
