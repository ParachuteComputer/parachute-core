// Deleting can forget (T-412).
//
// A delete keeps a version of the note (a tombstone), so a deleted note stays restorable: on cloud, which sets no
// retention for deleted notes, forever. The only way to really forget was to erase each note's history with its own
// admin request (`DELETE /notes/:id/versions`), and nothing listed deleted notes, so versions left by an interrupted
// "delete everything" could not be found again (the Taste Arcade test, 11-08).
//
// Now, additive and opt-in:
// - REST `DELETE /notes/:id?erase_history=true` deletes the note and every version of it;
// - MCP `delete-note` takes `erase_history: true`, and `ids: [...]` for a list (all resolved before anything is
//   deleted); with `erase_history` an id may also be a note already deleted that left history;
// - REST `GET /history/deleted` lists deleted notes that still have history.
// Erasing history was already admin-only (vault#524), so all three need admin; listing deleted notes needs an
// unscoped pass (a deleted note has no tags left to check a scope against; a scoped admin gets 404, as on
// /history/compact). A plain delete is unchanged: it keeps the tombstone.
import { describe, expect, test } from "bun:test";
import { mcp, operator, pass, rest, runId, services } from "../lib.ts";
import { note } from "./_lib.ts";

const s = services();
const op = operator();
const R = runId("fg").replace(/-/g, "");
const TAG = `${R}t`;

/** A note with two versions of history behind it (made up). */
async function noteWithHistory(name: string): Promise<string> {
  const id = await note(`${R}/${name}`, `made up ${name} one`, [TAG]);
  const r = await op.patch(`/notes/${id}`, { content: `made up ${name} two`, force: true });
  if (r.status !== 200) throw new Error(`setup: editing ${name} gave ${r.status}`);
  return id;
}
const versions = async (id: string) => op.get(`/notes/${id}/versions`);
async function deletedIds(): Promise<string[]> {
  const r = await op.get("/history/deleted?limit=500");
  expect(r.status).toBe(200);
  return (r.body.notes as { id: string }[]).map((n) => n.id);
}
async function viaMcp<T = any>(token: string, args: Record<string, unknown>): Promise<T> {
  const c = await mcp(`${s.vaultViaHub}/mcp`, token);
  try {
    return await c.call<T>("delete-note", args);
  } finally {
    await c.close();
  }
}

describe("a plain delete is unchanged", () => {
  test("REST: the note goes, its history stays and it can be restored", async () => {
    const id = await noteWithHistory("plain");
    expect((await op.del(`/notes/${id}`)).status).toBe(200);
    const v = await versions(id);
    expect(v.status).toBe(200);
    expect(v.body.total).toBeGreaterThanOrEqual(2);
    const back = await op.post(`/notes/${id}/restore`, { version_ix: 0 });
    expect(back.status).toBe(200);
  });

  test("a delete leaves the note listed under GET /history/deleted until its history is erased", async () => {
    const id = await noteWithHistory("listed");
    expect((await op.del(`/notes/${id}`)).status).toBe(200);
    const r = await op.get("/history/deleted?limit=500");
    expect(r.status).toBe(200);
    const row = (r.body.notes as any[]).find((n) => n.id === id);
    expect(row).toMatchObject({ id, path: `${R}/listed` });
    expect(row.versions).toBeGreaterThanOrEqual(2);
    expect(typeof row.deleted_at).toBe("string");
    expect(typeof r.body.total).toBe("number");
    expect((await op.del(`/notes/${id}/versions`)).status).toBe(200);
    expect(await deletedIds()).not.toContain(id);
  });
});

