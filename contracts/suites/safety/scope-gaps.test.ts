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
//
// `private_tags` is set the only way an operator can: in the vault's vault.yaml (see scoped-write.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enc, mcp, must, operator, pass, rest, runId, safeFetch, services, type Reply } from "../lib.ts";
import { claims, mintOverHttp, note, subscribe } from "./_lib.ts";

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

/** Whether the operator sees a link from `from` to `to` (either direction listed). */
async function linked(from: string, to: string): Promise<boolean> {
  const r = await op.get(`/notes/${enc(from)}?include_links=true`);
  return JSON.stringify(r.body?.links ?? []).includes(to);
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

  for (const [i, [what, by]] of ([
    ["a structured link by id", (t: string) => ({ links: [{ target: t === hiddenPath ? hiddenId : missingId, relationship: "cites" }] })],
    ["a structured link by path", (t: string) => ({ links: [{ target: t, relationship: "cites" }] })],
    ["a [[wikilink]] in the content", (t: string) => ({ content: `see [[${t}]]` })],
  ] as const).entries()) {
    test(`REST create: ${what} to a hidden note answers as one to nothing, and makes no link`, async () => {
      const w = rest(s.vaultViaHub, writerPass);
      const make = (t: string, n: string) => w.post("/notes", { content: "a note", path: `${R}/g1/${n}`, tags: [MINE], ...by(t) });
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

  test("REST update: adding a link to a hidden note answers as one to nothing, and makes no link", async () => {
    const w = rest(s.vaultViaHub, writerPass);
    const id = await note(`${R}/g1/patched`, "patched later", [MINE]);
    const at = async () => (await w.get(`/notes/${id}`)).body.updatedAt as string;
    const hidden = await w.patch(`/notes/${id}`, { links: { add: [{ target: hiddenId, relationship: "cites" }] }, if_updated_at: await at() });
    const missing = await w.patch(`/notes/${id}`, { links: { add: [{ target: missingId, relationship: "cites" }] }, if_updated_at: await at() });
    expect(hidden.status).toBe(200);
    must(masked(hidden.body.warnings, hiddenId) === masked(missing.body.warnings, missingId), `PATCH: a link to a hidden note answered differently from a link to nothing: ${JSON.stringify(hidden.body.warnings)}`);
    must(!(await linked(id, hiddenId)), "a scoped writer's PATCH made a link into a hidden note");
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

describe("gap 2: no truncation or paging signal tells a scoped reader that hidden notes match", () => {
  beforeAll(async () => {
    await note(`${R}/g2/Secret/a`, `hidden one ${SECRET}`, [OTHER]);
    await note(`${R}/g2/Secret/b`, `hidden two ${SECRET}`, [OTHER]);
    await note(`${R}/g2/mine/a`, "visible one", [MINE]);
    await note(`${R}/g2/mine/b`, "visible two", [MINE]);
  });

  test("MCP query-notes: a page of only hidden notes carries no truncated warning; a full visible page does", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read", tags: [MINE] }));
    const truncated = (r: any) => JSON.stringify(r?.warnings ?? []).includes('"truncated"');
    try {
      const hidden = await c.call("query-notes", { path_prefix: `${R}/g2/Secret`, limit: 1 });
      must(!truncated(hidden), `MCP told a scoped reader that hidden notes match its filter: ${JSON.stringify(hidden).slice(0, 300)}`);
      expect(truncated(await c.call("query-notes", { path_prefix: `${R}/g2/mine`, limit: 1 }))).toBe(true);
    } finally {
      await c.close();
    }
  });

  test("REST cursor paging: a filter that matches only hidden notes ends at once, as one that matches nothing", async () => {
    const reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
    const hidden = await reader.get(`/notes?path_prefix=${enc(`${R}/g2/Secret`)}&limit=1&cursor=`);
    const none = await reader.get(`/notes?path_prefix=${enc(`${R}/g2/nothing`)}&limit=1&cursor=`);
    expect(hidden.status).toBe(200);
    must(JSON.stringify(hidden.body) === JSON.stringify(none.body), `cursor paging told a scoped reader that hidden notes match: ${JSON.stringify(hidden.body).slice(0, 300)}`);
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
    const { scopedAdmin } = await import("./_lib.ts");
    const admin = rest(s.vaultViaHub, await scopedAdmin([MINE]));
    const r = await admin.put(`/tags/${enc(MINE)}?force=true`, { parent_names: [OTHER] });
    must(r.status === 403 || r.status === 404, `a scoped admin named a parent outside its scope (status ${r.status})`);
    expect(JSON.stringify((await op.get(`/tags/${enc(MINE)}`)).body?.parent_names ?? null)).not.toContain(OTHER);
  });

  test("with force, the change goes through (positive control), and a tag no key names needs none", async () => {
    expect((await op.put(`/tags/${enc(`${R}free`)}`, { description: "no key names this" })).status).toBe(200);
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
      await op.patch(`/notes/${id}`, { content: `second words ${SECRET}` });
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
      await op.patch(`/notes/${id}`, { tags: { add: [OTHER], remove: [MINE] } });
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
    await op.patch(`/notes/${leaves}`, { tags: { add: [OTHER], remove: [MINE] } });
    const r1 = await safeFetch(down1.url);
    expect(r1.status).toBe(200); // positive control
    const r2 = await safeFetch(down2.url);
    const body2 = await r2.text();
    must(r2.status === 404 && !body2.includes(SECRET), `a download ticket was spent on a note outside the scope (status ${r2.status})`);
    const r3 = await safeFetch(upload.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: "more" });
    must(r3.status === 404, `an upload ticket was spent on a note outside the scope (status ${r3.status})`);
  });
});
