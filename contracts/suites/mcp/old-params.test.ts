// mcp/old-params: every parameter 0.8 listed in tools/list still works on 0.9, under both names (T-456).
// 0.9's tool list is short (mcp/budget: query-records under 1,500 tokens), so 28 parameters 0.8 listed are no longer
// in it: 25 on query-notes and the three history-paging ones on doctor. The 2026-11-11 shadow (0.8 twin vs 0.9 on a
// copy of a real home) flagged each one. They are not dropped: each is in the tool's full reference
// (vault-info {help}), the short description says where to find them, and each is honoured, on query-notes (a
// connector made on 0.8) and on query-records (a new chat) alike. changes-0.9.json says so in one row per tool.
// Each check below is a call whose answer changes when the parameter is honoured, so a 0.9 that ignored or refused
// one goes red. Made-up notes only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcp, runId, safeFetch, services } from "../lib.ts";

const QUERY = [
  "created_by", "created_via", "excludePathPrefix", "excludeTags", "exclude_path_prefix", "exclude_tag", "expand",
  "expand_depth", "expand_links", "expand_mode", "extension", "has_ambiguous_links", "has_broken_links", "has_links",
  "has_tags", "include_ambiguous_links", "include_broken_links", "include_link_count", "last_updated_by",
  "last_updated_via", "link_count_direction", "near_text", "order_by", "search_mode", "semantic",
];
// Back in the short list on purpose (0.9.3 hybrid search: `search_mode` carries "hybrid"). Still checked in the full
// reference and for being honoured; just not required to be absent from tools/list.
const LISTED_AGAIN = ["search_mode"];
const DOCTOR = ["history_after", "history_max_blobs", "history_budget_ms"];
// The twelve more (#82): 0.8 listed them on the write tools, and the review of #81 found no row and no test for them.
const WRITE_TOOLS: Record<string, string[]> = {
  "create-note": ["extension", "summary"],
  "delete-tag": ["cascade"],
  "rename-tag": ["from", "tag", "to"],
  "request-attachment-upload": ["segment_index"],
  "update-note": ["created_at", "extension", "include_content", "include_links", "state_transition"],
};

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
      expect(listed[tool]).toBeDefined();
      expect(params.filter((p) => !LISTED_AGAIN.includes(p) && listed[tool]!.includes(p))).toEqual([]);
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

  test("every 0.8-listed parameter named in this file has a keep row in changes-0.9.json", () => {
    const rows: any[] = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/cli/src/changes-0.9.json"), "utf8")).changes;
    const kept = (tool: string, param: string) =>
      rows.some((r) => r.kind === "mcp-tool" && r.action === "keep" && typeof r.old === "string" && r.old.startsWith(`${tool} {`) && new RegExp(`[{ ,]${param}[,} ]`).test(r.old.split("}")[0] + "}"));
    const missing = [
      ...Object.entries({ "query-notes": QUERY, doctor: DOCTOR }),
      ...Object.entries(WRITE_TOOLS),
    ].flatMap(([tool, params]) => params.filter((p) => !kept(tool, p)).map((p) => `${tool} {${p}}`));
    expect(missing).toEqual([]);
  });

  test("the twelve are out of the short tool list but in vault-info {help}, on the old names and the new", async () => {
    const c = await admin();
    const listed = Object.fromEntries((await c.client.listTools()).tools.map((t) => [t.name, Object.keys((t.inputSchema as any).properties ?? {})]));
    const also: Record<string, string[]> = {
      "create-record": WRITE_TOOLS["create-note"]!,
      "update-record": WRITE_TOOLS["update-note"]!,
    };
    for (const [tool, params] of [...Object.entries(WRITE_TOOLS), ...Object.entries(also)]) {
      const help = await c.call("vault-info", { help: tool });
      const wanted = params;
      expect(Object.keys(help.parameters.properties)).toEqual(expect.arrayContaining(wanted));
      // If one comes back into the short list, its row of changes-0.9.json is out of date: update both.
      expect(listed[tool]).toBeDefined();
      expect(wanted.filter((p) => listed[tool]!.includes(p))).toEqual([]);
    }
    // manage-types and attachment-url list each action's parameters under the tool it replaces.
    const acts = async (tool: string, action: string) => Object.keys((await c.call("vault-info", { help: tool })).actions[action].parameters.properties);
    expect(await acts("manage-types", "delete")).toEqual(expect.arrayContaining(["cascade"]));
    expect(await acts("manage-types", "rename")).toEqual(expect.arrayContaining(["from", "tag", "to"]));
    expect(await acts("attachment-url", "upload")).toEqual(expect.arrayContaining(["segment_index"]));
    await c.close();
  });

  test("create-note extension and summary, update-note's seven, on the note tools and the record tools", async () => {
    const c = await admin();
    const P = runId("oldw");
    const ids = (x: any) => (Array.isArray(x) ? x : (x.notes ?? x.records ?? [x])).map((n: any) => n.id);
    // create-note {extension}: the note is a csv, found by the extension filter, not an md. Same on create-record.
    for (const [tool, n] of [["create-note", 1], ["create-record", 2]] as const) {
      const made: any = await c.call(tool, { path: `${P}/data-${n}`, content: "a,b\n1,2", extension: "csv" });
      expect(made.extension).toBe("csv");
      expect(ids(await c.call("query-notes", { path_prefix: `${P}/data-${n}`, extension: "csv" }))).toEqual([made.id]);
      expect(ids(await c.call("query-notes", { path_prefix: `${P}/data-${n}`, extension: "md" }))).toEqual([]);
    }
    // create-note {summary: true} on a batch: {created, ids, failed} in place of the notes. A single note ignores it.
    for (const [tool, key] of [["create-note", "notes"], ["create-record", "records"]] as const) {
      const sum: any = await c.call(tool, { [key]: [{ path: `${P}/s1-${tool}`, content: "one" }, { path: `${P}/s2-${tool}`, content: "two" }], summary: true });
      expect(sum.created).toBe(2);
      expect(sum.ids).toHaveLength(2);
      expect(sum.failed).toEqual([]);
      expect(sum.content ?? sum.body).toBeUndefined();
      const one: any = await c.call(tool, { path: `${P}/s3-${tool}`, content: "three", summary: true });
      expect(one.created).toBeUndefined();
      expect(one.path).toBe(`${P}/s3-${tool}`);
    }

    // update-note: each parameter changes the answer or the stored note. Same on update-record.
    for (const [tool, body] of [["update-note", "content"], ["update-record", "body"]] as const) {
      const made: any = await c.call("create-note", { path: `${P}/u-${tool}`, content: "first words", metadata: { status: "todo" } });
      const id = made.id;
      const target: any = await c.call("create-note", { path: `${P}/t-${tool}`, content: "target" });
      const when = "2020-01-02T03:04:05.000Z";

      // created_at, extension: written, then read back.
      await c.call(tool, { id, created_at: when, extension: "txt", force: true, include_content: false });
      const back: any = await c.call("query-notes", { id, include_content: false });
      expect(new Date((Array.isArray(back) ? back[0] : back).createdAt).toISOString()).toBe(when);
      expect((Array.isArray(back) ? back[0] : back).path).toBe(`${P}/u-${tool}`);
      expect(ids(await c.call("query-notes", { path_prefix: `${P}/u-${tool}`, extension: "txt" }))).toEqual([id]);

      // include_content: the full shape by default, the lean index shape (no content, a preview) when false.
      const full: any = await c.call(tool, { id, force: true, tags: { add: [`${P}_x`] } });
      expect(full[body]).toBe("first words");
      const lean: any = await c.call(tool, { id, force: true, tags: { add: [`${P}_y`] }, include_content: false });
      expect(lean[body]).toBeUndefined();
      expect(lean.preview).toBe("first words");

      // include_links: the link set rides the answer only when asked for (nothing here touches links).
      await c.call(tool, { id, force: true, links: { add: [{ target: target.id, relationship: "mentions" }] } });
      const noLinks: any = await c.call(tool, { id, force: true, tags: { add: [`${P}_z`] } });
      expect(noLinks.links).toBeUndefined();
      const withLinks: any = await c.call(tool, { id, force: true, tags: { add: [`${P}_z`] }, include_links: true });
      expect(JSON.stringify(withLinks.links)).toContain(target.id);

      // state_transition: compare-and-set. It commits once; the second call, with the old `from`, conflicts.
      const flip = { field: "status", from: "todo", to: "done" };
      const moved: any = await c.call(tool, { id, state_transition: flip });
      expect(moved.metadata?.status ?? moved.fields?.status).toBe("done");
      await expect(c.call(tool, { id, state_transition: flip })).rejects.toThrow(/transition_conflict/);
      const now: any = await c.call("query-notes", { id });
      expect((Array.isArray(now) ? now[0] : now).metadata.status).toBe("done");
    }
    await c.close();
  });

  test("delete-tag {cascade} and rename-tag {from, tag, to} on the old names and on manage-types", async () => {
    const c = await admin();
    const T = runId("oldt").replace(/-/g, "_");
    const tags = async () => (await c.call("list-tags", {})) as any;
    const names = async () => (Array.isArray(await tags()) ? await tags() : (await tags()).tags).map((t: any) => t.name ?? t.tag);

    // cascade: a tag another tag names as its parent is refused, then deleted with the reference stripped.
    for (const [label, call] of [
      ["delete-tag", (tag: string) => c.call("delete-tag", { tag, cascade: true })],
      ["manage-types", (tag: string) => c.call("manage-types", { action: "delete", tag, cascade: true })],
    ] as const) {
      const parent = `${T}_p_${label.replace("-", "_")}`;
      const kid = `${T}_k_${label.replace("-", "_")}`;
      await c.call("update-tag", { tag: parent });
      await c.call("update-tag", { tag: kid, parent_names: [parent] });
      expect(((await c.call("delete-tag", { tag: parent })) as any).error).toBe("tag_referenced_as_parent");
      expect(await names()).toContain(parent);
      const gone: any = await call(parent);
      expect(JSON.stringify(gone)).toContain("parent_refs_detached");
      expect(await names()).not.toContain(parent);
      expect(await names()).toContain(kid);
    }

    // from / tag / to: three ways to name the same rename, each moving a note's tag.
    const cases: [string, Record<string, string>][] = [
      ["rename-tag", { from: "a", to: "b" }],
      ["rename-tag", { tag: "a", to: "b" }],
      ["rename-tag", { old_name: "a", new_name: "b" }],
      ["manage-types", { action: "rename", from: "a", to: "b" }],
      ["manage-types", { action: "rename", tag: "a", to: "b" }],
    ];
    let i = 0;
    for (const [tool, args] of cases) {
      const a = `${T}_a${i}`;
      const b = `${T}_b${i}`;
      i++;
      const note: any = await c.call("create-note", { path: `${T}/r${i}`, content: "x", tags: [a] });
      const call = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === "a" ? a : v === "b" ? b : v]));
      await c.call(tool, call);
      const moved = await c.call("query-notes", { id: note.id });
      expect((Array.isArray(moved) ? moved[0] : moved).tags).toEqual([b]);
      expect(await names()).not.toContain(a);
    }
    await c.close();
  });

  test("request-attachment-upload {segment_index} reaches the stored attachment, on both names", async () => {
    const c = await admin();
    const P = runId("oldseg");
    const note: any = await c.call("create-note", { path: `${P}/rec`, content: "a recording" });
    const bytes = new Uint8Array(64).fill(3);
    for (const [tool, base, seg] of [["request-attachment-upload", { note: note.id }, 2], ["attachment-url", { action: "upload", record: note.id }, 5]] as const) {
      const ticket: any = await c.call(tool, { ...base, filename: `part-${seg}.m4a`, mime_type: "audio/mp4", size_bytes: bytes.length, transcribe: true, segment_index: seg });
      const put = await safeFetch(ticket.url, { method: ticket.method ?? "PUT", headers: { "content-type": "audio/mp4" }, body: bytes });
      expect(put.status).toBeLessThan(300);
    }
    const got: any = await c.call("query-notes", { id: note.id, include_attachments: true });
    const atts = (Array.isArray(got) ? got[0] : got).attachments as any[];
    const segs = atts.map((a) => a.metadata?.segment_index).sort();
    expect(segs).toEqual([2, 5]);
    // A malformed one is ignored, as 0.8 documented (the part-less marker), never an error.
    const bad: any = await c.call("request-attachment-upload", { note: note.id, filename: "x.m4a", mime_type: "audio/mp4", size_bytes: bytes.length, transcribe: true, segment_index: -1 });
    expect((await safeFetch(bad.url, { method: bad.method ?? "PUT", headers: { "content-type": "audio/mp4" }, body: bytes })).status).toBeLessThan(300);
    const after: any = await c.call("query-notes", { id: note.id, include_attachments: true });
    const withSeg = (Array.isArray(after) ? after[0] : after).attachments.filter((a: any) => a.metadata?.segment_index !== undefined);
    expect(withSeg).toHaveLength(2);
    await c.close();
  });
});
