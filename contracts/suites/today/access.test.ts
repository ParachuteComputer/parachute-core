// Access, as today's code promises it: a pass scoped to some tags sees exactly the notes that carry one of them,
// on every way of reading, and a wider pass never sees less ("sharing only adds up", in today's terms).
//
// Today the only per-reader limit is a tag-scoped pass (`permissions.scoped_tags`, vault src/tag-scope.ts). The v1
// rule (grants who × what × how much, private notes for exceptions) is in suites/v1/, marked failing until built.
//
// These are property tests: fast-check makes random populations of notes with random tags, and every check runs
// against every pass. A failure prints the seed; rerun with FC_SEED=<seed> to replay it.
import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { enc, mcp, operator, pass, rest, runId, services } from "../lib.ts";

const s = services();
const op = operator();
const R = runId("acc").replace(/-/g, "");
const ROOTS = ["red", "blue", "green"].map((c) => `${R}${c}`);
// Every tag a note can carry: the three roots, a child of red (in scope wherever red is), and nothing.
const TAGS = [...ROOTS, `${ROOTS[0]}/deep`];
const SUBSETS: string[][] = [];
for (let m = 1; m < 1 << ROOTS.length; m++) SUBSETS.push(ROOTS.filter((_, i) => m & (1 << i)));
const key = (tags: string[]) => [...tags].sort().join("+");

const passes = new Map<string, string>();
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : Date.now() % 2 ** 31;

beforeAll(async () => {
  // Seven read passes, one per non-empty set of roots, minted by the hub's own CLI.
  await Promise.all(SUBSETS.map(async (sub) => passes.set(key(sub), await pass({ level: "read", tags: sub }))));
});

/** The rule, written plainly: a note is visible iff one of its tags is under a root the pass names. */
function visibleTo(scope: string[], tags: string[]): boolean {
  return tags.some((t) => scope.includes(t.split("/")[0]!));
}

interface Made {
  id: string;
  path: string;
  tags: string[];
}

/** Make a population: notes with random tags, each linking to every other, each with one past version. */
async function populate(tagSets: string[][], word: string): Promise<Made[]> {
  const prefix = `${runId("acc")}`;
  const made: Made[] = [];
  for (const [i, tags] of tagSets.entries()) {
    const path = `${prefix}/n${i}`;
    const r = await op.post("/notes", { content: `${word} draft ${i}`, path, tags });
    expect(r.status).toBe(201);
    made.push({ id: r.body.id, path, tags });
  }
  for (const [i, n] of made.entries()) {
    const others = made.filter((o) => o !== n).map((o) => `[[${o.path}]]`).join(" ");
    const cur = await op.get(`/notes/${n.id}`);
    const r = await op.patch(`/notes/${n.id}`, {
      content: `${word} note ${i} links ${others}`,
      if_updated_at: cur.body.updatedAt,
    });
    expect(r.status).toBe(200);
  }
  return made;
}

/** Everything a pass can learn about the population, by every read path we know of. */
async function observe(token: string, made: Made[], word: string, prefix: string) {
  const api = rest(s.vaultViaHub, token);
  const seen: Record<string, Set<string>> = {};
  const add = (path: string, ids: string[]) => (seen[path] = new Set(ids.filter((id) => made.some((m) => m.id === id))));

  const tagLeak: string[] = [];
  const listed = (await api.get(`/notes?path_prefix=${enc(prefix)}&limit=500`)).body ?? [];
  const searched = (await api.get(`/notes?search=${word}&limit=500`)).body ?? [];
  for (const n of [...listed, ...searched]) tagLeak.push(...(n.tags ?? []));
  add("list", listed.map((n: any) => n.id));
  add("search", searched.map((n: any) => n.id));
  const got: string[] = [];
  const versions: string[] = [];
  const linked: string[] = [];
  for (const m of made) {
    const g = await api.get(`/notes/${m.id}?include_links=true`);
    expect([200, 404]).toContain(g.status);
    if (g.status === 200) {
      got.push(m.id);
      for (const l of g.body.links ?? []) linked.push(l.sourceId, l.targetId);
      tagLeak.push(...(g.body.tags ?? []));
    }
    const v = await api.get(`/notes/${m.id}/versions`);
    expect([200, 404]).toContain(v.status);
    if (v.status === 200 && v.body.total > 0) versions.push(m.id);
  }
  add("get", got);
  add("versions", versions);
  add("links", linked);
  const client = await mcp(`${s.vaultViaHub}/mcp`, token);
  try {
    const q = await client.call("query-notes", { search: word, limit: 500 });
    const list = Array.isArray(q) ? q : (q.notes ?? q.results ?? []);
    for (const n of list) tagLeak.push(...(n.tags ?? []));
    add("mcp", list.map((n: any) => n.id));
  } finally {
    await client.close();
  }
  return { seen, tagLeak };
}

