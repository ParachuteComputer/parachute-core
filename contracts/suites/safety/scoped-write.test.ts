// Fixes 6 and 15 (G2): a tag-scoped writer can't add a tag it doesn't hold, `publish` and private tags included.
//
// Before the fix (vault 42fbf93) a scoped write passed if the note ended up with ONE tag in scope
// (src/tag-scope.ts:382-396, tagsWithinScope returned on the first allowed tag), so the writer could add any other
// tag; this was deliberate per vault#568 (src/routes.ts:3217-3221). Adding `publish` made the note public on /view,
// and the vault's `private_tags` were no bar (fix 15). Fixed by lane F in packages/vault (src/tag-scope.ts, and the publication guard in core/src/mcp.ts):
// every tag a write adds must be one the pass can read. Mutant "g2-added-tag-kept" puts the bug back. PLAN §5
// fixes 6 and 15, §7.5. It changes what a contract means (Aaron's or Benjamin's call; the plan's default, yes,
// was taken).
//
// `private_tags` can only be set in the vault's vault.yaml (vault src/config.ts:682-770; no HTTP or CLI door sets
// it), so this file sets it the way an operator does: by editing $PARACHUTE_HOME/vault/data/<vault>/vault.yaml.
// The vault reads it on every scoped request. The original file is put back afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enc, mcp, must, operator, rest, runId, services } from "../lib.ts";
import { note, pass, view } from "./_lib.ts";

const s = services();
const op = operator();
const R = runId("sw").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const PRIVATE = `${R}private`;
const NESTED = `${R}deep/nested`; // a private tag below a root that isn't private
const yamlPath = join(s.home, "vault", "data", s.vaultName, "vault.yaml");
let yamlBefore: string | null = null;
let writerPass: string;
let writer: ReturnType<typeof rest>;
let readerPass: string;
let reader: ReturnType<typeof rest>;

beforeAll(async () => {
  writerPass = await pass({ level: "write", tags: [MINE] });
  writer = rest(s.vaultViaHub, writerPass);
  readerPass = await pass({ level: "read", tags: [MINE] });
  reader = rest(s.vaultViaHub, readerPass);
  yamlBefore = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : null;
  if (yamlBefore !== null && /^private_tags\s*:/m.test(yamlBefore)) throw new Error("setup: the box's vault.yaml already sets private_tags");
  writeFileSync(yamlPath, `${(yamlBefore ?? `name: ${s.vaultName}\n`).replace(/\n*$/, "\n")}private_tags: [${PRIVATE}, ${NESTED}]\n`);
});

afterAll(() => {
  if (yamlBefore === null) return;
  writeFileSync(yamlPath, yamlBefore);
});

/** The tags a note carries, as the operator sees them (null if there's no note at that path). */
async function tagsAt(path: string): Promise<string[] | null> {
  const r = await op.get(`/notes/${enc(path)}`);
  return r.status === 200 ? (r.body.tags ?? []) : null;
}

async function current(id: string): Promise<string> {
  return (await op.get(`/notes/${id}`)).body.updatedAt;
}

