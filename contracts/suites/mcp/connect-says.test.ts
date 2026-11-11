// mcp/connect-says: the server instructions say what this connection can read (0.9.1, T-446; SPEC §3.4 "Say it
// plainly at connect: a new connection reaches the whole vault at its level").
//
// The instructions are what a model reads the moment it connects. They now say, in one line under the vault's name,
// what is true for the key it connected with: the whole vault at its level, or only the records under the key's tags.
// Never less than the key can do: a write key is told it reads everything too. The budget (mcp/budget) still holds.
// Red before T-446: the instructions said nothing about reach.
import { describe, expect, test } from "bun:test";
import { mcp, pass, runId, services } from "../lib.ts";

async function instructions(token: string): Promise<string> {
  const s = services();
  const c = await mcp(`${s.vaultViaHub}/mcp`, token);
  const text = c.client.getInstructions() ?? "";
  await c.close();
  return text;
}

/** The connect line: the one starting "This connection can". */
function reach(text: string): string {
  return text.split("\n").find((l) => l.startsWith("This connection can")) ?? "(no line says what this connection can read)";
}

describe("mcp/connect-says", () => {
  test("a read key: the whole vault, and it can't change anything", async () => {
    expect(reach(await instructions(await pass({ level: "read" })))).toBe("This connection can read the whole vault. It can't change anything.");
  });

  test("a write key: the whole vault, and it writes", async () => {
    expect(reach(await instructions(await pass({ level: "write" })))).toBe(
      "This connection can read the whole vault, and create, change and delete its records.",
    );
  });

  test("the operator (admin): the whole vault, its records, and its types, settings and keys", async () => {
    expect(reach(await instructions(services().operatorToken))).toBe(
      "This connection can read the whole vault, create, change and delete its records, and manage its types, settings and keys.",
    );
  });

  test("a tag-scoped key: only the records under its tags, named", async () => {
    const tag = runId("bakery").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    expect(reach(await instructions(await pass({ level: "read", tags: [tag] })))).toBe(
      `This connection can read only the records tagged \`${tag}\` (subtags included); other records are hidden from it. It can't change anything.`,
    );
  });

  test("the line sits right under the vault's name, before the orientation", async () => {
    const text = await instructions(await pass({ level: "write" }));
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("You are connected to Parachute Vault");
    expect(lines[1]).toStartWith("This connection can read");
  });
});