describe("access with tag-scoped passes (today)", () => {
  test(
    "a scoped pass sees exactly the notes under its tags, on every read path, and a wider pass never sees less",
    async () => {
      const tagSet = fc.subarray(TAGS, { minLength: 0, maxLength: 3 });
      await fc.assert(
        fc.asyncProperty(fc.array(tagSet, { minLength: 4, maxLength: 9 }), async (tagSets) => {
          const word = `zq${runId("w").replace(/[^a-z0-9]/g, "")}`;
          const made = await populate(tagSets, word);
          const prefix = made[0]!.path.split("/")[0]!;
          const views = new Map<string, Record<string, Set<string>>>();
          for (const sub of SUBSETS) {
            const { seen, tagLeak } = await observe(passes.get(key(sub))!, made, word, prefix);
            const expected = made.filter((m) => visibleTo(sub, m.tags)).map((m) => m.id).sort();
            for (const [path, ids] of Object.entries(seen)) {
              // Links may only ever name visible notes; the other paths must show exactly the visible ones.
              // Every note links to every other, so two visible notes means links were seen, and none were hidden.
              if (path === "links") {
                expect([...ids].every((id) => expected.includes(id))).toBe(true);
                if (expected.length >= 2) expect(ids.size).toBeGreaterThanOrEqual(2);
              }
              else expect({ pass: sub, path, ids: [...ids].sort() }).toEqual({ pass: sub, path, ids: expected });
            }
            // A visible note never reveals the out-of-scope tags it also carries (on get, list, search or MCP).
            expect(tagLeak.filter((t) => TAGS.includes(t) && !visibleTo(sub, [t]))).toEqual([]);
            views.set(key(sub), seen);
          }
          // Adds up: for every pair of passes S ⊆ T, what S sees ⊆ what T sees, path by path.
          for (const a of SUBSETS)
            for (const b of SUBSETS) {
              if (!a.every((t) => b.includes(t))) continue;
              for (const [path, ids] of Object.entries(views.get(key(a))!)) {
                const wider = views.get(key(b))![path]!;
                expect({ narrower: a, wider: b, path, missing: [...ids].filter((id) => !wider.has(id)) }).toEqual({
                  narrower: a,
                  wider: b,
                  path,
                  missing: [],
                });
              }
            }
        }),
        {
          numRuns: Number(process.env.FC_RUNS ?? 6),
          seed,
          endOnFailure: true,
          // Always tried first: an untagged note, each root alone, a child tag, and a note under two roots.
          examples: [[[[], [ROOTS[0]!], [ROOTS[1]!], [ROOTS[2]!], [TAGS[3]!], [ROOTS[1]!, ROOTS[2]!]]]],
        },
      );
    },
    120_000,
  );

  test("a scoped pass cannot change or delete a note it cannot see, and is told it doesn't exist", async () => {
    const [red, blue] = ROOTS;
    const hidden = await op.post("/notes", { content: "blue only", path: `${runId("acc")}/hidden`, tags: [blue] });
    const writer = rest(s.vaultViaHub, await pass({ level: "write", tags: [red!] }));
    const up = await writer.patch(`/notes/${hidden.body.id}`, { content: "overwritten", force: true });
    expect(up.status).toBe(404);
    expect((await writer.del(`/notes/${hidden.body.id}`)).status).toBe(404);
    expect((await op.get(`/notes/${hidden.body.id}`)).body.content).toBe("blue only");
  });

  test("a scoped writer can only create notes inside its scope", async () => {
    const [red, blue] = ROOTS;
    const writer = rest(s.vaultViaHub, await pass({ level: "write", tags: [red!] }));
    expect((await writer.post("/notes", { content: "x", path: `${runId("acc")}/out`, tags: [blue] })).status).toBe(403);
    expect((await writer.post("/notes", { content: "x", path: `${runId("acc")}/none` })).status).toBe(403);
    expect((await writer.post("/notes", { content: "x", path: `${runId("acc")}/in`, tags: [`${red}/deep`] })).status).toBe(
      201,
    );
  });

  test("a read pass cannot write, over REST or MCP", async () => {
    const reader = await pass({ level: "read" });
    const r = await rest(s.vaultViaHub, reader).post("/notes", { content: "x", path: `${runId("acc")}/ro` });
    expect(r.status).toBe(403);
    const client = await mcp(`${s.vaultViaHub}/mcp`, reader);
    try {
      const tools = await client.tools();
      expect(tools).toContain("query-notes");
      expect(tools).not.toContain("create-note");
      await expect(client.call("create-note", { content: "x", path: `${runId("acc")}/ro-mcp` })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
