// The change log's request edge (0.9.4): one request is one write set, and nothing it leaves running writes as it.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { withWriteSet } from "./write-set-edge.ts";

describe("write-set edge", () => {
  test("a hook's later write is its own set, never the caller's", async () => {
    const hooks = new HookRegistry();
    const db = new Database(":memory:");
    const store = new SqliteStore(db, { hooks });
    const other = await store.createNote("other", { path: "other" });
    let done!: () => void;
    const hookWrote = new Promise<void>((r) => (done = r));
    hooks.onNote({
      name: "later-writer",
      event: "created",
      when: (n) => n.path === "mine",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30));
        await store.updateNote(other.id, { content: "changed by a hook" });
        done();
      },
    } as any);
    await withWriteSet(store, { id: "ws_caller00001", actor: "alice", via: "key:alice", why: "make one note" }, async () => {
      await store.createNote("mine", { path: "mine" });
      await hookWrote; // the call is still open while the hook writes
    });
    const row = db.prepare("SELECT write_set FROM record_changes WHERE note_id = ? ORDER BY seq DESC LIMIT 1").get(other.id) as { write_set: string | null };
    expect(row.write_set).not.toBe("ws_caller00001");
    const set = db.prepare("SELECT via, why FROM write_sets WHERE id = ?").get(row.write_set) as { via: string | null; why: string | null } | null;
    expect(set?.via ?? null).toBeNull();
    expect(set?.why ?? null).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE write_set = 'ws_caller00001'").get() as any).n).toBe(1);
  });

  test("a write after the call has answered is not the call's", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    let later!: Promise<void>;
    await withWriteSet(store, { id: "ws_answered001", actor: "a", via: "key:a" }, async () => {
      await store.createNote("now", { path: "now" });
      later = new Promise<void>((r) => setTimeout(async () => { await store.createNote("later", { path: "later" }); r(); }, 20));
    });
    await later;
    const ids = (db.prepare("SELECT n.path, rc.write_set FROM record_changes rc JOIN notes n ON n.id = rc.note_id").all() as any[]);
    expect(ids.find((r) => r.path === "now").write_set).toBe("ws_answered001");
    expect(ids.find((r) => r.path === "later").write_set).not.toBe("ws_answered001");
  });
});
