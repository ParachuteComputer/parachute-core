// T-476: create-record (create-note) and update-record's links.add refuse a wrongly shaped argument before any
// write, with a typed refusal. Each shape below used to throw a TypeError from deep inside the write (a door counts
// that as a server fault), often after a single create had already written its record.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.ts";
import { generateMcpTools } from "./mcp.ts";
import { shapeRecordSurface } from "./mcp-surface.ts";
import { refusalOfError } from "./mcp-refusal.ts";

function vault() {
  const store = new BunSqliteStore(new Database(":memory:"));
  const tools = shapeRecordSurface(generateMcpTools(store), { db: store.db, vaultName: "v" });
  const call = (name: string, params: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(params);
  const count = () => (store.db.query("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  return { store, call, count };
}

/** The thrown error's own properties, and what a door puts on the wire for it (core mcp-refusal.ts, both doors). */
async function refusal(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return { class: (e as Error).constructor.name, ...(e as object), message: (e as Error).message, wire: refusalOfError(e) };
  }
  throw new Error("expected a refusal");
}

describe("create-record refuses a wrong shape before writing", () => {
  test("a link with no relationship to a record that exists (the tools/list schema marks it optional)", async () => {
    const v = vault();
    await v.call("create-record", { path: "People/Ada", body: "Ada" });
    const r = await refusal(v.call("create-record", { path: "Notes/Garden", body: "See Ada.", links: [{ target: "People/Ada" }] }));
    expect(r).toMatchObject({ class: "Error", error_type: "invalid_query", field: "links.0.relationship" });
    expect(r.message).toContain("`links[0].relationship` is required: what the link means.");
    // Before: the record was written, then the link crashed, so the caller saw an error for a write that happened.
    expect(v.count()).toBe(1);
  });

  const cases: [string, Record<string, unknown>, string][] = [
    ["path a number", { path: 5, body: "x" }, "path"],
    ["body a number", { path: "A", body: 5 }, "body"],
    ["body an array", { path: "A", body: ["x"] }, "body"],
    ["created_at an object", { path: "A", created_at: {} }, "created_at"],
    ["tags a number", { path: "A", tags: 3 }, "tags"],
    ["tags with a null", { path: "A", tags: [null] }, "tags"],
    ["tags a string (it was split into one-letter tags)", { path: "A", tags: "garden" }, "tags"],
    ["links a string", { path: "A", links: "People/Ada" }, "links"],
    ["links of strings", { path: "A", links: ["People/Ada"] }, "links.0"],
    ["a link with a number target", { path: "A", links: [{ target: 5, relationship: "r" }] }, "links.0.target"],
    ["a link with no target", { path: "A", links: [{ relationship: "r" }] }, "links.0.target"],
    ["records an object", { records: { path: "A" } }, "records"],
    ["records a string (it made one blank record per character)", { records: "ab" }, "records"],
    ["a null item in records", { records: [{ path: "A" }, null] }, "records"],
  ];
  for (const [name, args, field] of cases) {
    test(name, async () => {
      const v = vault();
      const r = await refusal(v.call("create-record", args));
      expect(r).toMatchObject({ class: "Error", error_type: "invalid_query", field });
      expect(v.count()).toBe(0);
    });
  }

  test("a bad item in a batch names its index, and the batch writes nothing", async () => {
    const v = vault();
    const r = await refusal(v.call("create-record", { records: [{ path: "A", body: "a" }, { path: "B", links: [{ target: "A" }] }] }));
    expect(r).toMatchObject({ error_type: "invalid_query", field: "links.0.relationship", index: 1 });
    expect(r.message).toStartWith("In item 1 of `records`:");
    // What the caller receives: the same field and index (refusalOfError used to drop index).
    expect(r.wire).toMatchObject({ error_type: "invalid_query", field: "links.0.relationship", index: 1 });
    expect(v.count()).toBe(0);
  });

  test("on the record door the words say body and records, never content or notes", async () => {
    const v = vault();
    for (const args of [{ records: 5 }, { records: [5] }, { path: "A", body: 5 }]) {
      const r = await refusal(v.call("create-record", args));
      const words = `${r.message} ${(r.wire as Record<string, unknown>).hint}`;
      expect(words, JSON.stringify(args)).not.toMatch(/content|notes/);
    }
  });

  test("the note door words it as notes", async () => {
    const v = vault();
    const r = await refusal(v.call("create-note", { notes: [{ path: "A", content: 5 }] }));
    expect(r).toMatchObject({ error_type: "invalid_query", field: "content", index: 0 });
    expect(r.message).toBe("In item 0 of `notes`: `content` must be a string.");
  });
});

describe("what still works", () => {
  test("claude.ai's own shapes: a batch with links, a typed record with fields", async () => {
    const v = vault();
    await v.call("create-record", { path: "People/Maya Ortiz", body: "Maya" });
    const out = (await v.call("create-record", {
      records: [
        { path: "Notes/Seed library box", body: "Ask [[Maya Ortiz]].", links: [{ relationship: "mentions", target: "People/Maya Ortiz" }] },
        { path: "Tasks/Return the library books", types: ["task"], fields: { due: "2026-11-28", status: "open" } },
      ],
    })) as unknown[];
    expect(out).toHaveLength(2);
    expect(v.count()).toBe(3);
    const links = v.store.db.query("SELECT relationship FROM links WHERE relationship = 'mentions'").all();
    expect(links).toHaveLength(1);
  });

  test("null is an optional the caller isn't using, also with if_exists update", async () => {
    const v = vault();
    await v.call("create-record", { path: "A", body: "kept", fields: { s: 1 } });
    const out = (await v.call("create-record", { path: "A", if_exists: "update", body: null, fields: null, tags: null, links: null })) as { body: string; fields: Record<string, unknown> };
    expect(out.body).toBe("kept");
    expect(out.fields).toMatchObject({ s: 1 });
  });
});

describe("update-record's links.add", () => {
  test("a link with no relationship is refused before the update", async () => {
    const v = vault();
    await v.call("create-record", { path: "A", body: "a" });
    await v.call("create-record", { path: "B", body: "b" });
    const r = await refusal(v.call("update-record", { id: "B", force: true, body: "changed", links: { add: [{ target: "A" }] } }));
    expect(r).toMatchObject({ class: "Error", error_type: "invalid_query", field: "links.add.0.relationship" });
    const b = (await v.call("query-records", { id: "B" })) as { body: string };
    expect(b.body).toBe("b");
  });
  test("a bad item in a batch names its index", async () => {
    const v = vault();
    await v.call("create-record", { path: "A", body: "a" });
    await v.call("create-record", { path: "B", body: "b" });
    const r = await refusal(v.call("update-record", { force: true, records: [{ id: "A", body: "a2" }, { id: "B", links: { add: [{ target: "A" }] } }] }));
    expect(r.wire).toMatchObject({ error_type: "invalid_query", field: "links.add.0.relationship", index: 1 });
    expect(((await v.call("query-records", { id: "A" })) as { body: string }).body).toBe("a");
  });
  test("links.remove: a string entry is refused; an entry without a relationship is still accepted", async () => {
    const v = vault();
    await v.call("create-record", { path: "A", body: "a" });
    await v.call("create-record", { path: "B", body: "b", links: [{ target: "A", relationship: "r" }] });
    const r = await refusal(v.call("update-record", { id: "B", force: true, links: { remove: ["A"] } }));
    expect(r).toMatchObject({ class: "Error", error_type: "invalid_query", field: "links.remove.0" });
    await v.call("update-record", { id: "B", force: true, links: { remove: [{ target: "A" }] } });
    const r2 = await refusal(v.call("update-record", { id: "B", force: true, links: { remove: [{ target: "A", relationship: 5 }] } }));
    expect(r2.message).toBe("`links.remove[0].relationship` must be a string.");
  });
  test("a string entry is refused", async () => {
    const v = vault();
    await v.call("create-record", { path: "B", body: "b" });
    const r = await refusal(v.call("update-record", { id: "B", force: true, links: { add: ["A"] } }));
    expect(r).toMatchObject({ error_type: "invalid_query", field: "links.add.0" });
  });
});
