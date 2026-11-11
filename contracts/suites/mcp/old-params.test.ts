// mcp/old-params: every parameter 0.8 listed in tools/list still works on 0.9, under both names (T-456).
// 0.9's tool list is short (mcp/budget: query-records under 1,500 tokens), so 28 parameters 0.8 listed are no longer
// in it: 25 on query-notes and the three history-paging ones on doctor. The 2026-11-11 shadow (0.8 twin vs 0.9 on a
// copy of a real home) flagged each one. They are not dropped: each is in the tool's full reference
// (vault-info {help}), the short description says where to find them, and each is honoured, on query-notes (a
// connector made on 0.8) and on query-records (a new chat) alike. changes-0.9.json says so in one row per tool.
// Each check below is a call whose answer changes when the parameter is honoured, so a 0.9 that ignored or refused
// one goes red. Made-up notes only.
import { describe, expect, test } from "bun:test";
import { mcp, runId, services } from "../lib.ts";

const QUERY = [
  "created_by", "created_via", "excludePathPrefix", "excludeTags", "exclude_path_prefix", "exclude_tag", "expand",
  "expand_depth", "expand_links", "expand_mode", "extension", "has_ambiguous_links", "has_broken_links", "has_links",
  "has_tags", "include_ambiguous_links", "include_broken_links", "include_link_count", "last_updated_by",
  "last_updated_via", "link_count_direction", "near_text", "order_by", "search_mode", "semantic",
];
const DOCTOR = ["history_after", "history_max_blobs", "history_budget_ms"];

async function admin() {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, s.operatorToken);
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.notes ?? r?.records ?? []));

