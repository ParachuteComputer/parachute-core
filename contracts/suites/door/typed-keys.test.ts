// 1.0 grants, first slice: a key for an AI that reaches some types of a vault (docs/SPEC-1.0-grants.md §7.3, a grant
// nobody signed: the door's word that the signed-in owner agreed). The owner makes a key named `claude` that may read
// and add `recipe` records, and nothing else. The vault keeps that grant and checks every request against it: the key
// adds and reads recipes, and of a `journal` record it gets nothing, by id, path, search, links, counts or history, at
// the REST door and the MCP door alike. The list of who reaches the vault names it, and ending it there fails its
// very next request.
//
// The wire (a proposal, spec §7.1 and §7.3; [lean]): `POST /account/keys` takes `types` beside `can`; the token
// carries only the grant's id (`permissions.grant`, open decision I) and the vault reads the rules from its own row;
// `GET /account/vaults/<v>/statements` lists every credential as a grant row; `DELETE …/statements/<id>` ends a door
// grant. A vault's own admin credential may do all three for that vault, which is how the app's Sharing screen does it.
//
// Written red first in suites/door-v1 (a box refused `types` with 400 and a vault admin credential with 403), and
// moved here by the change that made them pass. A door without typed keys names that in deliberate.json (`typed-keys`).
import { describe, expect, test } from "bun:test";
import { declareType, ids, must, records, statements } from "../door-v1/_grants.ts";
import { accountToken, door, enc, lacks, mcp, runId, safeFetch, token, type Reply } from "./_door.ts";

const without = lacks("typed-keys");
const owner = records("write");

async function reply(r: Response): Promise<Reply> {
  const text = await r.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body, headers: r.headers, text };
}