describe("REST DELETE /notes/:id?erase_history=true", () => {
  test("deletes the note and every version of it: nothing left to list, read or restore", async () => {
    const id = await noteWithHistory("rest-erase");
    const r = await rest(s.vaultViaHub, await pass({ level: "admin" })).del(`/notes/${id}?erase_history=true`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deleted: true, id });
    expect(r.body.history_erased.versions_deleted).toBeGreaterThanOrEqual(1);
    expect((await op.get(`/notes/${id}`)).status).toBe(404);
    expect((await versions(id)).status).toBe(404);
    expect((await op.post(`/notes/${id}/restore`, { version_ix: 0 })).status).toBe(404);
    expect(await deletedIds()).not.toContain(id);
  });

  test("needs admin: a write pass gets 403 and the note stays", async () => {
    const id = await noteWithHistory("rest-write");
    const r = await rest(s.vaultViaHub, await pass({ level: "write" })).del(`/notes/${id}?erase_history=true`);
    expect(r.status).toBe(403);
    expect(r.body.error_type).toBe("insufficient_scope");
    expect((await op.get(`/notes/${id}`)).status).toBe(200);
  });

  test("erase_history=false is a plain delete", async () => {
    const id = await noteWithHistory("rest-false");
    expect((await rest(s.vaultViaHub, await pass({ level: "write" })).del(`/notes/${id}?erase_history=false`)).status).toBe(200);
    expect((await versions(id)).status).toBe(200);
  });
});

describe("MCP delete-note with ids and erase_history", () => {
  test("a list with erase_history forgets each note", async () => {
    const a = await noteWithHistory("mcp-a");
    const b = await noteWithHistory("mcp-b");
    const r = await viaMcp(await pass({ level: "admin" }), { ids: [a, `${R}/mcp-b`], erase_history: true });
    expect(r.deleted).toBe(2);
    expect(r.results.map((x: any) => x.id).sort()).toEqual([a, b].sort());
    for (const x of r.results) expect(x.history_erased.versions_deleted).toBeGreaterThanOrEqual(1);
    for (const id of [a, b]) {
      expect((await op.get(`/notes/${id}`)).status).toBe(404);
      expect((await versions(id)).status).toBe(404);
    }
  });

  test("forgets the history a plain delete left behind, found through GET /history/deleted", async () => {
    const a = await noteWithHistory("left-a");
    const b = await noteWithHistory("left-b");
    const writer = await pass({ level: "write" });
    // A plain delete of a list: allowed at write, and keeps the history.
    const plain = await viaMcp(writer, { ids: [a, b] });
    expect(plain.deleted).toBe(2);
    const left = (await deletedIds()).filter((id) => id === a || id === b).sort();
    expect(left).toEqual([a, b].sort());
    const r = await viaMcp(await pass({ level: "admin" }), { ids: left, erase_history: true });
    expect(r.deleted).toBe(0);
    expect(r.results.every((x: any) => x.deleted === false && x.history_erased.versions_deleted >= 1)).toBe(true);
    expect((await deletedIds()).filter((id) => id === a || id === b)).toEqual([]);
  });

  test("one id with erase_history answers like a plain delete, with what it erased", async () => {
    const id = await noteWithHistory("mcp-one");
    const r = await viaMcp(await pass({ level: "admin" }), { id, erase_history: true });
    expect(r).toMatchObject({ deleted: true, id });
    expect(r.history_erased.versions_deleted).toBeGreaterThanOrEqual(1);
    expect((await versions(id)).status).toBe(404);
  });

  test("needs admin for erase_history: a write session is refused and nothing is deleted", async () => {
    const a = await noteWithHistory("mcp-w");
    await expect(viaMcp(await pass({ level: "write" }), { ids: [a], erase_history: true })).rejects.toThrow(/insufficient_scope/);
    expect((await op.get(`/notes/${a}`)).status).toBe(200);
  });

  test("a list naming a note that doesn't exist deletes nothing", async () => {
    const a = await noteWithHistory("mcp-miss");
    await expect(viaMcp(await pass({ level: "admin" }), { ids: [a, `${R}/no-such-note`], erase_history: true })).rejects.toThrow(/not_found|not found/i);
    expect((await op.get(`/notes/${a}`)).status).toBe(200);
    expect((await versions(a)).body.total).toBeGreaterThanOrEqual(1);
  });
});

describe("who may list deleted notes", () => {
  test("a write pass is refused (403), and a tag-scoped admin pass finds nothing there (404, as /history/compact)", async () => {
    const w = await rest(s.vaultViaHub, await pass({ level: "write" })).get("/history/deleted");
    expect(w.status).toBe(403);
    expect(w.body.error_type).toBe("insufficient_scope");
    expect((await rest(s.vaultViaHub, await pass({ level: "admin", tags: [TAG] })).get("/history/deleted")).status).toBe(404);
  });
});
