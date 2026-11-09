/**
 * Tag names are case-sensitive everywhere else in the engine (`Work` and `work`
 * are two tags, and a query for one never returns the other), but rename-tag
 * picked the sub-tags to carry along with an ASCII-case-insensitive prefix (the
 * `LIKE` it used to be, kept on purpose by core#27). Renaming `Work` therefore
 * also renamed `work`'s child `work/sub` to `Job/sub`, and rewrote `#work/sub`
 * in its notes: a write to a tag the caller never named. With both `Work/sub`
 * and `work/sub` present, both mapped to `Job/sub` and the rename threw.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";

describe("rename-tag sub-tags match the old name's case exactly", () => {
  it("renaming `Work` leaves `work/sub` (a child of the other tag `work`) alone", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await store.createNote("a #Work", { id: "a", tags: ["Work"] });
    await store.createNote("b #Work/mine", { id: "b", tags: ["Work/mine"] });
    await store.createNote("c #work/sub", { id: "c", tags: ["work/sub"] });
    await store.createNote("d #work", { id: "d", tags: ["work"] });

    const r = await store.renameTag("Work", "Job");

    expect(r.sub_tags_renamed).toBe(1);
    const names = (await store.listTags()).map((t) => t.name).sort();
    expect(names).toEqual(["Job", "Job/mine", "work", "work/sub"]);
    expect((await store.getNote("b"))!.content).toBe("b #Job/mine");
    expect((await store.getNote("c"))!.content).toBe("c #work/sub");
    expect((await store.getNote("c"))!.tags).toEqual(["work/sub"]);
  });

  it("renaming `Work` succeeds when both `Work/sub` and `work/sub` exist", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await store.createNote("a #Work/sub", { id: "a", tags: ["Work", "Work/sub"] });
    await store.createNote("c #work/sub", { id: "c", tags: ["work/sub"] });

    // Before the fix both sub-tags mapped to `Job/sub`: UNIQUE constraint failed: tags.name.
    const r = await store.renameTag("Work", "Job");

    expect("error" in r).toBe(false);
    const names = (await store.listTags()).map((t) => t.name).sort();
    expect(names).toEqual(["Job", "Job/sub", "work/sub"]);
  });
});
