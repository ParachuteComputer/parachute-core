// mcp/records: "record" is the noun (Aaron, 11-07; T-407). The record tools speak record words over the same data:
//   - query-records, create-record, update-record, delete-record, list-types; a record's text is `body`, its data
//     `fields`, a batch `records`, an anchor `{id}`; it carries `types` (several allowed) and `tags` (plain labels only).
//   - The note-named tools answer exactly as on 0.8 (content, metadata, every name in `tags`), through 0.9.
//   - Old parameter names still work on the record tools; beside their new name they're refused.
//   - A person's own field names are data: a field called `content` or `notes` is never renamed, either way.
//   - Each use of an old name, MCP or a /api/notes route, is counted by name in the home's run/deprecations.json
//     (the usage log 1.0's removals wait on), and each record name under `adopted`. Names and counts, never values.
// Red on 0.8 and on #21 before T-407 (no record tools, no counts); green from packages/vault/core/src/mcp-records.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mcp, pass, rest, runId, services } from "../lib.ts";

async function session(level: "read" | "write" | "admin") {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, level === "admin" ? s.operatorToken : await pass({ level }));
}
const one = (r: any) => (Array.isArray(r) ? r[0] : r);

describe("mcp/records", () => {
  test("a record made with record words reads back in record words, and in note words through the old tool", async () => {
    const c = await session("admin");
    const type = runId("trip").replace(/-/g, "_");
    const miles = `${type}_miles`;
    await c.call("manage-types", { tag: type, fields: { [miles]: { type: "integer", indexed: true } } });
    const path = `records/${runId("r")}`;
    const made = await c.call("create-record", { path, types: [type], tags: ["pinned"], fields: { [miles]: 12, content: "a field of mine", notes: 2 }, body: "Drove north." });
    expect(made.body).toBe("Drove north.");
    expect(made.content).toBeUndefined();

    const r = one(await c.call("query-records", { id: path }));
    expect(r.body).toBe("Drove north.");
    expect(r.fields).toEqual({ [miles]: 12, content: "a field of mine", notes: 2 });
    expect(r.types).toEqual([type]);
    expect(r.tags).toEqual(["pinned"]); // labels only: the type isn't repeated
    expect(r).not.toHaveProperty("metadata");

    const n = one(await c.call("query-notes", { id: path }));
    expect(n.content).toBe("Drove north.");
    expect(n.metadata).toEqual({ [miles]: 12, content: "a field of mine", notes: 2 });
    expect([...n.tags].sort()).toEqual(["pinned", type].sort()); // 0.8's shape: every name on the note
    expect(n).not.toHaveProperty("body");
    expect(n).not.toHaveProperty("deprecation");

    // Filters by type and by an indexed field, in record words; lists come back as records.
    const list = await c.call("query-records", { type, fields: { [miles]: { gte: 10 } }, include_body: true });
    expect(list.map((x: any) => x.path)).toEqual([path]);
    expect(list[0].body).toBe("Drove north.");
    const page = await c.call("query-records", { type, cursor: "" });
    expect(page.records.map((x: any) => x.path)).toEqual([path]);
    expect(page).not.toHaveProperty("notes");

    // list-types {name} reads one type.
    const t = await c.call("list-types", { name: type });
    expect(t.kind).toBe("type");
    expect(Object.keys(t.fields)).toEqual([miles]);
    await c.close();
  });

  test("update-record and delete-record, in batches too; anchors take {id}", async () => {
    const c = await session("write");
    const a = `records/${runId("a")}`;
    const b = `records/${runId("b")}`;
    const made = await c.call("create-record", { records: [{ path: b, body: "end" }, { path: a, body: `start, then [[${b}]]` }] });
    expect(made.map((x: any) => x.path).sort()).toEqual([a, b].sort());

    const read = one(await c.call("query-records", { id: a }));
    const changed = await c.call("update-record", { id: a, body_edit: { old_text: "start", new_text: "begin" }, fields: { k: 1 }, if_updated_at: read.updatedAt });
    expect(changed.body).toBe(`begin, then [[${b}]]`);
    expect(changed.fields).toEqual({ k: 1 });

    const near = await c.call("query-records", { near: { id: a, depth: 1 } });
    expect(near.map((x: any) => x.path)).toContain(b);
    const versions = await c.call("query-records", { versions: { id: a } });
    expect(versions.versions.length).toBeGreaterThan(0);

    await c.call("update-record", { records: [{ id: a, append: " more" }, { id: b, append: " more" }] });
    expect(one(await c.call("query-records", { id: b })).body).toBe("end more");

    expect((await c.call("delete-record", { id: b })).deleted).toBe(true);
    expect((await c.call("query-records", { id: b })).error_type).toBe("not_found");
    await c.close();
  });

  test("old parameter names still work on the record tools; beside the new name they're refused; errors teach in record words", async () => {
    const c = await session("write");
    const path = `records/${runId("old")}`;
    const made = await c.call("create-record", { path, content: "old word", metadata: { x: 1 } });
    expect(made.body).toBe("old word");
    expect(made.fields).toEqual({ x: 1 });
    const near = await c.call("query-records", { near: { note_id: path, depth: 1 } }); // the old anchor name
    expect(Array.isArray(near)).toBe(true);
    await expect(c.call("create-record", { path: `${path}-2`, body: "a", content: "b" })).rejects.toThrow(/pass `body` or `content`, not both/);
    await expect(c.call("query-records", { near: { note: path } })).rejects.toThrow(/near takes \{id\}, not \{note\}/);
    const ignored = await c.call("query-records", { tags: "x", limit: 1 });
    expect(ignored.warnings).toContainEqual(expect.objectContaining({ code: "unknown_parameter", field: "tags", hint: "use tag" }));
    expect(ignored.warnings.find((w: any) => w.code === "unknown_parameter").message).toMatch(/^query-records has no parameter `tags`/);
    await expect(c.call("update-record", { record_id: "x", append: "y" })).rejects.toThrow(/Did you mean `id`/);
    await c.close();
  });

  test("a writer's list: record tools first, each note tool after it marked deprecated with the record name", async () => {
    const c = await session("write");
    const tools = (await c.client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const [old, fresh] of [["query-notes", "query-records"], ["create-note", "create-record"], ["update-note", "update-record"], ["delete-note", "delete-record"], ["list-tags", "list-types"]]) {
      expect(names.indexOf(fresh)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(old)).toBeGreaterThan(names.indexOf(fresh));
      expect(tools.find((t) => t.name === old)!.description).toStartWith(`Deprecated (gone in 1.0): use ${fresh}.`);
    }
    const create = tools.find((t) => t.name === "create-record")!;
    expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["body", "fields", "types", "tags", "records"]));
    expect(Object.keys(create.inputSchema.properties ?? {})).not.toContain("content");
    // The instructions name the record tools, and never a note-named tool.
    const ins = c.client.getInstructions() ?? "";
    expect(ins).toContain("query-records");
    expect(ins).not.toMatch(/query-notes|create-note|update-note|request-attachment-(upload|download)/);
    await c.close();
  });

  test("each old name used is counted by name in the usage log, and each record name under adopted", async () => {
    const s = services();
    const c = await session("write");
    const path = `records/${runId("count")}`;
    await c.call("create-note", { path, content: "old tool" });
    await c.call("create-record", { path: `${path}-new`, content: "old param" });
    await c.call("query-records", { id: path });
    const api = rest(s.vaultViaHub, await pass({ level: "read" }));
    expect((await api.get(`/notes/${encodeURIComponent(path)}`)).status).toBe(200);
    await c.close();

    const file = join(s.home, "run", "deprecations.json");
    let log: any = {};
    const want = (l: any) => l?.names?.["mcp create-note"] && l?.names?.["mcp create-record content"] && l?.names?.["rest GET /api/notes/:id"] && l?.adopted?.["mcp query-records"];
    for (let i = 0; i < 40 && !want(log); i++) {
      await Bun.sleep(250); // the vault batches its writes (name-usage.ts FLUSH_MS)
      if (existsSync(file)) log = JSON.parse(readFileSync(file, "utf8"));
    }
    expect(log.names["mcp create-note"].count).toBeGreaterThanOrEqual(1);
    expect(log.names["mcp create-record content"].count).toBeGreaterThanOrEqual(1);
    expect(log.names["rest GET /api/notes/:id"].count).toBeGreaterThanOrEqual(1);
    expect(log.adopted["mcp query-records"].count).toBeGreaterThanOrEqual(1);
    // Names and counts only: no path, id or value reaches the log.
    expect(JSON.stringify(log)).not.toContain(path);
  });
});
