// mcp/nudge: the refresh nudge (0.9.1, T-446; ROADMAP 0.9.1 "The refresh nudge").
//
// A client that cached 0.8's tool list (ChatGPT keeps one per connector) keeps calling the five note-named tools and
// never sees the record tools. Each of those five answers a successful call with a second text block that says what
// to do: if `create-record` isn't among your tools, ask your user to refresh the connector; otherwise use the record
// tool. The first block, the JSON a script reads, is the same bytes as before. The nine other deprecated names
// already carry a `deprecation` field in their JSON and get no second block; nor does any other tool.
// Red before T-446: one block on every tool.
import { describe, expect, test } from "bun:test";
import { mcp, pass, runId, services } from "../lib.ts";

const ALIASES: Record<string, string> = {
  "query-notes": "query-records",
  "create-note": "create-record",
  "update-note": "update-record",
  "delete-note": "delete-record",
  "list-tags": "list-types",
};

async function session() {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "write" }));
}

/** The content blocks of a successful call. */
async function blocks(c: Awaited<ReturnType<typeof session>>, name: string, args: Record<string, unknown>): Promise<{ type: string; text?: string }[]> {
  const r: any = await c.client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content).slice(0, 300)}`);
  return r.content;
}

/** The first block is the tool's JSON, exactly as the server has always written it (two-space JSON.stringify). */
function sameJson(b: { type: string; text?: string }): unknown {
  expect(b.type).toBe("text");
  const parsed = JSON.parse(b.text!);
  expect(b.text).toBe(JSON.stringify(parsed, null, 2));
  return parsed;
}

describe("mcp/nudge", () => {
  test("each of the five note tools answers with its JSON, then the nudge naming its record tool", async () => {
    const c = await session();
    const path = `nudge/${runId("n")}`;
    const calls: [string, Record<string, unknown>][] = [
      ["create-note", { path, content: "Fernhill Bakery: sourdough order for client-42." }],
      ["query-notes", { id: path, include_content: true }],
      ["update-note", { id: path, append: "\nTwo loaves." }],
      ["list-tags", {}],
      ["delete-note", { id: path }],
    ];
    for (const [name, args] of calls) {
      const b = await blocks(c, name, args);
      expect({ name, count: b.length }).toEqual({ name, count: 2 });
      const json = sameJson(b[0]!) as Record<string, unknown>;
      // The JSON is the note tool's own: no nudge text inside it.
      expect(JSON.stringify(json)).not.toContain("refresh");
      const nudge = b[1]!;
      expect(nudge.type).toBe("text");
      expect(nudge.text).toContain("`create-record`");
      expect(nudge.text).toMatch(/refresh/);
      expect(nudge.text).toContain(`\`${ALIASES[name]}\``);
    }
    await c.close();
  });

  test("the JSON block reads the same as the record it wrote", async () => {
    const c = await session();
    const path = `nudge/${runId("same")}`;
    const made = sameJson((await blocks(c, "create-note", { path, content: "Mara's note" }))[0]!) as { id: string; content: string };
    const read = sameJson((await blocks(c, "query-notes", { id: made.id, include_content: true }))[0]!) as { id: string; content: string };
    expect(read.id).toBe(made.id);
    expect(read.content).toBe("Mara's note");
    await c.call("delete-record", { id: made.id });
    await c.close();
  });

  test("every other tool answers with one block: the record tools, vault-info, and a deprecated name that carries `deprecation`", async () => {
    const c = await session();
    const path = `nudge/${runId("other")}`;
    const one: [string, Record<string, unknown>][] = [
      ["create-record", { path, body: "one block" }],
      ["query-records", { id: path }],
      ["update-record", { id: path, append: " still one" }],
      ["list-types", {}],
      ["vault-info", {}],
    ];
    for (const [name, args] of one) {
      const b = await blocks(c, name, args);
      expect({ name, count: b.length }).toEqual({ name, count: 1 });
    }
    // One of the nine older aliases (find-path → query-records {path_between}): its JSON says `deprecation`, one block.
    expect(await c.tools()).toContain("find-path");
    const fp = await blocks(c, "find-path", { source: path, target: path });
    expect(fp.length).toBe(1);
    expect(JSON.parse(fp[0]!.text!)).toHaveProperty("deprecation");
    expect((await blocks(c, "delete-record", { id: path })).length).toBe(1);
    await c.close();
  });
});
