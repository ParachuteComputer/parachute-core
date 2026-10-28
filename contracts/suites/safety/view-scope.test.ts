// Fix 5 (G1): a tag-scoped pass reads through `/view` only what it may read through the API.
//
// Before the fix (vault 42fbf93) `/view/<idOrPath>` asked only "is this a valid credential?" (src/routing.ts:217-226,
// isViewAuthenticated) and then rendered any note (src/routes.ts:4620-4643, handleViewNote), ignoring the pass's
// tags. Fixed by lane F in packages/vault (src/routing.ts, src/routes.ts handleViewNote); mutant "g1-view-unscoped" puts the bug back.
// PLAN §5 fix 5, §7.5.
import { beforeAll, describe, expect, test } from "bun:test";
import { enc, mcp, must, operator, rest, runId, services } from "../lib.ts";
import { note, pass, view } from "./_lib.ts";

const R = runId("view").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const SECRET = `zq${R}secretword`;
let scoped: string;
let inScope: string;
let outOfScope: string;

beforeAll(async () => {
  inScope = await note(`${R}/visible`, `a visible note ${R}`, [MINE]);
  outOfScope = await note(`${R}/hidden`, `a hidden note ${SECRET}`, [OTHER]);
  scoped = await pass({ level: "read", tags: [MINE] });
});

describe("/view honours a pass's tags (fix 5)", () => {
  test("setup works today: the scoped pass can't read the hidden note through the API", async () => {
    const api = rest(services().vaultViaHub, scoped);
    expect((await api.get(`/notes/${outOfScope}`)).status).toBe(404);
    expect((await api.get(`/notes/${inScope}`)).status).toBe(200);
  });

  test("a tag-scoped pass reads an in-scope note through /view (positive control)", async () => {
    const r = await view(scoped, inScope);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`a visible note ${R}`);
  });

  test("with no pass, /view shows neither note (neither is published)", async () => {
    expect((await view(null, inScope)).status).toBe(404);
    expect((await view(null, outOfScope)).status).toBe(404);
  });

  test("a tag-scoped pass can't read a note outside its tags through /view, by id or by path", async () => {
    for (const ref of [outOfScope, `${R}/hidden`]) {
      const r = await view(scoped, ref);
      must(!r.text.includes(SECRET), `/view rendered a note outside the pass's tags (${ref.includes("/") ? "by path" : "by id"}, status ${r.status})`);
      expect(r.status).toBe(404);
    }
  });
});

