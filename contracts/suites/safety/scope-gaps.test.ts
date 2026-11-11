// Tag-scope gaps 1–8 (0.9 SPEC §3.3; security review of b3da982): one leak contract per gap, each written red first
// against `next` at 1af67d2 (T-442). A tag-scoped pass must never learn a hidden note's existence, id, path, count or
// content through any answer, error or warning, and nothing an admin does to the tag graph may change who sees what
// without saying so.
//
//  1. A scoped writer linking to a hidden note made a link into it, and the missing warning a missing target gets
//     told it the note exists.
//  2. A truncation signal decided before the scope filter (REST, guarded in vault-scope.test.ts since T-419;
//     MCP and cursor paging here).
//  3. `PATCH /api/vault` and the MCP twin: guarded in vault-scope.test.ts (fixed by T-419, #53).
//  4. Scoped admin passes: the mint refuses them, `parachute doctor` names any that exist; the vault-wide routes
//     refusing one is guarded in vault-scope.test.ts.
//  5. Vault-wide stats: guarded in vault-scope.test.ts (fixed by T-419).
//  6. Renames, merges, deletes and re-parenting change who sees what: refused without `force`, naming the keys.
//  7. A live subscription's scope is re-read on every event, and a note that leaves it is removed; an attachment
//     ticket is re-checked when it is spent.
//  8. The string sub-tag fallback: not closed (it would change what vault-scope.test.ts means; see the PR).
//  9. Deliberate and documented: a hidden note's path answers 409 on create (pinned below: it names nothing more).
//
// `private_tags` is set the only way an operator can: in the vault's vault.yaml (see scoped-write.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enc, mcp, must, operator, pass, rest, runId, safeFetch, services, type Reply } from "../lib.ts";
import { claims, mintOverHttp, note, scopedAdmin, subscribe } from "./_lib.ts";

const s = services();
const op = operator();
const R = runId("gap").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const SECRET = `zq${R}secretword`;

/** The hub's database on the box's disk (the contracts read it, as `resign` does in _lib.ts). */
function hubDb(readonly = true): Database {
  const path = [join(s.home, "hub.db"), join(s.home, "hub", "hub.db")].find(existsSync);
  if (!path) throw new Error(`setup: no hub.db under ${s.home}`);
  return new Database(path, readonly ? { readonly: true } : {});
}

/** The key name the hub gave the pass `token` (`parachute keys list` shows the same). */
function keyName(token: string): string {
  const db = hubDb();
  try {
    const row = db.query("SELECT name FROM keys WHERE jti = ?").get(claims(token).jti) as { name: string } | null;
    if (!row) throw new Error("setup: the minted pass has no key");
    return row.name;
  } finally {
    db.close();
  }
}

