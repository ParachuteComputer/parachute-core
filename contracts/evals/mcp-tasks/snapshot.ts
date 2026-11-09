// Write what an agent sees from this checkout's vault MCP: the server instructions and tools/list, as JSON.
//   bun snapshot.ts <out.json> [--scope read|write|admin]
// `old/tools.json` (the OLD arm) was made with this at main ccc7729, before the short descriptions.
import { writeFileSync } from "node:fs";
import { startBox } from "./box.ts";
import { connect } from "./mcp.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: bun snapshot.ts <out.json> [--scope read|write|admin]");
const si = process.argv.indexOf("--scope");
const scope = (si > 0 ? process.argv[si + 1] : "admin") as "read" | "write" | "admin";
const box = await startBox();
try {
  const token = scope === "admin" ? box.token : await box.mint(scope);
  const c = await connect(box.mcpUrl, token);
  const tools = await c.listTools();
  writeFileSync(out, JSON.stringify({ scope, instructions: c.instructions, tools }, null, 1) + "\n");
  const chars = JSON.stringify(tools).length + (c.instructions ?? "").length;
  console.log(`${tools.length} tools, ${chars} chars (~${Math.ceil(chars / 4)} tokens) → ${out}`);
  await c.close();
} finally {
  await box.stop();
}
