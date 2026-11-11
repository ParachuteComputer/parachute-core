/**
 * Cursor paging for a caller that sees only some notes (scope gap 2,
 * `queryNotesPaged(db, opts, visible)`). The black-box leak contract is
 * parachute-core's contracts/suites/safety/scope-gaps.test.ts; this pins the
 * paging logic itself, which is dense: batches larger than the page, a scan
 * that resumes past hidden rows, and a watermark built from visible rows only.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { decodeCursor } from "./cursor.js";

async function vault(n: number) {
  const db = new Database(":memory:");
  const store = new SqliteStore(db);
  const visibleIds: string[] = [];
  const hiddenIds = new Set<string>();
  // Long runs of hidden notes (more than one internal batch) between visible ones.
  for (let i = 0; i < n; i++) {
    const hidden = i % 7 !== 0 || (i > 210 && i < 520);
    const note = await store.createNote(`note ${i}`, { path: `p/${i}`, tags: [hidden ? "other" : "mine"] });
    if (hidden) hiddenIds.add(note.id);
    else visibleIds.push(note.id);
  }
  const visible = (note: { tags?: string[] }) => (note.tags ?? []).includes("mine");
  return { store, visibleIds, hiddenIds, visible };
}

describe("queryNotesPaged with a visibility predicate", () => {
  it("walks every visible note exactly once, in full pages, with cursors that name only visible notes", async () => {
    const { store, visibleIds, hiddenIds, visible } = await vault(700);
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 100; i++) {
      const page = await store.queryNotesPaged({ cursor, limit: 10 }, visible);
      expect(page.notes.every(visible)).toBe(true);
      const at = decodeCursor(page.next_cursor!).last_id;
      expect(hiddenIds.has(at)).toBe(false);
      seen.push(...page.notes.map((n) => n.id));
      if (page.notes.length < 10) break;
      cursor = page.next_cursor!;
    }
    expect(seen).toEqual(visibleIds);
  });

  it("a filter that matches only hidden notes answers exactly as one that matches nothing", async () => {
    const { store, visible } = await vault(300);
    const hidden = await store.queryNotesPaged({ cursor: "", limit: 5, tags: ["other"] }, visible);
    const none = await store.queryNotesPaged({ cursor: "", limit: 5, tags: ["nothing-here"] }, visible);
    expect(hidden.notes).toEqual([]);
    expect(decodeCursor(hidden.next_cursor!).last_id).toBe(decodeCursor(none.next_cursor!).last_id);
    expect(decodeCursor(hidden.next_cursor!).last_updated_at).toBe(0);
  });

  it("without a predicate, paging is unchanged", async () => {
    const { store } = await vault(30);
    const page = await store.queryNotesPaged({ cursor: "", limit: 10 });
    expect(page.notes.length).toBe(10);
  });
});