/** Run the `parachute` command on the box; never throws on a non-zero exit. */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(s.cli ? [...s.cli, ...args] : ["bun", "src/cli.ts", ...args], {
    cwd: s.cli ? s.home.replace(/\/\.parachute$/, "") : s.hubRepo,
    env: s.cliEnv ?? { PATH: process.env.PATH ?? "", HOME: s.home.replace(/\/\.parachute$/, ""), PARACHUTE_HOME: s.home, PARACHUTE_HUB_ORIGIN: s.hub },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** A write-time `warnings` array with the link target masked, so a hidden target and a missing one compare equal. */
function masked(warnings: unknown, target: string): string {
  return JSON.stringify(warnings ?? []).split(target).join("<target>");
}

/** PATCH a note as the operator, with the `if_updated_at` precondition every PATCH needs. */
async function opPatch(id: string, body: Record<string, unknown>): Promise<Reply> {
  const at = (await op.get(`/notes/${enc(id)}`)).body?.updatedAt;
  const r = await op.patch(`/notes/${enc(id)}`, { ...body, if_updated_at: at });
  if (r.status !== 200) throw new Error(`setup: PATCH ${id} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r;
}

/** A cursor's watermark (it is base64url JSON: anyone holding it can read it). */
function watermark(cursor: unknown): { at: unknown; id: unknown } {
  const c = JSON.parse(Buffer.from(String(cursor), "base64url").toString());
  return { at: c.last_updated_at, id: c.last_id };
}

/**
 * The two REST doors a note is reached through (SPEC §5.1): `/api/notes` and its record twin `/api/records`. A scoped
 * pass must learn nothing new through either, so the REST leak contracts run on both. `words` puts a note-word body
 * into the door's words (`content` → `body`, `metadata` → `fields` on the record door).
 */
const DOORS = [
  { door: "notes", words: (b: Record<string, unknown>) => b },
  {
    door: "records",
    words: (b: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(b).map(([k, v]) => [({ content: "body", metadata: "fields" } as Record<string, string>)[k] ?? k, v])),
  },
] as const;

/** Whether the operator sees a link from `from` to `to` (either direction listed). */
async function linked(from: string, to: string): Promise<boolean> {
  const r = await op.get(`/notes/${enc(from)}?include_links=true`);
  // By the link's ends, not its text: a hydrated link carries its notes' metadata, which may name `to` as a value.
  return ((r.body?.links ?? []) as { sourceId?: string; targetId?: string }[]).some(
    (l) => (l.sourceId === from && l.targetId === to) || (l.sourceId === to && l.targetId === from),
  );
}

describe("gap 1: a scoped writer can't link into a hidden note, or learn that it exists", () => {
  let writerPass: string;
  let hiddenId: string;
  const hiddenPath = `${R}/g1/hidden`;
  const missingPath = `${R}/g1/never-made`;
  const missingId = "01ZZZZZZZZZZZZZZZZZZZZZZZ1";

  beforeAll(async () => {
    writerPass = await pass({ level: "write", tags: [MINE] });
    hiddenId = await note(hiddenPath, `hidden ${SECRET}`, [OTHER]);
  });

  test("setup works today: the scoped writer can't read the hidden note, and a link to a visible note is made", async () => {
    const w = rest(s.vaultViaHub, writerPass);
    expect((await w.get(`/notes/${hiddenId}`)).status).toBe(404);
    const visible = await note(`${R}/g1/visible`, "a visible note", [MINE]);
    const r = await w.post("/notes", { content: "links to a visible note", path: `${R}/g1/to-visible`, tags: [MINE], links: [{ target: visible, relationship: "cites" }] });
    expect(r.status).toBe(201);
    expect(await linked(r.body.id, visible)).toBe(true);
  });

  for (const { door, words } of DOORS) for (const [i, [what, by]] of ([
    ["a structured link by id", (t: string) => ({ links: [{ target: t === hiddenPath ? hiddenId : missingId, relationship: "cites" }] })],
    ["a structured link by path", (t: string) => ({ links: [{ target: t, relationship: "cites" }] })],
    ["a [[wikilink]] in the content", (t: string) => ({ content: `see [[${t}]]` })],
  ] as const).entries()) {
    test(`REST /api/${door} create: ${what} to a hidden note answers as one to nothing, and makes no link`, async () => {
      const w = rest(s.vaultViaHub, writerPass);
      const make = (t: string, n: string) => w.post(`/${door}`, words({ content: "a note", path: `${R}/g1/${door}-${n}`, tags: [MINE], ...by(t) }));
      const hidden = await make(hiddenPath, `rest-h${i}`);
      const missing = await make(missingPath, `rest-m${i}`);
      expect(hidden.status).toBe(201);
      expect(missing.status).toBe(201);
      const t = (r: Reply, target: string) => masked(r.body.warnings, target);
      must(
        t(hidden, what.includes("id") ? hiddenId : hiddenPath) === t(missing, what.includes("id") ? missingId : missingPath),
        `a link to a hidden note answered differently from a link to nothing: ${JSON.stringify(hidden.body.warnings)} vs ${JSON.stringify(missing.body.warnings)}`,
      );
      must(!(await linked(hidden.body.id, hiddenId)), `a scoped writer's ${what} made a link into a hidden note`);
    });
  }

  for (const { door } of DOORS) test(`REST /api/${door} update: adding a link to a hidden note answers as one to nothing, and makes no link`, async () => {
    const w = rest(s.vaultViaHub, writerPass);
    const id = await note(`${R}/g1/${door}-patched`, "patched later", [MINE]);
    const at = async () => (await w.get(`/${door}/${id}`)).body.updatedAt as string;
    const hidden = await w.patch(`/${door}/${id}`, { links: { add: [{ target: hiddenId, relationship: "cites" }] }, if_updated_at: await at() });
    const missing = await w.patch(`/${door}/${id}`, { links: { add: [{ target: missingId, relationship: "cites" }] }, if_updated_at: await at() });
    expect(hidden.status).toBe(200);
    must(masked(hidden.body.warnings, hiddenId) === masked(missing.body.warnings, missingId), `PATCH: a link to a hidden note answered differently from a link to nothing: ${JSON.stringify(hidden.body.warnings)}`);
    must(!(await linked(id, hiddenId)), "a scoped writer's PATCH made a link into a hidden note");
  });

  // Round-1 review: with one visible and one hidden note of the same name, making no link (and no warning, since
  // the writer sees only one) told the writer the hidden one exists. The writer means the note it can see.
  for (const { door, words } of DOORS) test(`REST /api/${door}: a name one visible and one hidden note share links to the visible one`, async () => {
    const name = `${R}g1dup${door}`;
    await note(`${R}/g1/${door}-dup-hidden/${name}`, `hidden ${SECRET}`, [OTHER]);
    const visibleId = await note(`${R}/g1/${door}-dup-visible/${name}`, "the one the writer sees", [MINE]);
    const w = rest(s.vaultViaHub, writerPass);
    const r = await w.post(`/${door}`, words({ content: `see [[${name}]]`, path: `${R}/g1/${door}-dup-from`, tags: [MINE], links: [{ target: name, relationship: "cites" }] }));
    expect(r.status).toBe(201);
    must(JSON.stringify(r.body.warnings ?? []) === "[]", `a name a hidden note shares warned the writer: ${JSON.stringify(r.body.warnings)}`);
    must(await linked(r.body.id, visibleId), "a link to the one note the writer can see by that name was not made");
  });

  // Round-1 review: a reference field listing a hidden note (set by someone who can see it) lost that link when a
  // scoped writer edited the list, so the writer's edit destroyed a link it never saw.
  for (const { door, words } of DOORS) test(`REST /api/${door}: a scoped writer's edit of a reference list keeps another writer's link to a hidden note`, async () => {
    const typed = `${MINE}/ref${door}`;
    const put = await op.put(`/tags/${enc(typed)}`, { fields: { related: { type: "reference", cardinality: "many" } } });
    if (put.status >= 300) throw new Error(`setup: declaring ${typed} gave ${put.status}: ${JSON.stringify(put.body).slice(0, 200)}`);
    const visibleId = await note(`${R}/g1/${door}-ref-visible`, "visible", [MINE]);
    const r = await op.post("/notes", { content: "has references", path: `${R}/g1/${door}-ref-from`, tags: [MINE, typed], metadata: { related: [hiddenId] } });
    if (r.status !== 201) throw new Error(`setup: creating the referring note gave ${r.status}`);
    const id = r.body.id as string;
    must(await linked(id, hiddenId), "setup: the owner's reference didn't link");
    const w = rest(s.vaultViaHub, writerPass);
    const at = (await w.get(`/${door}/${id}`)).body.updatedAt;
    const p = await w.patch(`/${door}/${id}`, { ...words({ metadata: { related: [hiddenId, visibleId] } }), if_updated_at: at });
    expect(p.status).toBe(200);
    expect(await linked(id, visibleId)).toBe(true);
    must(await linked(id, hiddenId), "a scoped writer's edit deleted another writer's reference link to a note it can't see");
  });

  test("MCP create-note: a link and a wikilink to a hidden note answer as ones to nothing, and make no link", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const make = (t: string, id: string, n: string) =>
        c.call("create-note", { content: `see [[${t}]]`, path: `${R}/g1/${n}`, tags: [MINE], links: [{ target: id, relationship: "cites" }] });
      const hidden = await make(hiddenPath, hiddenId, "mcp-h");
      const missing = await make(missingPath, missingId, "mcp-m");
      const norm = (r: any, p: string, id: string) => masked(masked(r?.warnings, p), id);
      must(norm(hidden, hiddenPath, hiddenId) === norm(missing, missingPath, missingId), `MCP: a link to a hidden note answered differently from a link to nothing: ${JSON.stringify(hidden?.warnings)}`);
      must(!(await linked(hidden.id, hiddenId)), "a scoped MCP writer made a link into a hidden note");
    } finally {
      await c.close();
    }
  });

  test("an unscoped writer still links to the same note (positive control)", async () => {
    const r = await op.post("/notes", { content: `see [[${hiddenPath}]]`, path: `${R}/g1/by-op`, tags: [MINE] });
    expect(r.status).toBe(201);
    expect(await linked(r.body.id, hiddenId)).toBe(true);
  });
});

