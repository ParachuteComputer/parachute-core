// The 0.9 surface's help and its refusals (core mcp-surface.ts), on the engine's own tools: what every door answers.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteStore } from "./store.ts";
import { generateMcpTools } from "./mcp.ts";
import { shapeRecordSurface, toolHelp } from "./mcp-surface.ts";

function surface() {
  const store = new BunSqliteStore(new Database(":memory:"));
  const tools = generateMcpTools(store);
  const info = tools.find((t) => t.name === "vault-info")!;
  info.execute = async () => ({ vault: "v" }); // a door's own projection stands here
  return shapeRecordSurface(tools, { db: store.db, vaultName: "v" });
}
const call = (tools: ReturnType<typeof surface>, name: string, params: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(params);

describe("vault-info {help}", () => {
  test("answers for every listed tool", async () => {
    const tools = surface();
    for (const t of tools) {
      const r = (await call(tools, "vault-info", { help: t.name })) as { tool?: string; description?: string };
      expect(r.tool, t.name).toBe(t.name);
      expect(typeof r.description, t.name).toBe("string");
    }
  });
  test("help and description together are refused, so a description is never dropped", async () => {
    const tools = surface();
    await expect(call(tools, "vault-info", { help: "query-records", description: "x" })).rejects.toMatchObject({ error_type: "invalid_query", field: "help" });
  });
  test("an unknown name is refused with the tools as tools/list names them", () => {
    let err: { error_type?: string; message?: string } = {};
    try {
      toolHelp("no-such-tool", ["query-records", "create-record"]);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.error_type).toBe("unknown_tool");
    expect(err.message).toBe('No tool named "no-such-tool". Tools: query-records, create-record.');
  });
});

// T-476, from a cold AI's run: create-record didn't list `extension`, so a careful model put it in `fields` and an
// applet's code was saved as markdown. What a code record needs must be in the schema a model reads.
describe("create-record lists what a code record needs", () => {
  test("`extension` is in create-record's advertised schema, and a tsx record keeps it", async () => {
    const tools = surface();
    const create = tools.find((t) => t.name === "create-record")!;
    const props = (create.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(Object.keys(props)).toContain("extension");
    expect(props.extension.description).toContain("tsx");
    const made = (await create.execute({ path: "Applets/X", extension: "tsx", body: "export default () => null;" })) as { extension?: string };
    expect(made.extension).toBe("tsx");
  });
});
