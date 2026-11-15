// 1.0 grants: a narrow grant learns nothing of what it can't read (docs/SPEC-1.0-grants.md §4.1, the table). A
// grantee reads type A only; the owner also keeps records of a hidden type B. Through search, links and backlinks,
// find-path, the type list and its counts, the vault's stats, history, files, the names in stamps, and a lookup by
// path, B is as if it didn't exist: hidden answers the same as missing. A link the grantee writes to a hidden
// record's path reads as a link to nothing. The export, which would hold B whole, is refused (§4.4).
//
// History follows the types a version had then, and the denied tags it carried then (the rule of
// v1/history-scope.test.ts, moved from tags to types). Versions with no recorded types (before 0.9.4) aren't
// contracted: a black box can't make one.
// The live socket is out of scope here: the door harness has no socket client yet (§12).
//
// Red today: no door takes a signed statement, so each contract stops where `granted()` files one. Every body
// starts with a grant that must be taken, so "learns nothing" can't pass because nothing is ever taken. The owner's
// side of the world is made once, before any grant, and the plain test below checks it reads back today.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { LANE, NO_GRANTS, declareType, enc, file, granted, ids, linkEvent, newKey, records, red, runId, tokenAs } from "./_grants.ts";
import { lacks } from "../door/_door.ts";

const owner = records("write");

interface World {
  A: string;
  B: string;
  /** A word that appears only in a B record. */
  word: string;
  /** A word that appears only in a version saved while its record was B. */
  oldWord: string;
  a1: string;
  a2: string;
  b1: string;
  b1Path: string;
  /** Typed A now, B before: `hiddenIx` is a version saved under B, `shownIx` one saved under A. */
  moved: string;
  hiddenIx: number;
  shownIx: number;
  /** A file attached to b1. */
  filePath: string;
}

async function made(r: Promise<{ status: number; body: any; text: string }>, what: string): Promise<any> {
  const x = await r;
  if (x.status !== 200 && x.status !== 201) throw new Error(`setup: ${what} gave ${x.status} ${x.text.slice(0, 200)}`);
  return x.body;
}

const versionsOf = async (who: ReturnType<typeof records>, id: string) => who.call("GET", `/notes/${enc(id)}/versions?limit=50`);

let world: Promise<World> | null = null;
/** The owner's side, made once per file: A and B records, links across them, a moved record's history, a file. */
function theWorld(): Promise<World> {
  world ??= (async () => {
    const [A, B] = [await declareType("seen"), await declareType("hidden")];
    const word = `zq${runId("w")}`;
    const oldWord = `zq${runId("w")}`;
    const a1 = (await made(owner.make({ types: [A], body: "a plain soup" }), "a1")).id;
    const a2 = (await made(owner.make({ types: [A], body: "a plain stew" }), "a2")).id;
    const b1Path = `${runId("leaks")}/${runId("diary")}`;
    const b1 = (await made(owner.make({ types: [B], path: b1Path, body: `the ${word} lives here` }), "b1")).id;
    // a1 → b1 → a2, and b1 → a1: a link out to B, a backlink from B, and a path that crosses B.
    await made(owner.call("PATCH", `/notes/${a1}`, { links: { add: [{ target: b1, relationship: "mentions" }] }, force: true }), "link a1 → b1");
    await made(owner.call("PATCH", `/notes/${b1}`, { links: { add: [{ target: a2, relationship: "mentions" }, { target: a1, relationship: "answers" }] }, force: true }), "links from b1");
    // Written under B, then moved into A and cleaned, then edited again under A.
    const moved = (await made(owner.make({ types: [B], body: `draft with the ${oldWord} in it` }), "moved")).id;
    await made(owner.edit(moved, { body: "cleaned, nothing to see", add: [A], remove: [B] }), "moving the record into A");
    await made(owner.edit(moved, { body: "second edit, still in A" }), "a second edit");
    const list = (await made(versionsOf(owner, moved), "versions")).versions as { version_ix: number }[];
    const content = async (ix: number) => String((await owner.call("GET", `/notes/${moved}/versions/${ix}`)).body?.content ?? "");
    let hiddenIx = -1;
    let shownIx = -1;
    for (const v of list) {
      const c = await content(v.version_ix);
      if (c.includes(oldWord)) hiddenIx = v.version_ix;
      if (c === "cleaned, nothing to see") shownIx = v.version_ix;
    }
    // A file on b1.
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(256)]) as unknown as BlobPart], "diary.png", { type: "image/png" }));
    const filePath = (await made(owner.call("POST", "/storage/upload", form), "upload")).path;
    await made(owner.call("POST", `/notes/${b1}/attachments`, { path: filePath, mimeType: "image/png" }), "attach to b1");
    return { A, B, word, oldWord, a1, a2, b1, b1Path, moved, hiddenIx, shownIx, filePath };
  })();
  return world;
}