// Gap 9, deliberate (documented in packages/vault/docs/contracts/tag-scoped-tokens.md): paths are one namespace for
// the whole vault, so creating at a hidden note's path answers 409 path_conflict. That says something is there; it
// must say nothing more. Fixing it needs a path namespace per scope (1.0's grants).
describe("gap 9 (deliberate): a hidden note's path answers 409 on create, and names nothing of the note", () => {
  for (const { door, words } of DOORS) test(`/api/${door}: 409 path_conflict, with no id, tag or content of the hidden note`, async () => {
    const hiddenId = await note(`${R}/g9/${door}-taken`, `hidden ${SECRET}`, [OTHER]);
    const w = rest(s.vaultViaHub, await pass({ level: "write", tags: [MINE] }));
    const r = await w.post(`/${door}`, words({ content: "mine", path: `${R}/g9/${door}-taken`, tags: [MINE] }));
    expect(r.status).toBe(409);
    expect(r.body.error_type).toBe("path_conflict");
    const said = JSON.stringify(r.body);
    must(!said.includes(hiddenId) && !said.includes(SECRET) && !said.includes(OTHER), `the 409 named the hidden note: ${said.slice(0, 300)}`);
  });
});

describe("gap 2: no truncation or paging signal tells a scoped reader that hidden notes match", () => {
  beforeAll(async () => {
    await note(`${R}/g2/Secret/a`, `hidden one ${SECRET}`, [OTHER]);
    await note(`${R}/g2/Secret/b`, `hidden two ${SECRET}`, [OTHER]);
    await note(`${R}/g2/mine/a`, "visible one", [MINE]);
    await note(`${R}/g2/mine/b`, "visible two", [MINE]);
  });

  test("MCP query-notes: a page of only hidden notes carries no truncated warning (guard: next drops a scoped session's warnings)", async () => {
    const truncated = (r: any) => JSON.stringify(r?.warnings ?? []).includes('"truncated"');
    const scoped = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read", tags: [MINE] }));
    const admin = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "admin" }));
    try {
      const hidden = await scoped.call("query-notes", { path_prefix: `${R}/g2/Secret`, limit: 1 });
      must(!truncated(hidden), `MCP told a scoped reader that hidden notes match its filter: ${JSON.stringify(hidden).slice(0, 300)}`);
      expect(truncated(await admin.call("query-notes", { path_prefix: `${R}/g2/Secret`, limit: 1 }))).toBe(true); // the check can see one
    } finally {
      await scoped.close();
      await admin.close();
    }
  });

  test("REST and MCP cursor paging: a filter that matches only hidden notes gives the cursor a filter that matches nothing gets", async () => {
    const token = await pass({ level: "read", tags: [MINE] });
    const reader = rest(s.vaultViaHub, token);
    for (const { door } of DOORS) {
      const hidden = await reader.get(`/${door}?path_prefix=${enc(`${R}/g2/Secret`)}&limit=1&cursor=`);
      const none = await reader.get(`/${door}?path_prefix=${enc(`${R}/g2/nothing`)}&limit=1&cursor=`);
      expect(hidden.status).toBe(200);
      expect(hidden.body.notes ?? hidden.body.records).toEqual([]);
      must(
        JSON.stringify(watermark(hidden.body.next_cursor)) === JSON.stringify(watermark(none.body.next_cursor)),
        `REST /api/${door}: the cursor told a scoped reader about hidden notes: ${JSON.stringify(watermark(hidden.body.next_cursor))}`,
      );
    }
    const c = await mcp(`${s.vaultViaHub}/mcp`, token);
    try {
      const h = await c.call("query-notes", { path_prefix: `${R}/g2/Secret`, limit: 1, cursor: "" });
      const n = await c.call("query-notes", { path_prefix: `${R}/g2/nothing`, limit: 1, cursor: "" });
      must(
        JSON.stringify(watermark(h.next_cursor)) === JSON.stringify(watermark(n.next_cursor)),
        `MCP: the cursor told a scoped reader about hidden notes: ${JSON.stringify(watermark(h.next_cursor))}`,
      );
    } finally {
      await c.close();
    }
  });

  test("cursor paging walks every note a scoped reader can see, past pages of hidden ones", async () => {
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    for (const { door } of DOORS) {
      const seen: string[] = [];
      let cursor = "";
      for (let i = 0; i < 5; i++) {
        const r = await reader.get(`/${door}?path_prefix=${enc(`${R}/g2/`)}&limit=1&cursor=${enc(cursor)}`);
        const page = r.body.notes ?? r.body.records;
        seen.push(...page.map((n: any) => n.path));
        if (page.length === 0) break;
        cursor = r.body.next_cursor;
      }
      expect(seen.sort()).toEqual([`${R}/g2/mine/a`, `${R}/g2/mine/b`]);
    }
  });
});

