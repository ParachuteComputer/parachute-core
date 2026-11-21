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
// Erasing takes only an exact id or path (no case folding, no H1 title), since it can't be undone. A tag-scoped
// pass resolves a list among the notes it can see and can't name a deleted note's leftover history.
// Erasing history was already admin-only (vault#524), so both erases need admin. Listing deleted notes needs write
// (T-476: what write access may delete and restore, it may also list) and an unscoped pass (a deleted note has no
// tags left to check a scope against; a scoped pass gets 404, as on /history/compact). A plain delete is unchanged:
// it keeps the tombstone.
import { describe, expect, test } from "bun:test";
import { enc, mcp, operator, pass, rest, runId, services } from "../lib.ts";
import { note, scopedAdmin } from "./_lib.ts";

const s = services();
const op = operator();
const R = runId("fg").replace(/-/g, "");
const TAG = `${R}t`;
const OTHER = `${R}o`;

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

describe("erasing takes only an exact id or path (it can't be undone)", () => {
  test("REST: a path that matches only without case finds nothing to erase, and the note stays", async () => {
    const id = await noteWithHistory("solo/Today");
    const r = await op.del(`/notes/${enc(`${R}/solo/today`)}?erase_history=true`);
    expect(r.status).toBe(404);
    expect((await op.get(`/notes/${id}`)).status).toBe(200);
    expect((await versions(id)).body.total).toBeGreaterThanOrEqual(1);
  });

  test("REST DELETE /notes/:id/versions: a path that matches only without case finds nothing to erase", async () => {
    const id = await noteWithHistory("solo/Versions");
    expect((await op.del(`/notes/${enc(`${R}/solo/versions`)}/versions`)).status).toBe(404);
    expect((await versions(id)).body.total).toBeGreaterThanOrEqual(1);
    expect((await op.del(`/notes/${enc(`${R}/solo/Versions`)}/versions`)).status).toBe(200);
    expect((await versions(id)).body.total).toBe(0);
  });

  test("REST: a name that fits two notes is a 409 that says to use the id, and nothing is erased", async () => {
    const plain = await note(`${R}/Rest.v2`, "made up", [TAG]);
    const other = await op.post("/notes", { path: `${R}/Rest`, extension: "v2", content: "made up" });
    const r = await op.del(`/notes/${enc(`${R}/Rest.v2`)}?erase_history=true`);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/by its id/);
    expect((await op.get(`/notes/${plain}`)).status).toBe(200);
    expect((await op.get(`/notes/${other.body.id}`)).status).toBe(200);
  });

  test("MCP: of two notes whose paths differ only by case, the one named is erased and the other stays", async () => {
    const upper = await noteWithHistory("pair/Today");
    const lower = await noteWithHistory("pair/today");
    const r = await viaMcp(await pass({ level: "admin" }), { id: `${R}/pair/today`, erase_history: true });
    expect(r).toMatchObject({ deleted: true, id: lower });
    expect((await op.get(`/notes/${upper}`)).status).toBe(200);
    expect((await versions(upper)).body.total).toBeGreaterThanOrEqual(1);
  });

  test("MCP: a name that fits two notes is refused, says to use the id, and deletes nothing", async () => {
    const plain = await note(`${R}/Recipe.v2`, "made up", [TAG]);
    const r = await op.post("/notes", { path: `${R}/Recipe`, extension: "v2", content: "made up" });
    expect(r.status).toBe(201);
    await expect(viaMcp(await pass({ level: "admin" }), { ids: [`${R}/Recipe.v2`], erase_history: true })).rejects.toThrow(/ambiguous|more than one note.*by its id/i);
    expect((await op.get(`/notes/${plain}`)).status).toBe(200);
    expect((await op.get(`/notes/${r.body.id}`)).status).toBe(200);
  });

  test("MCP: an H1 title doesn't name a note to erase", async () => {
    const id = await note(`${R}/titled`, `# Quarterly ${R}\nmade up`, [TAG]);
    await expect(viaMcp(await pass({ level: "admin" }), { ids: [`Quarterly ${R}`], erase_history: true })).rejects.toThrow(/not_found|not found/i);
    expect((await op.get(`/notes/${id}`)).status).toBe(200);
  });
});