// Codex round 1: two notes may share a path when their extensions differ, and a path that matches several is
// "ambiguous" (409 with each candidate's id and extension). That answer must never name a note the caller can't
// read: among hidden notes only it reads as not found; with one visible candidate, the path resolves to it.
describe("an ambiguous path names only notes the caller may read", () => {
  const op = operator();
  let hiddenIds: string[] = [];
  let mixedVisible = "";
  let mixedHidden = "";

  /** Create a note at an explicit path and extension, as the operator. */
  async function at(path: string, extension: string, content: string, tags: string[]): Promise<string> {
    const r = await op.post("/notes", { content, path, extension, tags });
    if (r.status !== 201) throw new Error(`setup: creating ${path}.${extension} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.id as string;
  }

  beforeAll(async () => {
    hiddenIds = [await at(`${R}/twin`, "md", `hidden twin ${SECRET}`, [OTHER]), await at(`${R}/twin`, "txt", `hidden twin ${SECRET}`, [OTHER])];
    mixedVisible = await at(`${R}/pair`, "md", `the visible one ${R}`, [MINE]);
    mixedHidden = await at(`${R}/pair`, "txt", `the hidden one ${SECRET}`, [OTHER]);
  });

  test("setup works today: the operator gets 409 ambiguous_path for both paths", async () => {
    for (const path of [`${R}/twin`, `${R}/pair`]) {
      const r = await op.get(`/notes/${enc(path)}`);
      expect(r.status).toBe(409);
      expect(r.body.candidates.length).toBe(2);
    }
  });

  test("REST: a tag-scoped pass gets 404 for a path whose notes are all hidden, and the visible note for a mixed one", async () => {
    const api = rest(services().vaultViaHub, scoped);
    const twin = await api.get(`/notes/${enc(`${R}/twin`)}`);
    must(!hiddenIds.some((id) => JSON.stringify(twin.body).includes(id)), `REST named a hidden note of an ambiguous path (status ${twin.status})`);
    expect(twin.status).toBe(404);
    const pair = await api.get(`/notes/${enc(`${R}/pair`)}`);
    must(!JSON.stringify(pair.body).includes(mixedHidden), `REST named the hidden note of a mixed ambiguous path (status ${pair.status})`);
    expect(pair.status).toBe(200);
    expect(pair.body.id).toBe(mixedVisible);
  });

  test("/view: neither a scoped pass nor no pass learns a hidden note's id from an ambiguous path", async () => {
    for (const [who, token] of [["scoped pass", scoped], ["no pass", null]] as const) {
      const twin = await view(token, `${R}/twin`);
      must(!hiddenIds.some((id) => twin.text.includes(id)), `/view named a hidden note of an ambiguous path to ${who} (status ${twin.status})`);
      expect(twin.status).toBe(404);
    }
    const pair = await view(scoped, `${R}/pair`);
    must(!pair.text.includes(mixedHidden) && !pair.text.includes(SECRET), `/view named the hidden note of a mixed ambiguous path (status ${pair.status})`);
    expect(pair.status).toBe(200);
    expect(pair.text).toContain(`the visible one ${R}`);
  });

  test("MCP: find-path from an ambiguous hidden path discloses no hidden note", async () => {
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      const said = await c.call("find-path", { source: `${R}/twin`, target: inScope }).then(
        (r) => JSON.stringify(r),
        (e) => (e as Error).message,
      );
      // Neither the ids nor the fact that hidden notes share the path (the count and extensions in the message).
      must(!hiddenIds.some((id) => said.includes(id)) && !/ambiguous/i.test(said), `MCP find-path disclosed the hidden notes of an ambiguous path: ${said.slice(0, 300)}`);
    } finally {
      await c.close();
    }
  });
});

// Codex round 2: a hidden note must not change how a reference resolves at all. Not by an ambiguity error, not by
// making a visible note unreachable by path (MCP), and not by occupying a path so the visible title fallback never
// runs. Each case below has a visible note that a reference should reach, and hidden notes in its way.
describe("a hidden note changes nothing about how a reference resolves", () => {
  const op = operator();
  let pairVisible = "";
  const cases: { what: string; ref: string; visible: string }[] = [];

  async function at(path: string, extension: string, content: string, tags: string[]): Promise<string> {
    const r = await op.post("/notes", { content, path, extension, tags });
    if (r.status !== 201) throw new Error(`setup: creating ${path}.${extension} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.id as string;
  }

  beforeAll(async () => {
    // A path with one visible and one hidden note: the visible one, by path, on MCP as on REST.
    pairVisible = await at(`${R}/mcp-pair`, "md", `the visible one ${R}`, [MINE]);
    await at(`${R}/mcp-pair`, "txt", `the hidden one ${SECRET}`, [OTHER]);
    // A reference that names a hidden note's path (one note, two notes, or with its extension), where a visible
    // note carries that reference as its title: the title fallback must find the visible note.
    for (const [what, ref, hidden] of [
      ["a hidden note at that path", `${R}/shadow-one`, [["md"]]],
      ["two hidden notes at that path", `${R}/shadow-two`, [["md"], ["txt"]]],
      ["a hidden note at that path and extension", `${R}/shadow-ext.md`, [["md", `${R}/shadow-ext`]]],
    ] as const) {
      for (const [ext, path] of hidden as readonly (readonly string[])[]) await at(path ?? ref, ext!, `hidden ${SECRET}`, [OTHER]);
      const visible = await at(`${R}/titled-${cases.length}`, "md", `# ${ref}\nthe visible note titled ${ref}`, [MINE]);
      cases.push({ what, ref, visible });
    }
  });

  test("MCP: a path shared by a visible and a hidden note resolves to the visible one (query-notes, find-path)", async () => {
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      const got = await c.call("query-notes", { id: `${R}/mcp-pair` }).then((r) => r, (e) => ({ error: (e as Error).message }));
      must(got?.id === pairVisible, `MCP query-notes by a path shared with a hidden note didn't return the visible note: ${JSON.stringify(got).slice(0, 300)}`);
      const path = await c.call("find-path", { source: `${R}/mcp-pair`, target: pairVisible }).then((r) => JSON.stringify(r), (e) => (e as Error).message);
      must(!/ambiguous|not.found/i.test(path), `MCP find-path from a path shared with a hidden note failed: ${path.slice(0, 300)}`);
    } finally {
      await c.close();
    }
  });

  test("MCP history reaches a visible note by id and by its title when nothing hidden is in the way (positive control)", async () => {
    const op2 = operator();
    const ref = `${R}/clear-title`;
    const r = await op2.post("/notes", { content: `# ${ref}\nvisible, no collision`, path: `${R}/clear-titled`, tags: [MINE] });
    expect(r.status).toBe(201);
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      for (const id of [inScope, ref]) {
        const h = await c.call("query-notes", { versions: { note_id: id } });
        expect(Array.isArray(h?.versions)).toBe(true);
      }
    } finally {
      await c.close();
    }
  });

  test("REST, /view and MCP (notes and history): a hidden note at a path doesn't block the visible note titled with it", async () => {
    const api = rest(services().vaultViaHub, scoped);
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      for (const { what, ref, visible } of cases) {
        const r = await api.get(`/notes/${enc(ref)}`);
        must(r.status === 200 && r.body?.id === visible, `REST: ${what} blocked the visible note titled "${ref}" (status ${r.status})`);
        const v = await view(scoped, ref);
        must(v.status === 200 && v.text.includes(`the visible note titled ${ref}`), `/view: ${what} blocked the visible note titled "${ref}" (status ${v.status})`);
        const q = await c.call("query-notes", { id: ref }).then((x) => x, (e) => ({ error: (e as Error).message }));
        must(q?.id === visible, `MCP: ${what} blocked the visible note titled "${ref}": ${JSON.stringify(q).slice(0, 200)}`);
        const h = await c.call("query-notes", { versions: { note_id: ref } }).then((x) => x, (e) => ({ error: (e as Error).message }));
        must(h && !h.error && Array.isArray(h.versions), `MCP history: ${what} blocked the visible note titled "${ref}": ${JSON.stringify(h).slice(0, 200)}`);
      }
    } finally {
      await c.close();
    }
  });
});