describe("gap 4: a tag-scoped admin pass can't be minted, and doctor names one that exists", () => {
  const adminScope = () => ["read", "write", "admin"].map((l) => `vault:${s.vaultName}:${l}`).join(" ");

  test("`parachute auth mint-token` refuses admin with a tag scope, and says how to mint instead", async () => {
    const r = await cli(["auth", "mint-token", "--scope", adminScope(), "--ephemeral", "--label", `${R}-scoped-admin`, "--permissions", JSON.stringify({ scoped_tags: [MINE] })]);
    must(r.code !== 0, "the CLI minted a tag-scoped admin pass");
    expect(r.err).toMatch(/admin/i);
  });

  test("the hub's mint endpoint refuses admin with a tag scope", async () => {
    const r = await mintOverHttp(await pass({ level: "admin" }), { scope: adminScope(), label: `${R}-scoped-admin`, permissions: { scoped_tags: [MINE] } });
    must(r.status >= 400 && r.status < 500, `the mint endpoint minted a tag-scoped admin pass (status ${r.status})`);
    expect(JSON.stringify(r.body)).toMatch(/admin/i);
  });

  test("a tag-scoped write pass and an unscoped admin pass still mint (positive control)", async () => {
    expect(claims(await pass({ level: "write", tags: [MINE] })).permissions).toEqual({ scoped_tags: [MINE] });
    expect((await mintOverHttp(await pass({ level: "admin" }), { scope: adminScope(), label: `${R}-admin` })).status).toBe(200);
  });

  test("`parachute doctor` names a tag-scoped admin key minted before the fix, and no secret", async () => {
    // A key minted by an older hub: an admin key whose token row carries a tag scope.
    const token = await pass({ level: "admin" });
    const jti = claims(token).jti as string;
    const db = hubDb(false);
    try {
      db.query("UPDATE tokens SET permissions = ? WHERE jti = ?").run(JSON.stringify({ scoped_tags: [MINE] }), jti);
    } finally {
      db.close();
    }
    const name = keyName(token);
    const r = await cli(["doctor", "--json"]);
    const said = r.out + r.err;
    must(said.includes(name), `doctor didn't name the tag-scoped admin key "${name}": ${said.slice(0, 400)}`);
    must(!said.includes(jti) && !said.includes(token), "doctor printed the key's token or its id");
  });
});

