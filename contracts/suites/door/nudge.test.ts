// Surface D, 0.9.1: the refresh nudge and the read sentence, at every door (T-446).
//
// The refresh nudge: the five note-named tools answer a successful call with their JSON block, as before, then a
// second text block that names the record tool and says to refresh the connector if the record tools aren't listed.
// Every other tool answers with one block, and a refused call carries no nudge. The read sentence: the server
// instructions say, on one line near the vault's name, what this connection can read at its level.
// Both are product text for an AI client, so every door must say them, and say them the same.
import { describe, expect, test } from "bun:test";
import { fp, mcp, runId } from "./_door.ts";

const ALIASES: Record<string, string> = {
  "query-notes": "query-records",
  "create-note": "create-record",
  "update-note": "update-record",
  "delete-note": "delete-record",
  "list-tags": "list-types",
};

type Block = { type: string; text?: string };

async function blocks(c: Awaited<ReturnType<typeof mcp>>, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Block[] }> {
  const r: any = await c.client.callTool({ name, arguments: args });
  return { isError: r.isError ?? false, content: r.content ?? [] };
}

describe("the refresh nudge and the read sentence", () => {
  test("each of the five note tools answers with its JSON, then the nudge naming its record tool", async () => {
    const c = await mcp("write");
    try {
      const path = `${runId("nudge")}/one`;
      const calls: [string, Record<string, unknown>][] = [
        ["create-note", { path, content: "Fernhill Bakery: sourdough order for client-42." }],
        ["query-notes", { id: path, include_content: true }],
        ["update-note", { id: path, append: "\nTwo loaves." }],
        ["list-tags", {}],
        ["delete-note", { id: path }],
      ];
      for (const [name, args] of calls) {
        const r = await blocks(c, name, args);
        expect({ name, isError: r.isError }).toEqual({ name, isError: false });
        fp(`mcp/nudge.${name}.blocks`, r.content.map((b) => b.type));
        expect({ name, count: r.content.length }).toEqual({ name, count: 2 });
        // The first block is the tool's JSON exactly as before: two-space JSON, no nudge inside it.
        const first = r.content[0]!;
        const parsed = JSON.parse(first.text!);
        expect(first.text).toBe(JSON.stringify(parsed, null, 2));
        expect(first.text).not.toContain("refresh");
        const nudge = r.content[1]!.text ?? "";
        expect(nudge).toContain("`create-record`");
        expect(nudge).toMatch(/refresh/);
        expect(nudge).toContain(`\`${ALIASES[name]}\``);
        fp(`mcp/nudge.${name}.text`, nudge);
      }
    } finally {
      await c.close();
    }
  });

  test("a record tool, and a refused note tool, answer with one block", async () => {
    const c = await mcp("write");
    try {
      const path = `${runId("nudge")}/two`;
      const made = await blocks(c, "create-record", { path, body: "Mara's one block" });
      fp("mcp/nudge.create-record.blocks", made.content.map((b) => b.type));
      expect(made.content.length).toBe(1);
      // A refused call (a blind update: no if_updated_at) says why and nothing else: no nudge.
      const refused = await blocks(c, "update-note", { id: path, content: "blind" }).catch((e) => ({ isError: true, content: [{ type: "rpc-error", text: String(e?.message ?? e) }] as Block[] }));
      const nudged = refused.content.some((b) => /refresh this connector/.test(b.text ?? ""));
      fp("mcp/nudge.refused-call", { isError: refused.isError, nudged });
      expect(refused.isError).toBe(true);
      expect(nudged).toBe(false);
      await blocks(c, "delete-record", { id: path });
    } finally {
      await c.close();
    }
  });

  for (const level of ["read", "write", "admin"] as const) {
    test(`a ${level} credential is told what it can read`, async () => {
      const c = await mcp(level);
      try {
        const lines = ((c.client as any).getInstructions?.() ?? "").split("\n");
        const at = lines.findIndex((l: string) => l.startsWith("This connection can"));
        const said = at === -1 ? "(no line says what this connection can read)" : lines[at];
        fp(`mcp/reach.${level}`, said);
        expect(said).toBe(
          {
            read: "This connection can read the whole vault. It can't change anything.",
            write: "This connection can read the whole vault, and create, change and delete its records.",
            admin: "This connection can read the whole vault, create, change and delete its records, and manage its types, settings and keys.",
          }[level],
        );
      } finally {
        await c.close();
      }
    });
  }
});
