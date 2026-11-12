/**
 * What each MCP tool does to the vault, as MCP tool annotations (spec 2025-03-26+): sent on every `tools/list` at
 * every door, so a client can tell a read from a change without calling it.
 *
 * Why (T-456, 11-12): with no annotations a client must assume the worst. ChatGPT treats every unannotated tool as a
 * consequential write: its "Allow read-only tools" setting then still asks before each read. The hints are honest
 * rather than generous: a client may skip asking for a read-only tool, so a tool is read-only here only if no call
 * can change the vault. `create-*` can overwrite (`if_exists: "replace"`), so it counts as destructive.
 *
 *   readOnlyHint     no call changes the vault
 *   destructiveHint  (changes only) a call can overwrite or remove what was there
 *   idempotentHint   (changes only) the same call again changes nothing more
 *   openWorldHint    false everywhere: a tool reaches this vault only
 *
 * Every vault tool a door lists is here; a contract checks every listed tool carries all four. The account door's
 * own five (list-vaults …) carry theirs where they are defined (packages/hub/src/account-mcp.ts).
 * Pure: no imports, so the cloud runtime uses the same table.
 */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds, never overwrites (an upload ticket, a new vault, a grant). */
const ADD: McpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Can overwrite or remove. */
const CHANGE: McpToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Removes, and a repeat removes nothing more. */
const REMOVE: McpToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const TOOL_ANNOTATIONS: Readonly<Record<string, McpToolAnnotations>> = {
  // Reads.
  "query-records": READ,
  "query-notes": READ,
  "list-types": READ,
  "list-tags": READ,
  "vault-info": READ,
  doctor: READ,
  "read-attachment": READ,
  "find-path": READ,
  "request-attachment-download": READ, // mints a one-use download URL for bytes the caller can already read
  // Changes.
  "create-record": CHANGE, // if_exists: "update" | "replace" overwrite
  "create-note": CHANGE,
  "update-record": CHANGE,
  "update-note": CHANGE,
  "delete-record": REMOVE,
  "delete-note": REMOVE,
  "attachment-url": ADD, // upload: a ticket that adds an attachment; download: as above
  "request-attachment-upload": ADD,
  "manage-types": CHANGE, // rename, merge, delete, prune, migrate
  "update-tag": CHANGE,
  "rename-tag": CHANGE,
  "merge-tags": CHANGE,
  "delete-tag": REMOVE,
  "prune-schema": REMOVE,
  "migrate-field": CHANGE,
  "manage-keys": CHANGE, // revokes keys
  "manage-token": CHANGE,
};

/** A tool's annotations, or the cautious default for a name the table doesn't know (a change that can overwrite). */
export function toolAnnotations(name: string): McpToolAnnotations {
  return TOOL_ANNOTATIONS[name] ?? CHANGE;
}