test("gap 4: `parachute doctor` names a broad `vault:admin` key with a tag limit too", async () => {
  const token = await pass({ level: "admin" });
  const jti = claims(token).jti as string;
  const db = hubDb(false);
  try {
    db.query("UPDATE tokens SET scopes = ?, permissions = ? WHERE jti = ?").run("vault:read vault:write vault:admin", JSON.stringify({ scoped_tags: [MINE] }), jti);
  } finally {
    db.close();
  }
  const name = keyName(token);
  const said = await cli(["doctor", "--json"]).then((r) => r.out + r.err);
  must(said.includes(name), `doctor didn't name the broad vault:admin key "${name}" with a tag limit: ${said.slice(0, 400)}`);
});

describe("gap 6: changing a tag that a key's scope names is refused without force, naming the keys", () => {
  let keyed: string; // a pass scoped to KEPT
  const KEPT = `${R}kept`;
  const SPARE = `${R}spare`;
  const yamlPath = join(s.home, "vault", "data", s.vaultName, "vault.yaml");
  let yamlBefore: string | null = null;
  const PRIV = `${R}priv`;

  beforeAll(async () => {
    keyed = await pass({ level: "read", tags: [KEPT] });
    await note(`${R}/g6/kept`, "kept", [KEPT]);
    await note(`${R}/g6/spare`, "spare", [SPARE]);
    await note(`${R}/g6/priv`, "private", [PRIV]);
    yamlBefore = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : null;
    if (yamlBefore !== null && /^private_tags\s*:/m.test(yamlBefore)) throw new Error("setup: the box's vault.yaml already sets private_tags");
    writeFileSync(yamlPath, `${(yamlBefore ?? `name: ${s.vaultName}\n`).replace(/\n*$/, "\n")}private_tags: [${PRIV}]\n`);
  });
  afterAll(() => {
    if (yamlBefore !== null) writeFileSync(yamlPath, yamlBefore);
  });

  /** A refusal: 409, names `key` (when given), carries no secret, and points at force. */
  function refused(r: Reply, what: string, key?: string) {
    const body = JSON.stringify(r.body);
    must(r.status === 409, `${what} went through without force (status ${r.status}): ${body.slice(0, 300)}`);
    if (key) must(body.includes(key), `${what}: the refusal doesn't name the key "${key}": ${body.slice(0, 300)}`);
    must(!body.includes(keyed) && !body.includes(claims(keyed).jti), `${what}: the refusal carries a key's secret or id`);
    expect(body).toMatch(/force/);
  }

  test("REST: rename, merge, delete and re-parent of a tag a live key names", async () => {
    const key = keyName(keyed);
    refused(await op.post(`/tags/${enc(KEPT)}/rename`, { new_name: `${KEPT}x` }), "renaming a key's tag", key);
    refused(await op.post("/tags/merge", { sources: [KEPT], target: SPARE }), "merging a key's tag away", key);
    refused(await op.post("/tags/merge", { sources: [SPARE], target: KEPT }), "merging another tag into a key's tag", key);
    refused(await op.del(`/tags/${enc(KEPT)}`), "deleting a key's tag", key);
    refused(await op.put(`/tags/${enc(SPARE)}`, { parent_names: [KEPT] }), "putting a tag under a key's tag", key);
    expect((await rest(s.vaultViaHub, keyed).get(`/notes?tag=${enc(KEPT)}`)).body.length).toBe(1);
  });

  test("/api/types: rename, merge, delete and re-parent of a tag a live key names (the record door's twin)", async () => {
    const key = keyName(keyed);
    refused(await op.post(`/types/${enc(KEPT)}/rename`, { new_name: `${KEPT}x` }), "renaming a key's tag on /api/types", key);
    refused(await op.post("/types/merge", { sources: [SPARE], target: KEPT }), "merging into a key's tag on /api/types", key);
    refused(await op.del(`/types/${enc(KEPT)}`), "deleting a key's tag on /api/types", key);
    refused(await op.put(`/types/${enc(SPARE)}`, { parent_names: [KEPT] }), "putting a tag under a key's tag on /api/types", key);
  });

  // Round-1 review: a key's tags and private_tags reach names under them (`secret/diary`) and their declared
  // children, so a change to such a name changes who sees what as much as one to the name itself.
  test("REST: a change to a name under a key's or a private tag, by prefix or by parent, is refused too", async () => {
    const key = keyName(keyed);
    await note(`${R}/g6/priv-sub`, "private by prefix", [`${PRIV}/diary`]);
    refused(await op.post(`/tags/${enc(`${PRIV}/diary`)}/rename`, { new_name: `${R}diary` }), "renaming a private tag's sub-tag out from under it");
    refused(await op.post("/tags/merge", { sources: [`${PRIV}/diary`], target: SPARE }), "merging a private tag's sub-tag away");
    expect((await op.put(`/tags/${enc(`${R}pchild`)}?force=true`, { parent_names: [PRIV] })).status).toBe(200);
    await note(`${R}/g6/priv-child`, "private by parent", [`${R}pchild`]);
    refused(await op.post("/tags/merge", { sources: [`${R}pchild`], target: SPARE }), "merging a private tag's child away");
    refused(await op.del(`/tags/${enc(`${R}pchild`)}`), "deleting a private tag's child");
    refused(await op.post("/tags/merge", { sources: [SPARE], target: `${KEPT}/sub` }), "merging into a name under a key's tag", key);
    expect((await op.put(`/tags/${enc(`${R}kchild`)}?force=true`, { parent_names: [KEPT] })).status).toBe(200);
    refused(await op.post("/tags/merge", { sources: [SPARE], target: `${R}kchild` }), "merging into a key's tag's child", key);
    expect((await op.get(`/tags/${enc(`${PRIV}/diary`)}`)).status).toBe(200);
  });

  // Round-1 review: the refusal named every key and private tag the change touched, so a tag-scoped admin (minted
  // before 0.9.1) learned the names of keys and tags outside its scope. To a scoped caller every such change needs
  // force, and the refusal names nothing.
  test("a tag-scoped admin's refusal names no key or tag, and doesn't say whether one reaches its tag", async () => {
    const FAM = `${R}fam`;
    const ITS = `${R}its`;
    const LONE = `${R}lone`;
    await note(`${R}/g6/fam`, "another key's", [FAM]);
    expect((await op.put(`/tags/${enc(ITS)}?force=true`, { parent_names: [FAM] })).status).toBe(200);
    expect((await op.put(`/tags/${enc(`${LONE}a`)}?force=true`, { parent_names: [LONE] })).status).toBe(200);
    const famKey = keyName(await pass({ level: "read", tags: [FAM] }));
    await note(`${R}/g6/its`, "the scoped admin's", [ITS]);
    await note(`${R}/g6/lone`, "the scoped admin's, reached by no other key", [LONE]);
    const token = await scopedAdmin([ITS, LONE]);
    const admin = rest(s.vaultViaHub, token);
    const reached = await admin.put(`/tags/${enc(ITS)}`, { parent_names: [] });
    const free = await admin.del(`/tags/${enc(`${LONE}a`)}`);
    for (const [what, r] of [["re-parenting its tag away from another key's", reached], ["deleting a tag no other key reaches", free]] as const) {
      const body = JSON.stringify(r.body);
      must(!body.includes(famKey) && !body.includes(FAM) && !body.includes(PRIV) && !body.includes(KEPT), `${what}: the refusal named a key or tag outside the scope: ${body.slice(0, 300)}`);
    }
    must(reached.status === free.status && JSON.stringify(reached.body?.keys ?? null) === JSON.stringify(free.body?.keys ?? null), `a scoped admin can tell whether another key reaches its tag: ${reached.status} ${JSON.stringify(reached.body).slice(0, 200)} vs ${free.status} ${JSON.stringify(free.body).slice(0, 200)}`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, token);
    try {
      const said = await c.call("update-tag", { tag: ITS, parent_names: [] }).then((r) => JSON.stringify(r), (e) => (e as Error).message);
      must(!said.includes(famKey) && !said.includes(FAM), `MCP: the refusal named a key or tag outside the scope: ${said.slice(0, 300)}`);
    } finally {
      await c.close();
    }
    expect(JSON.stringify((await op.get(`/tags/${enc(ITS)}`)).body?.parent_names ?? null)).toContain(FAM);
  });

  test("REST: rename and delete of a private tag and of the published tag", async () => {
    refused(await op.post(`/tags/${enc(PRIV)}/rename`, { new_name: `${PRIV}x` }), "renaming a private tag");
    refused(await op.del(`/tags/${enc(PRIV)}`), "deleting a private tag");
    refused(await op.post(`/tags/publish/rename`, { new_name: `${R}pub` }), "renaming the published tag");
  });

  test("MCP: manage-types rename of a key's tag", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "admin" }));
    try {
      const said = await c.call("manage-types", { action: "rename", old_name: KEPT, new_name: `${KEPT}x` }).then((r) => JSON.stringify(r), (e) => (e as Error).message);
      must(/force/.test(said) && said.includes(keyName(keyed)), `MCP renamed a key's tag without force: ${said.slice(0, 300)}`);
    } finally {
      await c.close();
    }
    expect((await op.get(`/tags/${enc(KEPT)}`)).status).toBe(200);
  });

  test("a scoped admin can't put its tag under a tag outside its scope", async () => {
    // A pass an older hub minted (0.9.1 refuses to mint one, gap 4).
    const admin = rest(s.vaultViaHub, await scopedAdmin([MINE]));
    const r = await admin.put(`/tags/${enc(MINE)}?force=true`, { parent_names: [OTHER] });
    must(r.status === 403 || r.status === 404, `a scoped admin named a parent outside its scope (status ${r.status})`);
    expect(JSON.stringify((await op.get(`/tags/${enc(MINE)}`)).body?.parent_names ?? null)).not.toContain(OTHER);
  });

  test("with force, the change goes through (positive control), and a tag no key names needs none", async () => {
    await note(`${R}/g6/free`, "a tag no key names", [`${R}free`]);
    expect((await op.post(`/tags/${enc(`${R}free`)}/rename`, { new_name: `${R}free2` })).status).toBe(200);
    const r = await op.post(`/tags/${enc(KEPT)}/rename?force=true`, { new_name: `${KEPT}x` });
    expect(r.status).toBe(200);
  });
});