describe("a scoped writer adds only tags it holds (fixes 6, 15)", () => {
  test("setup works today: the scoped writer creates in scope, and private_tags hides a co-tagged note from a scoped reader", async () => {
    const r = await writer.post("/notes", { content: "in scope", path: `${R}/plain`, tags: [MINE] });
    expect(r.status).toBe(201);
    expect(await tagsAt(`${R}/plain`)).toEqual([MINE]);
    // The vault.yaml edit took effect: a note tagged with the scope's tag AND the private tag is hidden.
    const priv = await note(`${R}/private-by-op`, "operator's private note", [MINE, PRIVATE]);
    expect((await reader.get(`/notes/${priv}`)).status).toBe(404);
    expect((await reader.get(`/notes/${await note(`${R}/shared-by-op`, "shared", [MINE])}`)).status).toBe(200);
  });

  test("editing an in-scope note that also carries other tags still works (positive control)", async () => {
    const id = await note(`${R}/cotagged`, "first words", [MINE, OTHER]);
    const r = await writer.patch(`/notes/${id}`, { content: "second words", if_updated_at: await current(id) });
    expect(r.status).toBe(200);
    const after = await op.get(`/notes/${id}`);
    expect(after.body.content).toBe("second words");
    expect([...after.body.tags].sort()).toEqual([MINE, OTHER].sort());
  });

  test("on create, a scoped writer can't add a tag outside its scope", async () => {
    const path = `${R}/create-other`;
    const r = await writer.post("/notes", { content: "smuggled", path, tags: [MINE, OTHER] });
    must(!(await tagsAt(path))?.includes(OTHER), `create kept an added tag outside the writer's scope (status ${r.status})`);
  });

  test("on create, a scoped writer can't add publish (so can't make a note public)", async () => {
    const path = `${R}/create-publish`;
    const r = await writer.post("/notes", { content: `made public ${R}`, path, tags: [MINE, "publish"] });
    const pub = await view(null, path);
    must(!(await tagsAt(path))?.includes("publish"), `create kept an added tag outside the writer's scope: publish (status ${r.status}; anonymous /view ${pub.status})`);
    expect(pub.status).toBe(404);
  });

  test("on create, a scoped writer can't add a private tag", async () => {
    const path = `${R}/create-private`;
    const r = await writer.post("/notes", { content: "into the private tag", path, tags: [MINE, PRIVATE] });
    must(!(await tagsAt(path))?.includes(PRIVATE), `create kept an added private tag (status ${r.status})`);
  });

  test("on update, a scoped writer can't add a tag outside its scope, publish included", async () => {
    for (const tag of [OTHER, "publish"]) {
      const id = await note(`${R}/update-${tag === "publish" ? "publish" : "other"}`, "mine only", [MINE]);
      const r = await writer.patch(`/notes/${id}`, { tags: { add: [tag] }, if_updated_at: await current(id) });
      const tags = (await op.get(`/notes/${id}`)).body.tags as string[];
      must(!tags.includes(tag), `update kept an added tag outside the writer's scope: ${tag === "publish" ? "publish" : "other"} (status ${r.status})`);
    }
  });

  test("on update, a scoped writer can't add a private tag", async () => {
    const id = await note(`${R}/update-private`, "mine only", [MINE]);
    const r = await writer.patch(`/notes/${id}`, { tags: { add: [PRIVATE] }, if_updated_at: await current(id) });
    const tags = (await op.get(`/notes/${id}`)).body.tags as string[];
    must(!tags.includes(PRIVATE), `update kept an added private tag (status ${r.status})`);
  });

  // The other write doors: REST batch create and upsert-create, and MCP create-note / update-note.
  test("a scoped writer can't add a tag outside its scope through a REST batch or an upsert-create", async () => {
    const batch = await writer.post("/notes", { notes: [{ content: "batch", path: `${R}/batch-other`, tags: [MINE, OTHER] }] });
    must(!(await tagsAt(`${R}/batch-other`))?.includes(OTHER), `batch create kept an added tag outside the writer's scope (status ${batch.status})`);
    const upsert = await writer.patch(`/notes/${enc(`${R}/upsert-other`)}`, { content: "upsert", tags: [MINE, OTHER], if_missing: "create" });
    must(!(await tagsAt(`${R}/upsert-other`))?.includes(OTHER), `upsert-create kept an added tag outside the writer's scope (status ${upsert.status})`);
  });

  test("over MCP, a scoped writer can't add a tag outside its scope, on create or update", async () => {
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said = (p: Promise<unknown>) => p.then((r) => JSON.stringify(r).slice(0, 200), (e) => (e as Error).message.slice(0, 200));
      const created = await said(c.call("create-note", { content: "smuggled", path: `${R}/mcp-create-other`, tags: [MINE, OTHER] }));
      must(!(await tagsAt(`${R}/mcp-create-other`))?.includes(OTHER), `MCP create-note kept an added tag outside the writer's scope (${created})`);
      const id = await note(`${R}/mcp-update-other`, "mine only", [MINE]);
      const updated = await said(c.call("update-note", { id, tags: { add: [OTHER] }, if_updated_at: await current(id) }));
      must(!(await tagsAt(`${R}/mcp-update-other`))?.includes(OTHER), `MCP update-note kept an added tag outside the writer's scope (${updated})`);
    } finally {
      await c.close();
    }
  });

  test("over MCP, editing an in-scope note that also carries other tags still works (positive control)", async () => {
    const id = await note(`${R}/mcp-cotagged`, "first words", [MINE, OTHER]);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      await c.call("update-note", { id, content: "second words", if_updated_at: await current(id) });
    } finally {
      await c.close();
    }
    const after = await op.get(`/notes/${id}`);
    expect(after.body.content).toBe("second words");
    expect([...after.body.tags].sort()).toEqual([MINE, OTHER].sort());
  });
});

