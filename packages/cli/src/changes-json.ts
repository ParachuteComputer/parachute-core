// The change map as `parachute changes --json` prints it, and as the hub serves it at
// /.well-known/parachute-changes.json: one function, so the two cannot drift.
import changesMap from "./changes-0.9.json" with { type: "json" };

/** The map with its `changes` last, as one JSON line (no trailing newline). Pass a subset to narrow the list. */
export function changesJson(list: unknown[] = changesMap.changes): string {
  const { changes: _all, ...head } = changesMap;
  return JSON.stringify({ ...head, changes: list });
}