describe("gap 7: a live subscription follows the scope as it is now, and a ticket is checked when spent", () => {
  const CHILD = `${R}child`;
  const LATER = `${R}later`;

  test("a re-parented tag leaves the socket: no upsert after it, a remove instead", async () => {
    await op.put(`/tags/${enc(CHILD)}?force=true`, { parent_names: [MINE] });
    const id = await note(`${R}/g7/child`, "first words", [CHILD]);
    const token = await pass({ level: "read", tags: [MINE] });
    expect((await rest(s.vaultViaHub, token).get(`/notes/${id}`)).status).toBe(200);
    const live = await subscribe(token);
    try {
      expect((await op.put(`/tags/${enc(CHILD)}?force=true`, { parent_names: null })).status).toBe(200);
      expect((await rest(s.vaultViaHub, token).get(`/notes/${id}`)).status).toBe(404);
      await opPatch(id, { content: `second words ${SECRET}` });
      await live.waitFor((f) => f.type === "remove" && f.id === id, "the remove of a note that left the scope");
      must(!JSON.stringify(live.frames).includes(SECRET), "the socket sent a note after it left the pass's scope");
    } finally {
      live.close();
    }
  });

  test("a note whose tags leave the scope is removed from the socket", async () => {
    const id = await note(`${R}/g7/moves`, "in scope", [MINE]);
    const live = await subscribe(await pass({ level: "read", tags: [MINE] }));
    try {
      await opPatch(id, { tags: { add: [OTHER], remove: [MINE] } });
      await live.waitFor((f) => f.type === "remove" && f.id === id, "the remove of a note retagged out of scope");
    } finally {
      live.close();
    }
  });

  test("a tag put under the scope after subscribing is seen", async () => {
    const token = await pass({ level: "read", tags: [MINE] });
    const live = await subscribe(token);
    try {
      await op.put(`/tags/${enc(LATER)}?force=true`, { parent_names: [MINE] });
      const id = await note(`${R}/g7/later`, "a later sub-tag", [LATER]);
      expect((await rest(s.vaultViaHub, token).get(`/notes/${id}`)).status).toBe(200);
      await live.waitFor((f) => f.type === "upsert" && f.note?.id === id, "the upsert of a note under a later sub-tag");
    } finally {
      live.close();
    }
  });

  async function attached(noteId: string): Promise<string> {
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode(`attachment ${SECRET}`)], "made-up.txt", { type: "text/plain" }));
    const up = await safeFetch(`${s.vaultViaHub}/api/storage/upload`, { method: "POST", headers: { authorization: `Bearer ${s.operatorToken}` }, body: form });
    if (up.status >= 300) throw new Error(`setup: upload gave ${up.status}`);
    const att = await op.post(`/notes/${enc(noteId)}/attachments`, { path: (await up.json()).path, mimeType: "text/plain" });
    if (att.status >= 300) throw new Error(`setup: attach gave ${att.status}`);
    return (att.body.id ?? att.body.attachment?.id) as string;
  }

  test("an attachment ticket is refused when spent after its note left the scope", async () => {
    const stays = await note(`${R}/g7/att-stays`, "keeps its tag", [MINE]);
    const leaves = await note(`${R}/g7/att-leaves`, "loses its tag", [MINE]);
    const [a1, a2] = [await attached(stays), await attached(leaves)];
    const c = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "write", tags: [MINE] }));
    let down1: any, down2: any, upload: any;
    try {
      down1 = await c.call("request-attachment-download", { attachment_id: a1 });
      down2 = await c.call("request-attachment-download", { attachment_id: a2 });
      upload = await c.call("request-attachment-upload", { note: leaves, filename: "more.txt", size_bytes: 4, mime_type: "text/plain" });
    } finally {
      await c.close();
    }
    await opPatch(leaves, { tags: { add: [OTHER], remove: [MINE] } });
    const r1 = await safeFetch(down1.url);
    expect(r1.status).toBe(200); // positive control
    const r2 = await safeFetch(down2.url);
    const body2 = await r2.text();
    must(r2.status === 404 && !body2.includes(SECRET), `a download ticket was spent on a note outside the scope (status ${r2.status})`);
    const r3 = await safeFetch(upload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: "more" });
    must(r3.status === 404, `an upload ticket was spent on a note outside the scope (status ${r3.status})`);
  });
});
