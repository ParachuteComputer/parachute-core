/**
 * The names a REST request is counted under (T-407 name use; T-456 per client on cloud): the vault-relative route
 * with ids taken out, never a value, a path or a type's name. One copy for every door (a box's name-usage.ts, the
 * cloud vault worker), so the same request is counted under the same name everywhere.
 */

/**
 * A REST request's route name for the count: the vault-relative path with ids
 * taken out (`/api/notes/:id/versions/:x`). Only note-named routes are counted.
 */
export function restRouteName(method: string, apiPath: string): string | null {
  if (!/^\/notes(\/|$)/.test(apiPath)) return null;
  const parts = apiPath.split("/").filter(Boolean);
  const SUBS = new Set(["attachments", "retry-transcription", "versions", "imports", "restore"]);
  const shape = parts.slice(0, 4).map((p, i) => (i === 0 ? p : i === 1 ? ":id" : i === 2 ? (SUBS.has(p) ? p : "?") : ":x"));
  return `rest ${method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8)} /api/${shape.join("/")}`;
}

/** An `/api/types` request's route name for the count (`apiPath` is its `/tags…` twin): names only, never a type's. */
export function typesRouteName(method: string, apiPath: string): string {
  const parts = apiPath.split("/").filter(Boolean).slice(1, 3);
  const shape = parts.map((p, i) => (i === 0 ? (p === "merge" ? p : ":name") : ["rename", "conformance", "effective"].includes(p) ? p : "?"));
  return `rest ${method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8)} /api/${["types", ...shape].join("/")}`;
}
