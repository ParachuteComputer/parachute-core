// Renaming a tag carries only its own sub-tags, matched case-sensitively (core#36).
//
// Tag names are case-sensitive everywhere a caller can see them: `Work` and `work` are two tags, a pass scoped to
// one doesn't see the other, a query for one doesn't return the other. Before the fix rename-tag picked the
// sub-tags to carry along with an ASCII-case-insensitive prefix (packages/vault core/src/notes.ts renameTag,
// `instr(lower(name), lower(?))`, kept from the `LIKE` it replaced). So renaming `Work` to `Job`:
//   - also moved `work/sub` (a child of the separate tag `work`) to `Job/sub` and rewrote `#work/sub` in its notes:
//     a write to a tag nobody named;
//   - moved those notes out of reach of a pass scoped to `work`, and into reach of a pass scoped to `Job`;
//   - with both `Work/sub` and `work/sub` present, mapped both to `Job/sub` and answered 500 (UNIQUE tags.name).
// Mutant "rename-tag-case-insensitive" puts the bug back.
//
// Spoken black-box: POST <vault>/api/tags/:name/rename {new_name} (REST) and the `rename-tag` MCP tool, as the
// operator; reads with the operator and with tag-scoped passes through the hub.
import { beforeAll, describe, expect, test } from "bun:test";
import { enc, mcp, must, operator, paths, rest, runId, services } from "../lib.ts";
import { note, pass } from "./_lib.ts";

const s = services();
const op = operator();

/** Each test gets its own made-up tag family, so they can't see each other's renames. */
function family(label: string) {
  const R = runId(label).replace(/-/g, "");
  return { R, Work: `${R}Work`, work: `${R}work`, Job: `${R}Job` };
}

async function noteAt(path: string): Promise<{ content: string; tags: string[] }> {
  const r = await op.get(`/notes/${enc(path)}`);
  if (r.status !== 200) throw new Error(`reading ${path} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return { content: r.body.content, tags: [...(r.body.tags ?? [])].sort() };
}

async function tagNames(R: string): Promise<string[]> {
  const r = await op.get(`/tags`);
  expect(r.status).toBe(200);
  const list: any[] = Array.isArray(r.body) ? r.body : (r.body.tags ?? []);
  return list.map((t) => (typeof t === "string" ? t : t.name)).filter((n: string) => n.startsWith(R)).sort();
}

async function renameRest(from: string, to: string) {
  return op.post(`/tags/${enc(from)}/rename`, { new_name: to });
}

describe("rename-tag carries only the renamed tag's own sub-tags, by exact case", () => {
  test("REST: renaming `Work` moves `Work/mine` and leaves `work/sub` (a child of the other tag `work`) alone", async () => {
    const f = family("rnc");
    await note(`${f.R}/a`, `a #${f.Work}`, [f.Work]);
    await note(`${f.R}/b`, `b #${f.Work}/mine`, [`${f.Work}/mine`]);
    await note(`${f.R}/c`, `c #${f.work}/sub`, [`${f.work}/sub`]);
    await note(`${f.R}/d`, `d #${f.work}`, [f.work]);

    const r = await renameRest(f.Work, f.Job);
    must(r.status === 200, `rename gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);

    expect((await noteAt(`${f.R}/b`)).content).toBe(`b #${f.Job}/mine`);
    const c = await noteAt(`${f.R}/c`);
    must(c.content === `c #${f.work}/sub`, `renaming ${f.Work} rewrote a note of ${f.work}/sub: ${c.content}`);
    must(c.tags.join() === `${f.work}/sub`, `renaming ${f.Work} moved a note of ${f.work}/sub to ${c.tags.join()}`);
    expect(await tagNames(f.R)).toEqual([f.Job, `${f.Job}/mine`, f.work, `${f.work}/sub`].sort());
  });

  test("REST: renaming `Work` succeeds when both `Work/sub` and `work/sub` exist (no 500)", async () => {
    const f = family("rnu");
    await note(`${f.R}/a`, `a #${f.Work}/sub`, [f.Work, `${f.Work}/sub`]);
    await note(`${f.R}/c`, `c #${f.work}/sub`, [`${f.work}/sub`]);

    const r = await renameRest(f.Work, f.Job);
    must(r.status === 200, `rename gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    expect(await tagNames(f.R)).toEqual([f.Job, `${f.Job}/sub`, `${f.work}/sub`].sort());
  });

  test("MCP rename-tag: renaming `Work` leaves `work/sub` alone", async () => {
    const f = family("rnm");
    await note(`${f.R}/b`, `b #${f.Work}/mine`, [f.Work, `${f.Work}/mine`]);
    await note(`${f.R}/c`, `c #${f.work}/sub`, [`${f.work}/sub`]);
    const c = await mcp(`${s.vaultViaHub}/mcp`, s.operatorToken);
    try {
      await c.call("rename-tag", { old_name: f.Work, new_name: f.Job });
    } finally {
      await c.close();
    }
    expect((await noteAt(`${f.R}/b`)).tags).toEqual([f.Job, `${f.Job}/mine`].sort());
    const after = await noteAt(`${f.R}/c`);
    must(after.tags.join() === `${f.work}/sub`, `MCP rename of ${f.Work} moved a note of ${f.work}/sub to ${after.tags.join()}`);
    must(after.content === `c #${f.work}/sub`, `MCP rename of ${f.Work} rewrote a note of ${f.work}/sub: ${after.content}`);
  });
});

describe("renaming a tag doesn't move notes between tag-scoped passes", () => {
  const f = family("rns");
  let workPass: string;
  let jobPass: string;

  beforeAll(async () => {
    await note(`${f.R}/shared`, "shared", [f.Work]);
    await note(`${f.R}/private`, "for work only", [`${f.work}/sub`]);
    workPass = await pass({ level: "read", tags: [f.work] });
    jobPass = await pass({ level: "read", tags: [f.Job] });
  });

  async function seenBy(token: string): Promise<string[]> {
    const r = await rest(s.vaultViaHub, token).get(`/notes?limit=200`);
    expect(r.status).toBe(200);
    const list: any[] = Array.isArray(r.body) ? r.body : (r.body.notes ?? []);
    return paths(list).filter((p) => p.startsWith(`${f.R}/`));
  }

  test("before the rename: a pass scoped to `work` reads `work/sub`'s note; one scoped to `Job` reads nothing (control)", async () => {
    expect(await seenBy(workPass)).toEqual([`${f.R}/private`]);
    expect(await seenBy(jobPass)).toEqual([]);
  });

  test("after renaming `Work` to `Job`: the `work` pass still reads its note, and the `Job` pass gets only `Work`'s", async () => {
    const r = await renameRest(f.Work, f.Job);
    must(r.status === 200, `rename gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    const job = await seenBy(jobPass);
    must(!job.includes(`${f.R}/private`), `after renaming ${f.Work}, a pass scoped to ${f.Job} reads ${f.work}/sub's note`);
    expect(job).toEqual([`${f.R}/shared`]);
    const work = await seenBy(workPass);
    must(work.includes(`${f.R}/private`), `after renaming ${f.Work}, a pass scoped to ${f.work} lost ${f.work}/sub's note`);
  });
});