// Codex round 1: tags spelled `#tag` are stored bare, and an update applies `add` then `remove`. The scope check
// must see the tags exactly as they will be stored, or a writer can drop its only in-scope tag from a co-tagged note
// (leaving a note it can't see, carrying tags it doesn't hold).
describe("a scoped writer can't escape its scope through how tags are spelled or ordered", () => {
  test("removing `#mine` from a note also tagged other is refused, over REST and MCP", async () => {
    const id = await note(`${R}/hash-remove`, "co-tagged", [MINE, OTHER]);
    const r = await writer.patch(`/notes/${id}`, { tags: { remove: [`#${MINE}`] }, if_updated_at: await current(id) });
    must((await tagsAt(`${R}/hash-remove`))?.includes(MINE), `REST: removing #${MINE} left the note outside the writer's scope (status ${r.status})`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said = await c.call("update-note", { id, tags: { remove: [`#${MINE}`] }, if_updated_at: await current(id) }).then((x) => JSON.stringify(x).slice(0, 200), (e) => (e as Error).message.slice(0, 200));
      must((await tagsAt(`${R}/hash-remove`))?.includes(MINE), `MCP: removing #${MINE} left the note outside the writer's scope (${said})`);
    } finally {
      await c.close();
    }
  });

  test("adding and removing the same in-scope tag on a co-tagged note is refused (the store removes it)", async () => {
    const id = await note(`${R}/add-remove`, "co-tagged", [MINE, OTHER]);
    const r = await writer.patch(`/notes/${id}`, { tags: { add: [MINE], remove: [MINE] }, if_updated_at: await current(id) });
    must((await tagsAt(`${R}/add-remove`))?.includes(MINE), `adding and removing ${MINE} left the note outside the writer's scope (status ${r.status})`);
  });

  test("adding and removing a tag outside the scope in one write is refused, and leaves no trace (REST and MCP)", async () => {
    // A tag the writer can't see, whose schema gives notes a default field: attaching it, even for a moment,
    // writes that default into the note.
    const DEF = `${R}defaults`;
    const MARK = `zq${R}defaultvalue`;
    const put = await op.put(`/tags/${enc(DEF)}`, { fields: { internal_label: { type: "string", default: MARK } } });
    expect(put.status).toBeLessThan(300);
    const id = await note(`${R}/add-remove-other`, "mine only", [MINE]);
    const r = await writer.patch(`/notes/${id}`, { tags: { add: [DEF], remove: [DEF] }, if_updated_at: await current(id) });
    let after = (await op.get(`/notes/${id}`)).body;
    must(!JSON.stringify(after.metadata ?? {}).includes(MARK), `REST: adding and removing ${DEF} wrote its schema default into the note (status ${r.status})`);
    expect(after.tags).toEqual([MINE]);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said = await c.call("update-note", { id, tags: { add: [DEF], remove: [DEF] }, if_updated_at: await current(id) }).then((x) => JSON.stringify(x).slice(0, 200), (e) => (e as Error).message.slice(0, 200));
      after = (await op.get(`/notes/${id}`)).body;
      must(!JSON.stringify(after.metadata ?? {}).includes(MARK), `MCP: adding and removing ${DEF} wrote its schema default into the note (${said})`);
      expect(after.tags).toEqual([MINE]);
    } finally {
      await c.close();
    }
  });

  test("re-adding a hidden tag the note already carries is refused just like adding it fresh, and re-applies nothing", async () => {
    const DEF = `${R}readd`;
    const MARK = `zq${R}readdvalue`;
    expect((await op.put(`/tags/${enc(DEF)}`, { fields: { readd_label: { type: "string", default: MARK } } })).status).toBeLessThan(300);
    const carries = await note(`${R}/readd-carries`, "carries the hidden tag", [MINE, DEF]);
    // The operator clears the default the create applied, so a re-applied default would show.
    expect((await op.patch(`/notes/${carries}`, { metadata: { readd_label: null }, if_updated_at: await current(carries) })).status).toBe(200);
    const lacks = await note(`${R}/readd-lacks`, "lacks the hidden tag", [MINE]);
    const statuses: number[] = [];
    for (const id of [carries, lacks]) {
      const r = await writer.patch(`/notes/${id}`, { tags: { add: [DEF] }, if_updated_at: await current(id) });
      statuses.push(r.status);
    }
    must(statuses[0] === statuses[1], `REST: re-adding a hidden tag answered ${statuses[0]} when the note carries it and ${statuses[1]} when it doesn't`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said: string[] = [];
      for (const id of [carries, lacks]) {
        said.push(await c.call("update-note", { id, tags: { add: [DEF] }, if_updated_at: await current(id) }).then((x) => JSON.stringify(x).split(id).join("<id>").replace(/"updated_?[aA]t":"[^"]*"/g, ""), (e) => (e as Error).message.split(id).join("<id>")));
      }
      must(said[0] === said[1], `MCP: re-adding a hidden tag answered differently when the note carries it: ${said[0]!.slice(0, 150)} vs ${said[1]!.slice(0, 150)}`);
    } finally {
      await c.close();
    }
    const after = (await op.get(`/notes/${carries}`)).body;
    must(!JSON.stringify(after.metadata ?? {}).includes(MARK), "re-adding a hidden tag re-applied its schema default to the note");
    expect([...after.tags].sort()).toEqual([MINE, DEF].sort());
  });

  test("removing a tag the writer can't read is refused, the same whether or not the note carries it (REST and MCP)", async () => {
    const carries = await note(`${R}/rm-carries`, "co-tagged", [MINE, OTHER]);
    const lacks = await note(`${R}/rm-lacks`, "mine only", [MINE]);
    const statuses: number[] = [];
    for (const id of [carries, lacks]) statuses.push((await writer.patch(`/notes/${id}`, { tags: { remove: [OTHER] }, if_updated_at: await current(id) })).status);
    must(statuses[0] === statuses[1], `REST: removing a hidden tag answered ${statuses[0]} when the note carries it and ${statuses[1]} when it doesn't`);
    must((await tagsAt(`${R}/rm-carries`))?.includes(OTHER), `REST: a scoped writer removed a tag outside its scope (status ${statuses[0]})`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said = await c.call("update-note", { id: carries, tags: { remove: [OTHER] }, if_updated_at: await current(carries) }).then((x) => JSON.stringify(x).slice(0, 200), (e) => (e as Error).message.slice(0, 200));
      must((await tagsAt(`${R}/rm-carries`))?.includes(OTHER), `MCP: a scoped writer removed a tag outside its scope (${said})`);
    } finally {
      await c.close();
    }
  });

  // Codex round 9: /view also publishes a note whose metadata says `published: true`, so that field is a second way
  // to make a note public. A writer without the published tag can't change it, on any door.
  test("a scoped writer can't make a note public through metadata.published (REST create/update, MCP create/update)", async () => {
    const pub = async (path: string) => (await view(null, path)).status;
    const r1 = await writer.post("/notes", { content: `meta-published ${R}`, path: `${R}/meta-create`, tags: [MINE], metadata: { published: true } });
    must((await pub(`${R}/meta-create`)) === 404, `REST create with metadata.published made the note public (status ${r1.status})`);
    const id = await note(`${R}/meta-update`, "not public", [MINE]);
    const r2 = await writer.patch(`/notes/${id}`, { metadata: { published: true }, if_updated_at: await current(id) });
    must((await pub(`${R}/meta-update`)) === 404, `REST update with metadata.published made the note public (status ${r2.status})`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said1 = await c.call("create-note", { content: "mcp meta", path: `${R}/meta-mcp-create`, tags: [MINE], metadata: { published: true } }).then((x) => JSON.stringify(x).slice(0, 120), (e) => (e as Error).message.slice(0, 120));
      must((await pub(`${R}/meta-mcp-create`)) === 404, `MCP create-note with metadata.published made the note public (${said1})`);
      const said2 = await c.call("update-note", { id, metadata: { published: true }, if_updated_at: await current(id) }).then((x) => JSON.stringify(x).slice(0, 120), (e) => (e as Error).message.slice(0, 120));
      must((await pub(`${R}/meta-update`)) === 404, `MCP update-note with metadata.published made the note public (${said2})`);
    } finally {
      await c.close();
    }
  });

  // Codex round 10: schema defaults fill fields after the write, so a tag in scope whose schema defaults `published`
  // to true would publish too. A separate writer and tag, so the default touches nothing else here.
  test("a schema default of published: true doesn't publish a scoped writer's note (REST and MCP, create and re-add)", async () => {
    const PUBDEF = `${R}pubdef`;
    expect((await op.put(`/tags/${enc(PUBDEF)}`, { fields: { published: { type: "boolean", default: true } } })).status).toBeLessThan(300);
    const pubPass = await pass({ level: "write", tags: [PUBDEF] });
    const w = rest(s.vaultViaHub, pubPass);
    const pub = async (path: string) => (await view(null, path)).status;
    const r1 = await w.post("/notes", { content: `default-published ${R}`, path: `${R}/pubdef-create`, tags: [PUBDEF] });
    must((await pub(`${R}/pubdef-create`)) === 404, `REST create: a published default made the note public (status ${r1.status})`);
    // A note in the writer's scope whose published field the operator removed: re-adding the tag re-applies defaults.
    const id = await note(`${R}/pubdef-readd`, "not public", [PUBDEF]);
    expect((await op.patch(`/notes/${id}`, { metadata: { published: null }, if_updated_at: await current(id) })).status).toBe(200);
    expect(await pub(`${R}/pubdef-readd`)).toBe(404);
    const r2 = await w.patch(`/notes/${id}`, { tags: { add: [PUBDEF] }, if_updated_at: await current(id) });
    must((await pub(`${R}/pubdef-readd`)) === 404, `REST update: re-adding a tag with a published default made the note public (status ${r2.status})`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, pubPass);
    try {
      const said1 = await c.call("create-note", { content: "mcp default", path: `${R}/pubdef-mcp`, tags: [PUBDEF] }).then((x) => JSON.stringify(x).slice(0, 120), (e) => (e as Error).message.slice(0, 120));
      must((await pub(`${R}/pubdef-mcp`)) === 404, `MCP create-note: a published default made the note public (${said1})`);
      const said2 = await c.call("update-note", { id, tags: { add: [PUBDEF] }, if_updated_at: await current(id) }).then((x) => JSON.stringify(x).slice(0, 120), (e) => (e as Error).message.slice(0, 120));
      must((await pub(`${R}/pubdef-readd`)) === 404, `MCP update-note: re-adding a tag with a published default made the note public (${said2})`);
    } finally {
      await c.close();
    }
  });

  // Codex round 11: an upsert onto an existing note (`if_exists: update`) must not backfill the defaults of the
  // note's other tags. A hidden co-tag whose schema gains a `published: true` default (and a marker field) after the
  // note exists would otherwise publish it and copy its defaults into a note the writer reads.
  test("an if_exists update by a scoped writer applies no default of a hidden co-tag (REST single and batch, MCP)", async () => {
    const HD = `${R}hiddendef`;
    const MARK = `zq${R}hiddendefault`;
    const paths = [`${R}/upsert-rest`, `${R}/upsert-batch`, `${R}/upsert-mcp`];
    for (const p of paths) await note(p, "existing", [MINE, HD]);
    expect((await op.put(`/tags/${enc(HD)}`, { fields: { published: { type: "boolean", default: true }, hd_label: { type: "string", default: MARK } } })).status).toBeLessThan(300);
    const leaked = async (p: string) => {
      const n = (await op.get(`/notes/${enc(p)}`)).body;
      return JSON.stringify(n.metadata ?? {}).includes(MARK) || (await view(null, p)).status !== 404;
    };
    const r1 = await writer.post("/notes", { path: paths[0], tags: [MINE], content: "edited", if_exists: "update" });
    must(!(await leaked(paths[0]!)), `REST if_exists update applied a hidden co-tag's defaults (status ${r1.status})`);
    const r2 = await writer.post("/notes", { notes: [{ path: paths[1], tags: [MINE], content: "edited", if_exists: "update" }] });
    must(!(await leaked(paths[1]!)), `REST batch if_exists update applied a hidden co-tag's defaults (status ${r2.status})`);
    const c = await mcp(`${s.vaultViaHub}/mcp`, writerPass);
    try {
      const said = await c.call("create-note", { path: paths[2], tags: [MINE], content: "edited", if_exists: "update" }).then((x) => JSON.stringify(x).slice(0, 120), (e) => (e as Error).message.slice(0, 120));
      must(!(await leaked(paths[2]!)), `MCP create-note if_exists update applied a hidden co-tag's defaults (${said})`);
    } finally {
      await c.close();
    }
  });

  test("editing a note the operator published through metadata still works, and it stays public (positive control)", async () => {
    const r = await op.post("/notes", { content: `public by metadata ${R}`, path: `${R}/meta-public`, tags: [MINE], metadata: { published: true } });
    expect(r.status).toBe(201);
    const e = await writer.patch(`/notes/${r.body.id}`, { content: `edited ${R}`, if_updated_at: await current(r.body.id) });
    expect(e.status).toBe(200);
    const v = await view(null, `${R}/meta-public`);
    expect(v.status).toBe(200);
    expect(v.text).toContain(`edited ${R}`);
  });

  test("creating with `#mine` works and stores `mine` (positive control)", async () => {
    const r = await writer.post("/notes", { content: "hash spelled", path: `${R}/hash-create`, tags: [`#${MINE}`] });
    expect(r.status).toBe(201);
    expect(await tagsAt(`${R}/hash-create`)).toEqual([MINE]);
  });
});

// Codex round 1: a private tag below the top level (`<run>deep/nested`) hides its string-form sub-tags at any depth,
// on every read: REST get and search, MCP search, /view.
describe("a nested private tag hides its sub-tags from a scoped reader (fix 15)", () => {
  const WORD = `zq${R}nestedword`;
  let hidden = "";
  let open = "";
  beforeAll(async () => {
    hidden = await note(`${R}/nested-child`, `under the private tag ${WORD}`, [MINE, `${NESTED}/child`]);
    open = await note(`${R}/nested-sibling`, `beside it ${WORD}`, [MINE, `${R}deep/open`]);
  });

  test("a note tagged with a sibling of the private tag stays visible (positive control)", async () => {
    expect((await reader.get(`/notes/${open}`)).status).toBe(200);
  });

  test("a note tagged under the nested private tag is hidden on REST get and search, MCP search and /view", async () => {
    const got = await reader.get(`/notes/${hidden}`);
    must(got.status === 404, `REST get served a note under the nested private tag (status ${got.status})`);
    const found = await reader.get(`/notes?search=${WORD}&limit=50`);
    must(!JSON.stringify(found.body).includes(hidden), "REST search returned a note under the nested private tag");
    const c = await mcp(`${s.vaultViaHub}/mcp`, readerPass);
    try {
      const q = JSON.stringify(await c.call("query-notes", { search: WORD, limit: 50 }));
      must(!q.includes(hidden), "MCP search returned a note under the nested private tag");
    } finally {
      await c.close();
    }
    const v = await view(readerPass, hidden);
    must(!v.text.includes(WORD), `/view rendered a note under the nested private tag (status ${v.status})`);
  });
});