type As = "owner" | "vault-admin";
const bearer = async (as: As, vault = door().vault) => `Bearer ${as === "owner" ? await accountToken() : await token("admin", vault)}`;
const account = async (method: string, path: string, body?: unknown, as: As = "owner", vault?: string) =>
  reply(await safeFetch(`${door().issuer}${path}`, { method, headers: { authorization: await bearer(as, vault), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));

/** Make a key that reaches only `types`; throws in NO_TYPED_KEYS's words when the door won't. */
async function typedKey(types: string[], can: "read" | "write" = "write", as: As = "owner"): Promise<{ name: string; token: string; body: any }> {
  const name = `claude-${runId("k")}`;
  const r = await account("POST", "/account/keys", { name, vault: door().vault, can, types }, as);
  must(r.status === 201, `no typed keys at this door: POST /account/keys answered ${r.status} ${r.text.slice(0, 160)}`);
  return { name, token: r.body.token, body: r.body };
}

const list = (as: As = "owner", vault = door().vault) => account("GET", `/account/vaults/${enc(vault)}/statements`, undefined, as, vault);
const end = (id: string, as: As = "owner") => account("DELETE", `/account/vaults/${enc(door().vault)}/statements/${enc(id)}`, undefined, as);

interface World {
  R: string;
  J: string;
  word: string;
  r1: string;
  j1: string;
  j1Path: string;
}
let world: Promise<World> | null = null;
/** The owner's vault: a recipe that links to a journal entry, a journal entry that links back, and history on both. */
function theWorld(): Promise<World> {
  world ??= (async () => {
    const [R, J] = [await declareType("recipe"), await declareType("journal")];
    const word = `zq${runId("w")}`;
    const j1Path = `${runId("typed")}/${runId("diary")}`;
    const ok = (x: Reply, what: string) => {
      if (x.status !== 200 && x.status !== 201) throw new Error(`setup: ${what} gave ${x.status} ${x.text.slice(0, 200)}`);
      return x.body;
    };
    const j1 = ok(await owner.make({ types: [J], path: j1Path, body: `a private ${word} entry` }), "j1").id;
    ok(await owner.edit(j1, { body: `a private ${word} entry, edited` }), "j1 edited");
    const r1 = ok(await owner.make({ types: [R], body: `soup, as in [[${j1Path}]]` }), "r1").id;
    ok(await owner.edit(r1, { body: `soup, again, as in [[${j1Path}]]` }), "r1 edited");
    ok(await owner.call("PATCH", `/notes/${j1}`, { links: { add: [{ target: r1, relationship: "mentions" }] }, force: true }), "j1 → r1");
    return { R, J, word, r1, j1, j1Path };
  })();
  return world;
}

describe.skipIf(without)("setup holds today", () => {
  test("the owner reads the journal entry by id, path and search, its history, and the links between it and the recipe", async () => {
    const w = await theWorld();
    expect((await owner.get(w.j1)).status).toBe(200);
    expect((await owner.get(w.j1Path)).status).toBe(200);
    expect(ids(await owner.list({ search: w.word }))).toEqual([w.j1]);
    expect(JSON.stringify((await owner.call("GET", `/notes/${w.r1}?include_links=true`)).body.links)).toContain(w.j1);
    const versions = await owner.call("GET", `/notes/${w.j1}/versions?limit=50`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.length).toBeGreaterThan(0);
  });

  test("a key without types is still made, and reaches the whole vault", async () => {
    const name = `whole-${runId("k")}`;
    const r = await account("POST", "/account/keys", { name, vault: door().vault, can: "read" });
    expect(r.status).toBe(201);
    expect(r.body.types).toBeUndefined();
    const w = await theWorld();
    expect((await records({ bearer: r.body.token }).get(w.j1)).status).toBe(200);
  });
});

describe.skipIf(without)("a key for an AI that reads and adds recipes", () => {
  test("at the REST door it adds and reads recipes, and the journal is as if it didn't exist", async () => {
    const w = await theWorld();
    const key = await typedKey([w.R]);
    expect(key.body.types).toEqual([w.R]);
    const ai = records({ bearer: key.token });

    const made = await ai.make({ types: [w.R], body: "bread" });
    expect(made.status, made.text.slice(0, 200)).toBe(201);
    expect((await ai.get(made.body.id)).status).toBe(200);
    expect((await ai.get(w.r1)).status).toBe(200);
    expect(ids(await ai.list({ type: w.R }))).toEqual([w.r1, made.body.id].sort());

    // A journal record by id or path answers as a missing one does.
    const missing = await ai.get(`${w.j1}x`);
    expect(missing.status).toBe(404);
    expect((await ai.get(w.j1)).status).toBe(404);
    expect((await ai.get(w.j1Path)).status).toBe(404);
    expect((await ai.get(w.j1)).text.replaceAll(w.j1, "<id>")).toBe(missing.text.replaceAll(`${w.j1}x`, "<id>"));
    // Search, the full list, links both ways, counts and the type list.
    expect(ids(await ai.list({ search: w.word }))).toEqual([]);
    expect(ids(await ai.list())).toEqual([w.r1, made.body.id].sort());
    const r1 = await ai.call("GET", `/notes/${w.r1}?include_links=true&include_link_count=true`);
    expect(r1.status).toBe(200);
    expect(JSON.stringify(r1.body.links ?? [])).not.toContain(w.j1);
    expect(r1.body.linkCount).toBe(0);
    const types = await ai.types();
    expect(types.status).toBe(200);
    expect(JSON.stringify(types.body)).not.toContain(w.J);
    const stats = await ai.call("GET", "/vault?include_stats=true");
    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalNotes).toBe(2);
    // History: the journal record's versions are a record that doesn't exist.
    expect((await ai.call("GET", `/notes/${w.j1}/versions?limit=50`)).status).toBe(404);
    expect((await ai.call("GET", `/notes/${w.r1}/versions?limit=50`)).status).toBe(200);
    // A record written as a journal entry and later moved into recipes: its journal-era versions stay hidden (§4.1,
    // history follows the types a version had then).
    const oldWord = `zq${runId("w")}`;
    const moved = (await owner.make({ types: [w.J], body: `a draft with the ${oldWord}` })).body.id;
    expect((await owner.edit(moved, { body: "a recipe now", add: [w.R], remove: [w.J] })).status).toBe(200);
    expect((await ai.get(moved)).status).toBe(200);
    const mv = await ai.call("GET", `/notes/${moved}/versions?limit=50`);
    expect(mv.status).toBe(200);
    expect(JSON.stringify(mv.body)).not.toContain(oldWord);
    for (const v of mv.body.versions as { version_ix: number }[]) {
      expect((await ai.call("GET", `/notes/${moved}/versions/${v.version_ix}`)).text).not.toContain(oldWord);
    }
    // It can't write a journal record, nor change or delete one it can't see.
    expect((await ai.make({ types: [w.J], body: "not mine to write" })).status).toBe(403);
    // A record of both types needs create on both (§4.2).
    expect((await ai.make({ types: [w.R, w.J], body: "half mine" })).status).toBe(403);
    expect((await ai.edit(w.j1, { body: "overwritten" })).status).toBe(404);
    expect((await ai.remove(w.j1)).status).toBe(404);
    // Nor slip a journal type onto a recipe.
    expect((await ai.edit(made.body.id, { add: [w.J] })).status).toBe(403);
    // And the owner's journal is as it was.
    expect((await owner.get(w.j1)).body.content).toContain(w.word);
  });

  test("at the MCP door the same: the journal isn't found by search, by id or in the type list", async () => {
    const w = await theWorld();
    const key = await typedKey([w.R]);
    const c = await mcp("read", { bearer: key.token });
    try {
      const found = await c.call<any>("query-notes", { search: w.word });
      expect(JSON.stringify(found)).not.toContain(w.j1);
      const byId = await c.call<any>("query-notes", { id: w.j1 }).catch((e: Error) => ({ error: e.message }));
      expect(JSON.stringify(byId)).not.toContain(w.word);
      // History: no version of a record it can see whose types weren't recorded (none record them yet).
      const hist = await c.call<any>("query-notes", { versions: { note_id: w.r1 } });
      expect(hist.versions ?? []).toEqual([]);
      const hidden = await c.call<any>("query-notes", { versions: { note_id: w.j1 } }).catch((e: Error) => ({ error: e.message }));
      expect(JSON.stringify(hidden)).not.toContain(w.word);
      const tags = await c.call<any>("list-tags", {});
      expect(JSON.stringify(tags)).not.toContain(w.J);
      expect(JSON.stringify(tags)).toContain(w.R);
      const made = await c.call<any>("create-note", { content: "made over MCP", tags: [w.R], path: `${runId("typed")}/${runId("mcp")}` });
      expect(made.id ?? made.note?.id).toBeString();
      // Refused, as a tool error or as an answer that says so (the vault's MCP refuses a tag-limited write in-band).
      const journalPath = `${runId("typed")}/${runId("mcp")}`;
      const refused = await c.call<any>("create-note", { content: "a journal entry", tags: [w.J], path: journalPath }).then((r) => (r?.error ? String(r.error) : "made"), (e: Error) => e.message);
      expect(refused).not.toBe("made");
      expect((await owner.get(journalPath)).status).toBe(404);
    } finally {
      await c.close();
    }
  });

  test("a key that only reads recipes can't add one", async () => {
    const w = await theWorld();
    const key = await typedKey([w.R], "read");
    const ai = records({ bearer: key.token });
    expect((await ai.get(w.r1)).status).toBe(200);
    expect((await ai.make({ types: [w.R], body: "not allowed" })).status).toBe(403);
  });
});

describe.skipIf(without)("who reaches the vault, and ending it", () => {
  test("the list names the key, what it may do, to which types, and when it ends", async () => {
    const w = await theWorld();
    const key = await typedKey([w.R]);
    const r = await list();
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const row = r.body.grants.find((x: any) => x.id === key.name);
    expect(row).toMatchObject({ id: key.name, origin: "door", state: "in_force", by: "signer", deny: [], event: null });
    expect(row.types).toEqual({ [w.R]: ["read", "create", "update", "delete"] });
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    // A read-only key reads as read alone.
    const reader = await typedKey([w.R], "read");
    const again = await list();
    expect(again.body.grants.find((x: any) => x.id === reader.name).types).toEqual({ [w.R]: ["read"] });
  });

  test("ending it in the list fails its next request, at REST and at MCP, and the row says so", async () => {
    const w = await theWorld();
    const key = await typedKey([w.R]);
    const ai = records({ bearer: key.token });
    expect((await ai.get(w.r1)).status).toBe(200);
    const c = await mcp("read", { bearer: key.token });
    const ended = await end(key.name);
    expect(ended.status, ended.text.slice(0, 200)).toBe(200);
    expect((await ai.get(w.r1)).status).toBe(401);
    const after = await c.call<any>("query-notes", { id: w.r1 }).then(() => "answered", (e: Error) => e.message);
    expect(after).not.toBe("answered");
    await c.close().catch(() => {});
    const row = (await list()).body.grants.find((x: any) => x.id === key.name);
    expect(row.state).toBe("revoked");
  });

  test("the vault's own admin credential makes, lists and ends keys for that vault, and no other", async () => {
    const w = await theWorld();
    // An app reaches its hubs from its own origin: these bearer-only routes answer any origin, without credentials.
    for (const path of ["/account/keys", `/account/vaults/${enc(door().vault)}/statements`]) {
      const pre = await safeFetch(`${door().issuer}${path}`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
      expect(pre.status).toBeLessThan(300);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
      expect(pre.headers.get("access-control-allow-credentials")).not.toBe("true");
    }
    const key = await typedKey([w.R], "write", "vault-admin");
    const ai = records({ bearer: key.token });
    expect((await ai.get(w.r1)).status).toBe(200);
    const mine = await list("vault-admin");
    expect(mine.status).toBe(200);
    expect(mine.headers.get("access-control-allow-origin")).toBe("*");
    expect(mine.body.grants.some((x: any) => x.id === key.name)).toBe(true);
    // Another vault's list, a key for another vault, and the owner's whole key list stay the owner's.
    const other = door().otherVault;
    expect((await account("GET", `/account/vaults/${enc(other)}/statements`, undefined, "vault-admin")).status).toBe(403);
    expect((await account("POST", "/account/keys", { name: `x-${runId("k")}`, vault: other, can: "read", types: [w.R] }, "vault-admin")).status).toBe(403);
    expect((await account("GET", "/account/keys", undefined, "vault-admin")).status).toBe(403);
    expect((await end(key.name, "vault-admin")).status).toBe(200);
    expect((await ai.get(w.r1)).status).toBe(401);
  });

  test("a typed key is refused where it can't hold: an export key, no types, or a name that can't be a type", async () => {
    const w = await theWorld();
    await typedKey([w.R]);
    const mint = (body: Record<string, unknown>) => account("POST", "/account/keys", { name: `bad-${runId("k")}`, vault: door().vault, ...body });
    expect((await mint({ can: "export", types: [w.R] })).status).toBe(400);
    expect((await mint({ can: "write", types: [] })).status).toBe(400);
    expect((await mint({ can: "write", types: ["has space"] })).status).toBe(400);
    expect((await mint({ can: "write", types: [w.R], on_behalf_of: true })).status).toBe(400);
  });

  test("every credential that reaches the vault is a row in the list: an app key shows as a grant the door vouches for", async () => {
    // Moved from door-v1/grant.test.ts, which held it red until this list existed.
    const name = `door-app-${runId("k")}`;
    const made = await account("POST", "/account/keys", { name, vault: door().vault, can: "write" });
    expect(made.status).toBe(201);
    const list = await statements();
    expect(list.status).toBe(200);
    const row = list.body.grants.find((x: any) => x.id === name);
    expect(row).toMatchObject({ origin: "door", state: "in_force" });
    expect(row.types).toEqual({ "*": ["read", "create", "update", "delete"] });
    // A door grant has no signed event: the row says `event: null` (§7.1).
    expect(row.event ?? null).toBeNull();
    // Signed statements are a later slice: filing one is still refused as before.
    expect((await account("POST", `/account/vaults/${enc(door().vault)}/statements`, { event: {} })).status).toBe(405);
  });
});
