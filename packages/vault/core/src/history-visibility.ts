/** Response-only redaction; never remove stored provenance or rewrite note content.
 * Tag-restricted sessions do not receive historical editor/interface identities.
 * The transport must establish note visibility before applying this projection.
 */
export function projectHistoryProvenance<T extends object>(row: T, restricted: boolean): T | Omit<T, "actor" | "via" | "via_kind" | "write_set" | "why" | "links"> {
  if (!restricted) return row;
  // A tag-scoped reader sees neither who wrote nor why (0.9.4), nor the version's links (their targets may be records
  // outside its scope).
  const { actor: _actor, via: _via, via_kind: _kind, write_set: _ws, why: _why, links: _links, ...visible } = row as T & { actor?: unknown; via?: unknown; via_kind?: unknown; write_set?: unknown; why?: unknown; links?: unknown };
  return visible;
}
