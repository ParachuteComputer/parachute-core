/** Response-only redaction; never remove stored provenance or rewrite note content.
 * Tag-restricted sessions do not receive historical editor/interface identities.
 * The transport must establish note visibility before applying this projection.
 */
export function projectHistoryProvenance<T extends object>(row: T, restricted: boolean): T | Omit<T, "actor" | "via" | "via_kind" | "marked_by"> {
  if (!restricted) return row;
  // marked_by (T-460) names a writer as actor does; marked_at alone stays, so a scoped reader still sees it is kept.
  const { actor: _actor, via: _via, via_kind: _kind, marked_by: _markedBy, ...visible } = row as T & { actor?: unknown; via?: unknown; via_kind?: unknown; marked_by?: unknown };
  return visible;
}
