// The record translator (T-407): pure rules, so pinned here; the black-box behaviour is contracts/suites/mcp/records.test.ts.
import { describe, expect, test } from "bun:test";
import { BODY, FIELDS, addRecordTools, paramsIn, recordSchema, recordWords, resultOut } from "./mcp-records.ts";

describe("record calls in", () => {
  test("record words become note words; a person's own field names are never touched", () => {
    const used: string[] = [];
    const out = paramsIn("create-record", { path: "A", [BODY]: "text", [FIELDS]: { content: "theirs", metadata: 1 }, types: ["trip"] }, (n) => used.push(n));
    expect(out).toEqual({ path: "A", content: "text", metadata: { content: "theirs", metadata: 1 }, types: ["trip"] });
    expect(used).toEqual([]);
  });

  // Only while the wire words differ: with BODY = "content" the old name *is* the new one.
  test.if(BODY !== "content")("a batch translates each item; old names are taken and counted", () => {
    const used: string[] = [];
    const out = paramsIn("create-record", { records: [{ [BODY]: "a" }, { content: "b" }] }, (n, k) => used.push(`${k}:${n}`));
    expect(out).toEqual({ notes: [{ content: "a" }, { content: "b" }] });
    expect(used).toEqual(["old:create-record content"]);
  });

  test("an anchor is {id} on the record door; {note_id} still works and is counted", () => {
    const used: string[] = [];
    expect(paramsIn("query-records", { near: { id: "X", depth: 1 } }, (n) => used.push(n))).toEqual({ near: { note_id: "X", depth: 1 } });
    expect(paramsIn("query-records", { versions: { note_id: "X" } }, (n) => used.push(n))).toEqual({ versions: { note_id: "X" } });
    expect(used).toEqual(["query-records versions.note_id"]);
  });

  // Only while the wire words differ: with BODY = "content" the old name *is* the new one.
  test.if(BODY !== "content")("a new name beside its old name is refused, naming both", () => {
    expect(() => paramsIn("update-record", { id: "A", [BODY]: "x", content: "y" })).toThrow(`pass \`${BODY}\` or \`content\`, not both`);
    expect(() => paramsIn("query-records", { near: { id: "A", note_id: "B" } })).toThrow(/near.id.*near.note_id/);
  });

  test("list-types takes `name` for one type", () => {
    expect(paramsIn("list-types", { name: "trip" })).toEqual({ tag: "trip" });
  });
});

describe("record answers out", () => {
  test("a record: body and fields renamed, tags are only labels, a person's field called content stays", () => {
    const note = { id: "1", content: "hi", metadata: { content: "theirs", notes: 2 }, tags: ["pinned", "trip"], types: ["trip"] };
    expect(resultOut("query-records", note)).toEqual({ id: "1", [BODY]: "hi", [FIELDS]: { content: "theirs", notes: 2 }, tags: ["pinned"], types: ["trip"] });
  });

  test("envelopes and paging keys move; warnings speak record words and name record parameters", () => {
    const r = resultOut("query-records", {
      notes: [{ id: "1", content_total_length: 9, content_next_offset: 4 }],
      warnings: [{ code: "unknown_parameter", message: "query-notes has no parameter `x`", field: "include_content" }],
    });
    expect(r).toEqual({
      records: [{ id: "1", [`${BODY}_total_length`]: 9, [`${BODY}_next_offset`]: 4 }],
      warnings: [{ code: "unknown_parameter", message: "query-records has no parameter `x`", field: `include_${BODY}` }],
    });
  });

  test("list-types answers as list-tags did (tag rows already speak type words)", () => {
    const rows = [{ name: "trip", kind: "type", count: 1, fields: { content: { type: "string" } } }];
    expect(resultOut("list-types", rows)).toBe(rows);
  });
});

describe("record words", () => {
  test("tool and parameter names, and the noun", () => {
    expect(recordWords("Use query-notes with `metadata` and include_content; a note's notes; Notes")).toBe(
      `Use query-records with \`${FIELDS}\` and include_${BODY}; a record's records; Records`,
    );
    expect(recordWords("Indexed metadata fields")).toBe("Indexed fields");
  });

  test("a schema: properties and required renamed, anchors take id", () => {
    const s = recordSchema("query-notes", {
      type: "object",
      properties: { metadata: { type: "object", description: "note metadata" }, near: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"] } },
    }) as any;
    expect(Object.keys(s.properties)).toEqual([FIELDS, "near"]);
    expect(s.properties[FIELDS].description).toBe(`record ${FIELDS}`);
    expect(s.properties.near.properties).toEqual({ id: { type: "string" } });
    expect(s.properties.near.required).toEqual(["id"]);
  });
});

describe("addRecordTools", () => {
  const tool = (name: string, execute: (p: Record<string, unknown>) => unknown) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, requiredVerb: "read" as const, execute });

  test("the record tool runs the note tool; the note tool stays, deprecated, answering in its own words; each use counted", async () => {
    const seen: unknown[] = [];
    const used: string[] = [];
    const tools = addRecordTools([tool("query-notes", (p) => (seen.push(p), [{ id: "1", content: "x", metadata: {} }])), tool("vault-info", () => ({}))], (n, k) => used.push(`${k}:${n}`));
    expect(tools.map((t) => t.name)).toEqual(["query-records", "vault-info", "query-notes"]);
    expect(await tools[0]!.execute({ [`include_${BODY}`]: true })).toEqual([{ id: "1", [BODY]: "x", [FIELDS]: {} }]);
    expect(seen[0]).toEqual({ include_content: true });
    expect(tools[2]!.description).toStartWith("Deprecated (gone in 1.0): use query-records.");
    expect(await tools[2]!.execute({ include_content: true })).toEqual([{ id: "1", content: "x", metadata: {} }]);
    expect(used).toEqual(["new:query-records", "old:query-notes"]);
  });

  test("a note tool's error reaches the record door in record words", async () => {
    const [rec] = addRecordTools([tool("update-note", () => { throw Object.assign(new Error("Note not found: content_edit"), { field: "note_id", hint: "pass the note's id" }); })]);
    const err = await Promise.resolve(rec!.execute({ id: "x" })).catch((e) => e);
    expect(err.message).toBe(`Record not found: ${BODY}_edit`);
    expect(err.field).toBe("id");
    expect(err.hint).toBe("pass the record's id");
  });
});
