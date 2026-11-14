// v1: a saved version carries the tags the note had when it was saved, and a tag-scoped pass sees only the versions
// whose tags were in its scope (T-419; audit L3-11, gap G-A).
//
// Today a version is checked against the note's tags now. A note written under a tag the reader can't see, then moved
// into the reader's tag, shows the reader every old version: content the reader was never shown. Decided (Uni, 11-08,
// with the 0.9.1 access checkpoint): versions record their tags, and history follows them. Closing history to every
// scoped pass was the stopgap considered and not taken; the plain test at the end keeps it from coming back by
// accident. Marked `.failing` until built; see README.md here.
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, operator, pass, rest, runId, services } from "../lib.ts";
import { note } from "../safety/_lib.ts";

// Decided for v1, missing today: expected to fail. V1_SHOW=1 runs them as plain tests, to read why they fail.
const pending = process.env.V1_SHOW ? test : test.failing;

const s = services();
const op = operator();
const R = runId("hs").replace(/-/g, "");
const MINE = `${R}mine`;
const SECRET = `${R}secret`;
const OLD = "draft with a made-up password hunter2";
const CLEAN = "cleaned, nothing to see";
let id = "";
/** version_ix of the version holding OLD (saved under SECRET only) and of one holding CLEAN (saved under MINE). */
let hidden = -1;
let shown = -1;

async function versionsWith(api: ReturnType<typeof rest>): Promise<{ ix: number; content: string }[]> {
  const list = await api.get(`/notes/${id}/versions?limit=50`);
  if (list.status !== 200) return [];
  return Promise.all(
    (list.body.versions as { version_ix: number }[]).map(async (v) => ({
      ix: v.version_ix,
      content: String((await api.get(`/notes/${id}/versions/${v.version_ix}`)).body?.content ?? ""),
    })),
  );
}

beforeAll(async () => {
  // Written under SECRET, then moved into MINE and cleaned, then edited again under MINE. Whichever way the vault
  // snapshots (before or after a write), one version holds OLD with only SECRET, and one holds CLEAN with MINE.
  id = await note(`${R}/moved`, OLD, [SECRET]);
  const moved = await op.patch(`/notes/${id}`, { content: CLEAN, tags: { add: [MINE], remove: [SECRET] }, force: true });
  if (moved.status !== 200) throw new Error(`setup: moving the note gave ${moved.status}: ${JSON.stringify(moved.body).slice(0, 300)}`);
  const edited = await op.patch(`/notes/${id}`, { content: "second edit, still in scope", force: true });
  if (edited.status !== 200) throw new Error(`setup: the second edit gave ${edited.status}: ${JSON.stringify(edited.body).slice(0, 300)}`);
  const all = await versionsWith(op);
  hidden = all.find((v) => v.content === OLD)?.ix ?? -1;
  shown = all.find((v) => v.content === CLEAN)?.ix ?? -1;
});

describe("v1: history follows the tags a version had (L3-11)", () => {
  test("setup works today: the operator has a version under SECRET and one under MINE; the reader sees the note now", async () => {
    expect(hidden).toBeGreaterThanOrEqual(0);
    expect(shown).toBeGreaterThanOrEqual(0);
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    const now = await reader.get(`/notes/${id}`);
    expect(now.status).toBe(200);
    expect(JSON.stringify(now.body)).not.toContain("hunter2");
  });

  pending("REST: the scoped reader's version list leaves out the version saved under SECRET", async () => {
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    const list = await reader.get(`/notes/${id}/versions?limit=50`);
    expect(list.status).toBe(200);
    expect((list.body.versions as { version_ix: number }[]).map((v) => v.version_ix)).not.toContain(hidden);
    expect(list.body.versions.length).toBe(list.body.total);
  });

  pending("REST: reading the version saved under SECRET answers 404, like a hidden note", async () => {
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    const r = await reader.get(`/notes/${id}/versions/${hidden}`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
  });

  pending("REST: a scoped writer can't restore the version saved under SECRET, and the note is unchanged", async () => {
    const writer = rest(s.vaultViaHub, await pass({ level: "write", tags: [MINE] }));
    const if_updated_at = (await op.get(`/notes/${id}`)).body.updatedAt;
    const r = await writer.post(`/notes/${id}/restore`, { version_ix: hidden, if_updated_at });
    expect(r.status).toBe(404);
    expect(String((await op.get(`/notes/${id}`)).body.content)).not.toContain("hunter2");
  });

  pending("MCP: query-notes versions answers not found for the version saved under SECRET", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read", tags: [MINE] }));
    try {
      // A not-found may come back as a result carrying error_type or as a tool error; either is fine.
      const one = await c
        .call<any>("query-notes", { versions: { note_id: id, version_ix: hidden } })
        .catch((e: unknown) => ({ error_type: /not.?found/i.test(String(e)) ? "not_found" : String(e) }));
      expect(JSON.stringify(one)).not.toContain("hunter2");
      expect(one?.error_type).toBe("not_found");
      const list = JSON.stringify(await c.call<any>("query-notes", { versions: { note_id: id } }));
      expect([...list.matchAll(/"version_ix":(\d+)/g)].map((m) => Number(m[1]))).not.toContain(hidden);
    } finally {
      await c.close();
    }
  });

  test("today and after: the scoped reader reads the version saved under MINE; an unscoped reader reads both", async () => {
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    const mine = await reader.get(`/notes/${id}/versions/${shown}`);
    expect(mine.status).toBe(200);
    expect(mine.body.content).toBe(CLEAN);
    const all = (await versionsWith(rest(s.vaultViaHub, await pass({ level: "read" })))).map((v) => v.content);
    expect(all).toContain(OLD);
    expect(all).toContain(CLEAN);
  });
});