/** A record of a type C that carried a tag in its first version and lost it in its second; made fresh per call. */
async function markedHistory() {
  const C = await declareType("marked");
  const secret = runId("private");
  const markWord = `zq${runId("w")}`;
  const id = (await made(owner.make({ types: [C], tags: [secret], body: `marked, with the ${markWord}` }), "marked")).id;
  await made(owner.edit(id, { body: "unmarked, nothing to see", remove: [secret] }), "unmarking");
  await made(owner.edit(id, { body: "edited again, unmarked" }), "a second edit");
  const list = (await made(versionsOf(owner, id), "versions")).versions as { version_ix: number }[];
  let markedIx = -1;
  let cleanIx = -1;
  for (const v of list) {
    const c = String((await owner.call("GET", `/notes/${id}/versions/${v.version_ix}`)).body?.content ?? "");
    if (c.includes(markWord)) markedIx = v.version_ix;
    if (c === "unmarked, nothing to see") cleanIx = v.version_ix;
  }
  return { C, secret, markWord, id, markedIx, cleanIx };
}

/** A grantee that reads A, and nothing else. */
async function readsA(w: World) {
  const key = await newKey();
  await granted({ to: key, types: { [w.A]: ["read"] } });
  return records({ bearer: await tokenAs(key) });
}

const tagNames = (body: any): string[] => (Array.isArray(body) ? body : (body?.tags ?? [])).map((t: any) => t.name);

describe("setup holds today", () => {
  test("the owner finds B by search, follows links across it, reads its history and its file, and looks it up by path", async () => {
    const w = await theWorld();
    expect(ids(await owner.list({ search: w.word }))).toEqual([w.b1]);
    const a1 = await owner.call("GET", `/notes/${w.a1}?include_links=true&include_link_count=true`);
    expect(JSON.stringify(a1.body.links)).toContain(w.b1);
    expect(a1.body.linkCount).toBeGreaterThanOrEqual(2);
    const path = await owner.call("GET", `/find-path?source=${w.a1}&target=${w.a2}&direction=outbound`);
    expect(path.status).toBe(200);
    expect(JSON.stringify(path.body)).toContain(w.b1);
    expect(w.hiddenIx).toBeGreaterThanOrEqual(0);
    expect(w.shownIx).toBeGreaterThanOrEqual(0);
    const types = await owner.types();
    expect(types.status).toBe(200);
    expect(tagNames(types.body)).toContain(w.B);
    expect((await owner.call("GET", `/tags?tag=${enc(w.B)}`)).status).toBe(200);
    const stats = await owner.call("GET", "/vault?include_stats=true");
    expect(typeof stats.body.stats.totalNotes).toBe("number");
    const att = await owner.call("GET", `/notes/${w.b1}/attachments`);
    expect(att.status).toBe(200);
    expect(JSON.stringify(att.body)).toContain(w.filePath);
    expect((await owner.call("GET", `/storage/${w.filePath}`)).status).toBe(200);
    expect((await owner.get(w.b1Path)).status).toBe(200);
    expect((await owner.get(`${w.b1Path}-missing`)).status).toBe(404);
    // A [[wikilink]] to b1's path finds b1, for the owner.
    const linking = await made(owner.make({ body: `see [[${w.b1Path}]]` }), "a wikilink to b1");
    expect(JSON.stringify((await owner.call("GET", `/notes/${linking.id}?include_links=true`)).body.links ?? [])).toContain(w.b1);
  });

  test("the owner can mark a record, unmark it, and find the marked version in its history", async () => {
    const h = await markedHistory();
    expect(h.markedIx).toBeGreaterThanOrEqual(0);
    expect(h.cleanIx).toBeGreaterThanOrEqual(0);
  });
});