// Codex round 4: MCP history must give one answer to a reference that matches nothing and to one that matches only
// hidden notes. The oracle is the complete response (result or error, with the reference masked), before and after
// hidden notes appear at that id, path, path.ext or title.
describe("MCP history answers a hidden match exactly as it answers no match", () => {
  const op = operator();
  const MISSING_ID = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";

  async function history(ref: string): Promise<string> {
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      const said = await c.call("query-notes", { versions: { note_id: ref } }).then((r) => ({ result: r }), (e) => ({ thrown: (e as Error).message }));
      return JSON.stringify(said).split(ref).join("<ref>");
    } finally {
      await c.close();
    }
  }

  test("by id, path, path.ext and title", async () => {
    const refs = { path: `${R}/hist-path`, ext: `${R}/hist-ext.md`, title: `${R}/hist-title` };
    const before: Record<string, string> = { id: await history(MISSING_ID) };
    for (const [k, ref] of Object.entries(refs)) before[k] = await history(ref);
    const at = (path: string, extension: string, content: string) => op.post("/notes", { content, path, extension, tags: [OTHER] });
    const hiddenId = (await at(`${R}/hist-id`, "md", `hidden ${SECRET}`)).body.id as string;
    await at(refs.path, "md", `hidden ${SECRET}`);
    await at(`${R}/hist-ext`, "md", `hidden ${SECRET}`);
    await at(`${R}/hist-title-note`, "md", `# ${refs.title}\nhidden ${SECRET}`);
    const after: Record<string, string> = { id: await history(hiddenId) };
    for (const [k, ref] of Object.entries(refs)) after[k] = await history(ref);
    for (const k of Object.keys(before)) {
      must(before[k] === after[k], `MCP history told a hidden ${k} match from no match: ${before[k]!.slice(0, 160)} → ${after[k]!.slice(0, 160)}`);
    }
  });
});

// Codex round 6: paths compare case-insensitively, so `x.md` also matches a hidden `X.md`. With the extension given,
// every candidate is filtered before one is chosen, whichever note was created first.
describe("a hidden note at a case-variant path doesn't hide the visible note at path.ext", () => {
  const op = operator();
  const cases: { order: string; ref: string; visible: string }[] = [];
  async function at(path: string, content: string, tags: string[]): Promise<string> {
    const r = await op.post("/notes", { content, path, extension: "md", tags });
    if (r.status !== 201) throw new Error(`setup: creating ${path}.md gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.id as string;
  }
  beforeAll(async () => {
    await at(`${R}/CaseA`, `hidden ${SECRET}`, [OTHER]);
    cases.push({ order: "hidden first", ref: `${R}/casea.md`, visible: await at(`${R}/casea`, `visible case a ${R}`, [MINE]) });
    const v = await at(`${R}/caseb`, `visible case b ${R}`, [MINE]);
    await at(`${R}/CaseB`, `hidden ${SECRET}`, [OTHER]);
    cases.push({ order: "visible first", ref: `${R}/caseb.md`, visible: v });
  });

  test("REST, /view and MCP (notes and history) reach the visible note, in either creation order", async () => {
    const api = rest(services().vaultViaHub, scoped);
    const c = await mcp(`${services().vaultViaHub}/mcp`, scoped);
    try {
      for (const { order, ref, visible } of cases) {
        const r = await api.get(`/notes/${enc(ref)}`);
        must(r.status === 200 && r.body?.id === visible, `REST (${order}): a hidden case-variant note hid the visible ${ref} (status ${r.status})`);
        const v = await view(scoped, ref);
        must(v.status === 200 && !v.text.includes(SECRET), `/view (${order}): a hidden case-variant note hid the visible ${ref} (status ${v.status})`);
        const q = await c.call("query-notes", { id: ref }).then((x) => x, (e) => ({ error: (e as Error).message }));
        must(q?.id === visible, `MCP (${order}): a hidden case-variant note hid the visible ${ref}: ${JSON.stringify(q).slice(0, 200)}`);
        const h = await c.call("query-notes", { versions: { note_id: ref } }).then((x) => x, (e) => ({ error: (e as Error).message }));
        must(h && !h.error && Array.isArray(h.versions), `MCP history (${order}): a hidden case-variant note hid the visible ${ref}: ${JSON.stringify(h).slice(0, 200)}`);
      }
    } finally {
      await c.close();
    }
  });
});