describe("a tag-scoped pass", () => {
  test("a list naming a note outside its tags deletes nothing, plain or erasing", async () => {
    const mine = await noteWithHistory("scoped-mine");
    const theirs = await note(`${R}/scoped-theirs`, "made up", [OTHER]);
    for (const level of ["write", "admin"] as const) {
      const scoped = level === "admin" ? await scopedAdmin([TAG]) : await pass({ level, tags: [TAG] });
      await expect(viaMcp(scoped, { ids: [mine, theirs] })).rejects.toThrow(/not_found|not found/i);
    }
    await expect(viaMcp(await scopedAdmin([TAG]), { ids: [mine, theirs], erase_history: true })).rejects.toThrow(/not_found|not found/i);
    expect((await op.get(`/notes/${mine}`)).status).toBe(200);
    expect((await op.get(`/notes/${theirs}`)).status).toBe(200);
  });

  test("an admin one erases a note in its tags, but can't name history a deleted note left", async () => {
    const scoped = await scopedAdmin([TAG]);
    const live = await noteWithHistory("scoped-live");
    expect(await viaMcp(scoped, { ids: [live], erase_history: true })).toMatchObject({ deleted: 1 });
    const left = await noteWithHistory("scoped-left");
    expect((await op.del(`/notes/${left}`)).status).toBe(200);
    await expect(viaMcp(scoped, { ids: [left], erase_history: true })).rejects.toThrow(/not_found|not found/i);
    expect((await versions(left)).body.total).toBeGreaterThanOrEqual(1);
  });
});

describe("who may list deleted notes", () => {
  // Write access may already delete and restore; listing what it can put back is the same reach (T-476: "an ai with
  // write access can see deleted records"). Reading stays out: a read pass can't put anything back.
  test("a write pass lists deleted notes and can restore one it finds there; a read pass is refused (403)", async () => {
    const id = await noteWithHistory("writer-finds");
    expect((await op.del(`/notes/${id}`)).status).toBe(200);
    const writer = rest(s.vaultViaHub, await pass({ level: "write" }));
    const w = await writer.get("/history/deleted?limit=500");
    expect(w.status).toBe(200);
    const row = (w.body.notes as any[]).find((n) => n.id === id);
    expect(row).toMatchObject({ id, path: `${R}/writer-finds` });
    expect(typeof row.deleted_at).toBe("string");
    // what deleted it, from its tombstone (the newest version), which the same pass reads by id
    const v = await writer.get(`/notes/${id}/versions?limit=1`);
    expect(v.status).toBe(200);
    expect(v.body.versions[0].op).toBe("delete");
    const back = await writer.post(`/notes/${id}/restore`, { version_ix: v.body.versions[0].version_ix });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.recreated).toBe(true);
    expect((await writer.get("/history/deleted?limit=500")).body.notes.map((n: { id: string }) => n.id)).not.toContain(id);
    const r = await rest(s.vaultViaHub, await pass({ level: "read" })).get("/history/deleted");
    expect(r.status).toBe(403);
    expect(r.body.error_type).toBe("insufficient_scope");
    expect(r.body.required_scope).toBe("vault:write");
  });

  // Putting a deleted note back is a change made now: a reader asking what changed since (a sync, a "what changed"
  // view) must find it. It used to come back with the updatedAt it had before it was deleted.
  test("a note put back from deletion is changed now: its updatedAt is the restore's, and a since-query finds it", async () => {
    const id = await noteWithHistory("back-now");
    expect((await op.del(`/notes/${id}`)).status).toBe(200);
    const writer = rest(s.vaultViaHub, await pass({ level: "write" }));
    const tomb = (await writer.get(`/notes/${id}/versions?limit=1`)).body.versions[0];
    await Bun.sleep(5);
    const before = new Date().toISOString();
    const back = await writer.post(`/notes/${id}/restore`, { version_ix: tomb.version_ix });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.updatedAt >= before, `${back.body.updatedAt} should be at or after ${before}`).toBe(true);
    expect(back.body.createdAt < before).toBe(true);
    const since = await writer.get(`/notes?path_prefix=${enc(`${R}/back-now`)}&include_content=false&meta[updated_at][gte]=${enc(before)}`);
    expect(since.status).toBe(200);
    const rows = (Array.isArray(since.body) ? since.body : since.body.notes) as { id: string }[];
    expect(rows.map((n) => n.id)).toContain(id);
  });

  test("a tag-scoped pass finds nothing there (404, as /history/compact), at write and at admin", async () => {
    expect((await rest(s.vaultViaHub, await pass({ level: "write", tags: [TAG] })).get("/history/deleted")).status).toBe(404);
    expect((await rest(s.vaultViaHub, await scopedAdmin([TAG])).get("/history/deleted")).status).toBe(404);
  });
});