describe("a grant that reads A learns nothing of B", () => {
  red("search: a word only a B record holds finds nothing", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    const hit = await bo.list({ search: w.word });
    expect(hit.status).toBe(200);
    expect(ids(hit)).toEqual([]);
    expect(ids(await bo.list())).toEqual([w.a1, w.a2, w.moved].sort());
  });

  red("links: a link to a B record, and a backlink from one, read as nothing; a path never crosses B", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    for (const id of [w.a1, w.a2]) {
      const r = await bo.call("GET", `/notes/${id}?include_links=true&include_link_count=true`);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(w.b1);
      expect(JSON.stringify(r.body)).not.toContain(w.b1Path);
      // a1's and a2's only links run to or from b1.
      expect(r.body.links ?? []).toEqual([]);
      expect(r.body.linkCount).toBe(0);
    }
    // The owner's answer when there is no path, and the grantee's answer across B, are the same answer.
    const none = await owner.call("GET", `/find-path?source=${w.a2}&target=${w.a1}&direction=outbound`);
    const across = await bo.call("GET", `/find-path?source=${w.a1}&target=${w.a2}&direction=outbound`);
    expect(JSON.stringify(across.body)).not.toContain(w.b1);
    expect(across.status).toBe(none.status);
    expect(across.body).toEqual(none.body);
    // From the hidden record itself: as missing.
    const fromHidden = await bo.call("GET", `/find-path?source=${w.b1}&target=${w.a1}`);
    const fromMissing = await bo.call("GET", `/find-path?source=${w.b1}x&target=${w.a1}`);
    expect(fromHidden.status).toBe(fromMissing.status);
    expect(fromHidden.text).not.toContain(w.b1Path);
  });

  red("types and counts: B isn't listed, and every count counts visible records only", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    const types = await bo.types();
    expect(types.status).toBe(200);
    expect(JSON.stringify(types.body)).not.toContain(w.B);
    expect(tagNames(types.body)).toEqual([w.A]);
    const a = (Array.isArray(types.body) ? types.body : types.body.tags).find((t: any) => t.name === w.A);
    expect(a.count).toBe(3);
    // Asked for by name, B is a type that doesn't exist.
    const named = await bo.call("GET", `/tags?tag=${enc(w.B)}`);
    const missing = await bo.call("GET", `/tags?tag=${enc(`${w.B}-missing`)}`);
    expect(named.status).toBe(404);
    expect({ ...named.body, tag: null }).toEqual({ ...missing.body, tag: null });
    const stats = await bo.call("GET", "/vault?include_stats=true");
    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalNotes).toBe(3);
    expect(JSON.stringify(stats.body)).not.toContain(w.B);
  });

  red("history: the versions a record had while it was B are neither listed nor readable", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    expect((await bo.get(w.moved)).status).toBe(200);
    const list = await versionsOf(bo, w.moved);
    expect(list.status).toBe(200);
    const listed = (list.body.versions as { version_ix: number }[]).map((v) => v.version_ix);
    expect(listed).not.toContain(w.hiddenIx);
    expect(listed).toContain(w.shownIx);
    expect(list.body.total).toBe(listed.length);
    const one = await bo.call("GET", `/notes/${w.moved}/versions/${w.hiddenIx}`);
    expect(one.status).toBe(404);
    expect(JSON.stringify(one.body)).not.toContain(w.oldWord);
    expect(JSON.stringify(list.body)).not.toContain(w.oldWord);
  });

  red("history: a version that carried a denied tag then is hidden, though the record carries it no longer", { reason: NO_GRANTS, lane: LANE }, async () => {
    const h = await markedHistory();
    const key = await newKey();
    await granted({ to: key, types: { [h.C]: ["read"] }, deny: [h.secret] });
    const bo = records({ bearer: await tokenAs(key) });
    // The record is visible now: it is of a granted type and carries no denied tag.
    expect((await bo.get(h.id)).status).toBe(200);
    const list = await versionsOf(bo, h.id);
    expect(list.status).toBe(200);
    const listed = (list.body.versions as { version_ix: number }[]).map((v) => v.version_ix);
    expect(listed).not.toContain(h.markedIx);
    expect(listed).toContain(h.cleanIx);
    expect(list.body.total).toBe(listed.length);
    const one = await bo.call("GET", `/notes/${h.id}/versions/${h.markedIx}`);
    expect(one.status).toBe(404);
    expect(JSON.stringify(one.body)).not.toContain(h.markWord);
    expect(JSON.stringify(list.body)).not.toContain(h.markWord);
    expect(JSON.stringify(list.body)).not.toContain(h.secret);
  });

  red("files: a file on a B record can't be fetched by its path or found by listing attachments", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    const got = await bo.call("GET", `/storage/${w.filePath}`);
    const missing = await bo.call("GET", `/storage/2001-01-01/${runId("no")}.png`);
    expect(got.status).toBe(404);
    expect(got.status).toBe(missing.status);
    expect((await bo.call("GET", `/notes/${w.b1}/attachments`)).status).toBe(404);
    const withFiles = await bo.call("GET", `/notes/${w.b1}?include_attachments=true`);
    expect(withFiles.status).toBe(404);
    expect(withFiles.text).not.toContain(w.filePath);
  });

  red("a lookup by a hidden record's id or path answers exactly as a missing one does, and the export isn't the grantee's to take", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    const bo = await readsA(w);
    const answer = async (idOrPath: string) => {
      const r = await bo.get(idOrPath);
      return { status: r.status, error: r.body?.error ?? null, error_type: r.body?.error_type ?? null };
    };
    const missing = await answer(`${w.b1Path}-missing`);
    expect(missing.status).toBe(404);
    expect(await answer(w.b1Path)).toEqual(missing);
    expect(await answer(w.b1)).toEqual(await answer(`${w.b1}x`));
    // The export would hand over B whole: export is never granted (§4.4). Only where the door exports over HTTP.
    if (!lacks("export-over-http")) expect((await bo.call("GET", "/export")).status).toBe(403);
  });

  red("a link the grantee writes to a hidden record's path is taken, and reads back as a link to a name that doesn't exist", { reason: NO_GRANTS, lane: LANE }, async () => {
    const w = await theWorld();
    // Its own type, so the world's counts stay as they are.
    const C = await declareType("notes");
    const missingPath = `${w.b1Path}-missing`;
    const key = await newKey();
    await granted({ to: key, types: { [C]: ["read", "create"] } });
    const bo = records({ bearer: await tokenAs(key) });
    const toHidden = await bo.make({ types: [C], body: `see [[${w.b1Path}]]` });
    const toMissing = await bo.make({ types: [C], body: `see [[${missingPath}]]` });
    expect(toHidden.status, toHidden.text.slice(0, 200)).toBe(201);
    expect(toMissing.status).toBe(201);
    // The write's answer, and the record read back, are the missing name's with the name swapped.
    const same = (x: unknown, name: string) => JSON.stringify(x ?? null).replaceAll(name, "<name>");
    expect(same(toHidden.body.warnings, w.b1Path)).toBe(same(toMissing.body.warnings, missingPath));
    const back = async (id: string) => (await bo.call("GET", `/notes/${id}?include_links=true&include_link_count=true`)).body;
    const [hidden, missing] = [await back(toHidden.body.id), await back(toMissing.body.id)];
    expect(JSON.stringify(hidden)).not.toContain(w.b1);
    expect(hidden.links ?? []).toEqual([]);
    expect(same(hidden.links, w.b1Path)).toBe(same(missing.links, missingPath));
    expect(hidden.linkCount).toBe(missing.linkCount);
  });

  red("names in stamps: only names on records the grant can see, and none for a grant that can't read", { reason: NO_GRANTS, lane: LANE }, async () => {
    // Its own two types, so the world's counts stay as they are: C is read, D is hidden.
    const [C, D] = [await declareType("visits"), await declareType("intake")];
    const prefix = `${runId("portal")}.example`;
    const [shown, kept] = [runId("client"), runId("client")];
    const [person1, person2] = [await newKey(), await newKey()];
    // A service that writes for its clients: create on every record, with no read, so the vault picks the paths.
    const service = await newKey();
    await granted({ to: service, by: { names: prefix }, types: { "*": ["create"] } });
    const S = records({ bearer: await tokenAs(service) });
    expect((await S.make({ types: [C], body: "a visit", path: null, onBehalfOf: shown })).status).toBe(201);
    expect((await S.make({ types: [D], body: "an intake form", path: null, onBehalfOf: kept })).status).toBe(201);
    for (const [name, person] of [[shown, person1], [kept, person2]] as const) {
      const r = await file(await linkEvent(service, `${prefix}:${name}`, person));
      expect(r.status, r.text.slice(0, 200)).toBe(201);
    }
    // A grantee that reads C sees the name on C's record, and nothing of the name only D's record carries.
    const reader = await newKey();
    await granted({ to: reader, types: { [C]: ["read"] } });
    const seen = await records({ bearer: await tokenAs(reader) }).stamps();
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.stamps)).toContain(shown);
    expect(JSON.stringify(seen.stamps)).not.toContain(kept);
    expect(JSON.stringify(seen.stamps)).not.toContain(person2.pubkey);
    // A grantee that creates C and reads nothing gets no names at all: an answer (200), with an empty list.
    const form = await newKey();
    await granted({ to: form, types: { [C]: ["create"] } });
    const none = await records({ bearer: await tokenAs(form) }).call("GET", "/stamps");
    expect(none.status, none.text.slice(0, 200)).toBe(200);
    expect(none.body).toEqual({ stamps: [] });
  });
});
