/**
 * 0.9.2 safe schema change, end to end on the REST handler and the MCP tools:
 * a retype that would strand records is refused with the count and how to
 * migrate; a migrate dry run says what would change and writes nothing; an
 * applied migrate converts the values, after which the same retype goes
 * through and the records can be edited.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { BunStore } from "./vault-store.ts";
import { handleTags, type TagScopeCtx } from "./routes.ts";
import { generateMcpTools } from "../core/src/mcp.ts";

let db: Database;
let store: BunStore;
const BASE = "http://localhost/api";

beforeEach(() => {
  db = new Database(":memory:");
  store = new BunStore(db);
});
afterEach(() => db.close());

function tags(method: string, sub: string, body?: unknown, scope?: TagScopeCtx): Promise<Response> {
  return handleTags(
    new Request(`${BASE}/tags${sub}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    store,
    sub,
    ...(scope ? [scope] : []),
  );
}

async function seed(spec: Record<string, unknown>, values: unknown[]) {
  expect((await tags("PUT", "/item", { fields: { size: spec } })).status).toBe(200);
  for (const [i, v] of values.entries()) await store.createNote(`r${i}`, { path: `r/${i}`, tags: ["item"], metadata: { size: v } });
}

describe("a retype that would strand records", () => {
  it("is refused with the count and the migrate call; migrate, then the retype goes through", async () => {
    await seed({ type: "integer", indexed: true }, [3, 8, 13]);
    const refused = await tags("PUT", "/item", { fields: { size: { type: "string", indexed: true } } });
    expect(refused.status).toBe(409);
    const body: any = await refused.json();
    expect(body).toMatchObject({ error_type: "retype_conflict", field: "size", count: 3 });
    expect(body.hint).toContain('transform: {kind: "to_string"}');
    expect(body.conflicts[0].sample).toHaveLength(3);
    expect((await store.getTagRecord("item"))?.fields?.size?.type).toBe("integer");

    const dry: any = await (await tags("POST", "/item/migrate", { field: "size", transform: { kind: "to_string" } })).json();
    expect(dry).toMatchObject({ applied: false, would_change: 3, errored: 0 });
    expect((await store.getNoteByPath("r/0"))?.metadata?.size).toBe(3);

    const done: any = await (await tags("POST", "/item/migrate", { field: "size", transform: { kind: "to_string" }, apply: true })).json();
    expect(done).toMatchObject({ applied: true, changed: 3 });
    expect((await store.getNoteByPath("r/0"))?.metadata?.size).toBe("3");

    expect((await tags("PUT", "/item", { fields: { size: { type: "string", indexed: true } } })).status).toBe(200);
    const r0 = (await store.getNoteByPath("r/0"))!;
    await store.updateNote(r0.id, { metadata: { size: "4" } }); // editable: no 422
  });

  it("a loose field (neither strict nor indexed) strands nothing: the retype is accepted", async () => {
    await seed({ type: "integer" }, [3, 8]);
    expect((await tags("PUT", "/item", { fields: { size: { type: "string" } } })).status).toBe(200);
  });

  it("a retype every value already meets is accepted, and so is a new field", async () => {
    await seed({ type: "integer", indexed: true }, [3, 8]);
    expect((await tags("PUT", "/item", { fields: { size: { type: "number", indexed: false } } })).status).toBe(200);
    expect((await tags("PUT", "/item", { fields: { other: { type: "date", strict: true } } })).status).toBe(200);
  });

  it("a tag-scoped admin gets the count, not the records' ids or paths", async () => {
    await seed({ type: "integer", strict: true }, [3]);
    const res = await tags("PUT", "/item", { fields: { size: { type: "date", strict: true } } }, { allowed: new Set(["item"]), raw: ["item"] });
    const body: any = await res.json();
    expect(res.status).toBe(409);
    expect(body.count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("r/0");
  });
});

describe("migrate", () => {
  it("is refused to a tag-scoped pass: it rewrites records beyond its tags", async () => {
    await seed({ type: "integer" }, [3]);
    const res = await tags("POST", "/item/migrate", { field: "size", transform: { kind: "to_string" } }, { allowed: new Set(["item"]), raw: ["item"] });
    expect(res.status).toBe(403);
  });

  it("a bad request is a 400 naming the field", async () => {
    await seed({ type: "integer" }, [3]);
    for (const [body, field] of [[{ transform: { kind: "to_string" } }, "field"], [{ field: "size" }, "transform"], [{ field: "size", transform: { kind: "nope" } }, "transform"]] as const) {
      const res = await tags("POST", "/item/migrate", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).field).toBe(field);
    }
  });
});

describe("over MCP", () => {
  it("update-tag refuses the same retype with the same shape; migrate-field gives the same plan", async () => {
    await seed({ type: "integer", indexed: true }, [3, 8]);
    const tools = generateMcpTools(store);
    const update = tools.find((t) => t.name === "update-tag")!;
    let err: any;
    try {
      await update.execute({ tag: "item", fields: { size: { type: "string", indexed: true } } });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ error_type: "retype_conflict", field: "size", count: 2 });
    const migrate = tools.find((t) => t.name === "migrate-field")!;
    expect(await migrate.execute({ tag: "item", field: "size", transform: { kind: "to_string" } })).toMatchObject({ would_change: 2, applied: false });
  });
});
