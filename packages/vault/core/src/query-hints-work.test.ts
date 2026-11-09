import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { QUERY_HINTS } from "./vault-projection.js";

// The query hints are sent to every connecting agent (vault-info and the
// connect-time instructions). An agent follows them literally, so each one
// must run as written. The `near` hint used to teach `near: { id }, depth: 2`
// while the tool reads `near.note_id` (with depth inside `near`); following
// it crashed on an undefined id (DESIGN-0.9 §4, T-318 night).

let store: SqliteStore;
let tools: ReturnType<typeof generateMcpTools>;
const query = () => tools.find((t) => t.name === "query-notes")!;

beforeEach(() => {
  store = new SqliteStore(new Database(":memory:"));
  tools = generateMcpTools(store);
});

/** `query-notes { near: { note_id: "..." } } — …` → the params object, with "..." filled in. */
function hintParams(hint: string, fill: string): Record<string, unknown> {
  const literal = hint.slice("query-notes ".length, hint.indexOf(" — "));
  const json = literal
    .replace(/"\.\.\."/g, JSON.stringify(fill))
    .replace(/"<[^>]+>"/g, JSON.stringify(fill))
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  return JSON.parse(json);
}

describe("every query hint runs as written", () => {
  it("the near hint finds a linked note", async () => {
    const b = (await tools.find((t) => t.name === "create-note")!.execute({ content: "b", path: "B" })) as { id: string };
    const a = (await tools.find((t) => t.name === "create-note")!.execute({ content: "a links [[B]]", path: "A" })) as { id: string };
    const hint = QUERY_HINTS.find((h) => h.includes("near:"))!;
    const out = (await query().execute(hintParams(hint, a.id))) as { id: string }[] | { error?: string };
    expect(Array.isArray(out)).toBe(true);
    expect((out as { id: string }[]).map((n) => n.id)).toContain(b.id);
  });

  it("near without note_id says what to pass instead of crashing", async () => {
    const err = await query().execute({ near: { id: "x" }, depth: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { error_type?: string }).error_type).toBe("invalid_request");
    expect((err as { field?: string }).field).toBe("near.note_id");
    expect(String((err as Error).message)).toContain("note_id");
  });
});
