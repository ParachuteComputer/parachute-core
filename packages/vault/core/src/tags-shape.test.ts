import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";

// T-318 night (live on cloud staging): an agent that sends `tags: "meeting"`
// (a string, not a list) got a note tagged e, g, i, m, n, t — the string was
// iterated as characters. A wrong shape must be refused with the fix in the
// error, and nothing written.

let store: SqliteStore;
let db: Database;
let tools: ReturnType<typeof generateMcpTools>;
const tool = (name: string) => tools.find((t) => t.name === name)!;
const noteCount = () => (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
const tagRows = () => (db.prepare("SELECT COUNT(*) AS n FROM note_tags").get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
  tools = generateMcpTools(store);
});

describe("tags must be a list of names", () => {
  it("create-note refuses a string and writes nothing", async () => {
    const before = noteCount();
    const err = await tool("create-note").execute({ content: "tagged", tags: "meeting" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { error_type?: string }).error_type).toBe("invalid_request");
    expect((err as { field?: string }).field).toBe("tags");
    expect(String((err as Error).message)).toContain('["meeting"]');
    expect(noteCount()).toBe(before);
    expect(tagRows()).toBe(0);
  });

  it("create-note refuses a string inside a batch item, before any item is written", async () => {
    const before = noteCount();
    const err = await tool("create-note")
      .execute({ notes: [{ content: "first", tags: ["ok"] }, { content: "second", tags: "bad" }] })
      .catch((e) => e);
    expect((err as { field?: string }).field).toBe("tags");
    expect(noteCount()).toBe(before);
  });

  it("create-note still takes a list", async () => {
    const note = (await tool("create-note").execute({ content: "tagged", tags: ["meeting"] })) as { tags: string[] };
    expect(note.tags).toEqual(["meeting"]);
  });

  it("update-note refuses a string and an {add: string}", async () => {
    const note = (await tool("create-note").execute({ content: "x" })) as { id: string };
    for (const tags of ["garden", { add: "garden" }]) {
      const err = await tool("update-note").execute({ id: note.id, tags, force: true }).catch((e) => e);
      expect((err as { error_type?: string }).error_type).toBe("invalid_request");
      expect((err as { field?: string }).field).toBe("tags");
    }
    expect(tagRows()).toBe(0);
  });

  it("update-note still takes {add: [...]}", async () => {
    const note = (await tool("create-note").execute({ content: "x" })) as { id: string };
    const out = (await tool("update-note").execute({ id: note.id, tags: { add: ["garden"] }, force: true })) as { tags: string[] };
    expect(out.tags).toEqual(["garden"]);
  });
});
