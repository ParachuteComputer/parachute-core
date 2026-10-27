// Fixes 6 and 15 (G2): a tag-scoped writer can't add a tag it doesn't hold, `publish` and private tags included.
//
// Today a scoped write passes if the note ends up with ONE tag in scope (vault src/tag-scope.ts:382-396,
// tagsWithinScope returns on the first allowed tag), so the writer may add any other tag; this is deliberate per
// vault#568 (src/routes.ts:3217-3221). Adding `publish` makes the note public on /view. The check ignores the
// vault's `private_tags` (fix 15). PLAN §5 fixes 6 and 15, §7.5 mutant "G2: an added tag kept". Lane F.
// It changes what a contract means (Aaron's or Benjamin's call, default yes, PLAN §5).
//
// `private_tags` can only be set in the vault's vault.yaml (vault src/config.ts:682-770; no HTTP or CLI door sets
// it), so this file sets it the way an operator does: by editing $PARACHUTE_HOME/vault/data/<vault>/vault.yaml.
// The vault reads it on every scoped request. The original file is put back afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enc, must, operator, red, rest, runId, services } from "../lib.ts";
import { note, pass, view } from "./_lib.ts";

const s = services();
const op = operator();
const R = runId("sw").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const PRIVATE = `${R}private`;
const yamlPath = join(s.home, "vault", "data", s.vaultName, "vault.yaml");
let yamlBefore: string | null = null;
let writer: ReturnType<typeof rest>;
let reader: ReturnType<typeof rest>;

beforeAll(async () => {
  writer = rest(s.vaultViaHub, await pass({ level: "write", tags: [MINE] }));
  reader = rest(s.vaultViaHub, await pass({ level: "read", tags: [MINE] }));
  yamlBefore = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : null;
  if (yamlBefore !== null && /^private_tags\s*:/m.test(yamlBefore)) throw new Error("setup: the box's vault.yaml already sets private_tags");
  writeFileSync(yamlPath, `${(yamlBefore ?? `name: ${s.vaultName}\n`).replace(/\n*$/, "\n")}private_tags: [${PRIVATE}]\n`);
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

  red("on create, a scoped writer can't add a tag outside its scope", { reason: /kept an added tag outside the writer's scope/, lane: "F" }, async () => {
    const path = `${R}/create-other`;
    const r = await writer.post("/notes", { content: "smuggled", path, tags: [MINE, OTHER] });
    must(!(await tagsAt(path))?.includes(OTHER), `create kept an added tag outside the writer's scope (status ${r.status})`);
  });

  red("on create, a scoped writer can't add publish (so can't make a note public)", { reason: /kept an added tag outside the writer's scope: publish/, lane: "F" }, async () => {
    const path = `${R}/create-publish`;
    const r = await writer.post("/notes", { content: `made public ${R}`, path, tags: [MINE, "publish"] });
    const pub = await view(null, path);
    must(!(await tagsAt(path))?.includes("publish"), `create kept an added tag outside the writer's scope: publish (status ${r.status}; anonymous /view ${pub.status})`);
    expect(pub.status).toBe(404);
  });

  red("on create, a scoped writer can't add a private tag", { reason: /kept an added private tag/, lane: "F" }, async () => {
    const path = `${R}/create-private`;
    const r = await writer.post("/notes", { content: "into the private tag", path, tags: [MINE, PRIVATE] });
    must(!(await tagsAt(path))?.includes(PRIVATE), `create kept an added private tag (status ${r.status})`);
  });

  red("on update, a scoped writer can't add a tag outside its scope, publish included", { reason: /kept an added tag outside the writer's scope/, lane: "F" }, async () => {
    for (const tag of [OTHER, "publish"]) {
      const id = await note(`${R}/update-${tag === "publish" ? "publish" : "other"}`, "mine only", [MINE]);
      const r = await writer.patch(`/notes/${id}`, { tags: { add: [tag] }, if_updated_at: await current(id) });
      const tags = (await op.get(`/notes/${id}`)).body.tags as string[];
      must(!tags.includes(tag), `update kept an added tag outside the writer's scope: ${tag === "publish" ? "publish" : "other"} (status ${r.status})`);
    }
  });

  red("on update, a scoped writer can't add a private tag", { reason: /kept an added private tag/, lane: "F" }, async () => {
    const id = await note(`${R}/update-private`, "mine only", [MINE]);
    const r = await writer.patch(`/notes/${id}`, { tags: { add: [PRIVATE] }, if_updated_at: await current(id) });
    const tags = (await op.get(`/notes/${id}`)).body.tags as string[];
    must(!tags.includes(PRIVATE), `update kept an added private tag (status ${r.status})`);
  });
});