describe("mcp/old-params", () => {
  test("the 28 are out of the short tool list but in vault-info {help}, on both names", async () => {
    const c = await admin();
    const listed = Object.fromEntries((await c.client.listTools()).tools.map((t) => [t.name, Object.keys((t.inputSchema as any).properties ?? {})]));
    for (const [tool, params] of [["query-notes", QUERY], ["query-records", QUERY], ["doctor", DOCTOR]] as const) {
      const help = await c.call("vault-info", { help: tool });
      expect(Object.keys(help.parameters.properties)).toEqual(expect.arrayContaining([...params]));
      // If one comes back into the short list, this row of changes-0.9.json is out of date: update both.
      expect(params.filter((p) => (listed[tool] ?? []).includes(p))).toEqual([]);
    }
    await c.close();
  });

  test("each query-notes parameter is honoured on query-notes and on query-records", async () => {
    const c = await admin();
    const P = runId("oldp");
    const T = runId("oldtag").replace(/-/g, "_");
    const twin = runId("twin");
    const make = async (path: string, content: string, tags: string[] = [], metadata?: object) =>
      (await c.call("create-note", { path, content, tags, ...(metadata ? { metadata } : {}) })).id as string;
    // Targets first, so each [[link]] resolves as it is written.
    await make(`${P}/g`, "deep gamma words", [T]);
    await make(`${P}/b`, `plain orchard words [[${P}/g]]`, [], { summary: "BEE SUMMARY" });
    await make(`${P}/one/${twin}`, "first twin", [T]);
    await make(`${P}/two/${twin}`, "second twin", [T]);
    await make(`${P}/a`, `see [[${P}/b]] and [[${P}/missing-${twin}]]`, [T]);
    await make(`${P}/e`, `which one: [[${twin}]]`, [T]);
    await make(`${P}/f`, `also [[${P}/b]]`, [T]);
    // A declared subtype of T (parent_names), so `expand` has something to include or leave out.
    const KID = `${T}_kid`;
    await c.call("update-tag", { tag: KID, parent_names: [T] });
    await make(`${P}/sub/c`, "kid words", [KID]);

    const short = (path: string) => path.slice(P.length + 1);
    const base = { path_prefix: `${P}/`, limit: 100 };
    // Both names, the same question: the paths each answers (note door and record door must agree).
    async function both(args: Record<string, unknown>, recordArgs: Record<string, unknown> = args) {
      const n = rows(await c.call("query-notes", { ...base, ...args }));
      const r = rows(await c.call("query-records", { ...base, ...recordArgs }));
      const ps = (xs: any[]) => xs.map((x) => short(x.path)).sort();
      expect(ps(r)).toEqual(ps(n));
      return { paths: ps(n), notes: n, records: r };
    }
    const all = (await both({})).paths;
    expect(all).toHaveLength(8);
    const without = (...drop: string[]) => all.filter((p) => !drop.includes(p));

    // Filters: each answer is a strict subset that a 0.9 ignoring the parameter would not give.
    expect((await both({ exclude_tag: KID })).paths).toEqual(without("sub/c"));
    expect((await both({ excludeTags: [KID] })).paths).toEqual(without("sub/c"));
    expect((await both({ exclude_path_prefix: `${P}/sub/` })).paths).toEqual(without("sub/c"));
    expect((await both({ excludePathPrefix: `${P}/sub/` })).paths).toEqual(without("sub/c"));
    expect((await both({ extension: "csv" })).paths).toEqual([]);
    expect((await both({ extension: "md" })).paths).toEqual(all);
    expect((await both({ has_tags: false })).paths).toEqual(["b"]);
    expect((await both({ has_links: false })).paths).toEqual(expect.arrayContaining([`one/${twin}`, `two/${twin}`, "sub/c"]));
    expect((await both({ has_links: false })).paths).not.toContain("b");
    expect((await both({ has_broken_links: true })).paths).toEqual(["a"]);
    expect((await both({ has_ambiguous_links: true })).paths).toEqual(["e"]);
    for (const p of ["created_by", "last_updated_by", "created_via", "last_updated_via"]) {
      expect((await both({ [p]: `nobody-${twin}` })).paths).toEqual([]);
    }
    // expand: `exact` leaves out the subtype that the default (`subtypes`) takes in.
    expect((await both({ tag: T })).paths).toContain("sub/c");
    expect((await both({ tag: T, expand: "exact" })).paths).not.toContain("sub/c");

    // Fields added to each answer.
    const a = (r: { notes: any[]; records: any[] }) => [r.notes.find((x) => short(x.path) === "a"), r.records.find((x) => short(x.path) === "a")];
    for (const x of a(await both({ include_broken_links: true }))) expect(x.broken_links).toEqual([expect.objectContaining({ target: `${P}/missing-${twin}` })]);
    const e = await both({ include_ambiguous_links: true });
    for (const x of [...e.notes, ...e.records].filter((x) => short(x.path) === "e")) expect(x.ambiguous_links?.[0]?.candidate_count).toBeGreaterThanOrEqual(2);
    const degree = async (direction?: string) => {
      const r = await both({ include_link_count: true, ...(direction ? { link_count_direction: direction } : {}) });
      return [...r.notes, ...r.records].filter((x) => short(x.path) === "b").map((x) => x.linkCount);
    };
    expect(await degree()).toEqual([3, 3]); // a and f link in, b links out to g
    expect(await degree("inbound")).toEqual([2, 2]);
    expect(await degree("outbound")).toEqual([1, 1]);
    expect(short(rows(await c.call("query-notes", { ...base, order_by: "link_count", sort: "desc" }))[0].path)).toBe("b");
    expect(short(rows(await c.call("query-records", { ...base, order_by: "link_count", sort: "desc" }))[0].path)).toBe("b");

    // Link expansion in the text: full inlines the linked note, a second hop with expand_depth 2, summary its summary.
    const text = async (args: Record<string, unknown>) => {
      const n = (await c.call("query-notes", { id: `${P}/a`, include_content: true, ...args })) as any;
      const r = (await c.call("query-records", { id: `${P}/a`, include_body: true, ...args })) as any;
      return [(Array.isArray(n) ? n[0] : n).content as string, (Array.isArray(r) ? r[0] : r).body as string];
    };
    for (const t of await text({})) expect(t).not.toContain("orchard");
    for (const t of await text({ expand_links: true })) expect(t).toContain("orchard");
    for (const t of await text({ expand_links: true, expand_depth: 1 })) expect(t).not.toContain("deep gamma");
    for (const t of await text({ expand_links: true, expand_depth: 2 })) expect(t).toContain("deep gamma");
    for (const t of await text({ expand_links: true, expand_mode: "summary" })) {
      expect(t).toContain("BEE SUMMARY");
      expect(t).not.toContain("orchard");
    }

    // Search: `advanced` reads FTS syntax that the default (literal) escapes.
    expect((await both({ search: "orchard OR gamma" })).paths).toEqual([]);
    expect((await both({ search: "orchard OR gamma", search_mode: "advanced" })).paths).toEqual(["b", "g"]);

    // Semantic search is read, not ignored: near_text alone is answered with a warning naming semantic: true,
    // semantic alone is refused naming near_text.
    for (const tool of ["query-notes", "query-records"]) {
      expect(JSON.stringify(await c.call(tool, { ...base, near_text: "fruit trees" }))).toContain("`semantic: true` is required to activate near_text");
      await expect(c.call(tool, { ...base, semantic: true })).rejects.toThrow(/near_text/);
    }
    await c.close();
  });

  test("doctor's history paging parameters are honoured", async () => {
    const c = await admin();
    await expect(c.call("doctor", { deep: true, history_max_blobs: 501 })).rejects.toThrow(/history_max_blobs/);
    await expect(c.call("doctor", { deep: true, history_budget_ms: 0 })).rejects.toThrow(/history_budget_ms/);
    await expect(c.call("doctor", { deep: true, history_after: 5 })).rejects.toThrow(/history_after/);
    const ok = await c.call("doctor", { deep: true, history_max_blobs: 1, history_budget_ms: 50 });
    expect(ok).toBeTruthy();
    await c.close();
  });
});
