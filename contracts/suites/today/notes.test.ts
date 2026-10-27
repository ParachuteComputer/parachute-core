// Notes: a markdown body plus typed fields, read and written through the door clients use (the hub).
import { describe, expect, test } from "bun:test";
import { enc, operator, runId } from "../lib.ts";

const api = operator();

describe("notes", () => {
  test("a note keeps its body, fields, tags and path exactly", async () => {
    const id = runId("notes");
    const content = `# Plan for ${id}\n\nUmlauts stay: Grüße, 東京, emoji 🪂.\n\n- one\n- two\n`;
    const metadata = { status: "open", due: "2026-11-02", count: 3, done: false, people: ["ana", "bo"] };
    const made = await api.post("/notes", { content, path: `${id}/plan`, tags: ["project"], metadata });
    expect(made.status).toBe(201);
    expect(made.body.id).toBeString();

    for (const ref of [made.body.id, enc(`${id}/plan`)]) {
      const got = await api.get(`/notes/${ref}`);
      expect(got.status).toBe(200);
      expect(got.body.content).toBe(content);
      expect(got.body.metadata).toEqual(metadata);
      expect(got.body.tags).toEqual(["project"]);
      expect(got.body.path).toBe(`${id}/plan`);
    }
  });

  test("two notes cannot share a path", async () => {
    const path = `${runId("notes")}/same`;
    expect((await api.post("/notes", { content: "a", path })).status).toBe(201);
    const again = await api.post("/notes", { content: "b", path });
    expect(again.status).toBe(409);
  });

  test("an update must say which version it saw; a stale one is refused, not merged", async () => {
    const made = await api.post("/notes", { content: "v1", path: `${runId("notes")}/cas` });
    const id = made.body.id;
    const seen = made.body.updatedAt;

    // No precondition at all: refused, so a blind overwrite can't happen by accident.
    expect((await api.patch(`/notes/${id}`, { content: "blind" })).status).toBe(428);

    const first = await api.patch(`/notes/${id}`, { content: "v2", if_updated_at: seen });
    expect(first.status).toBe(200);
    expect(first.body.content).toBe("v2");

    // A second writer who also saw v1 is told about the conflict.
    const stale = await api.patch(`/notes/${id}`, { content: "v2-other", if_updated_at: seen });
    expect(stale.status).toBe(409);
    expect((await api.get(`/notes/${id}`)).body.content).toBe("v2");
  });

  test("fields merge on update; null removes one", async () => {
    const made = await api.post("/notes", {
      content: "x",
      path: `${runId("notes")}/fields`,
      metadata: { a: 1, b: "keep", c: true },
    });
    const up = await api.patch(`/notes/${made.body.id}`, {
      metadata: { a: 2, c: null },
      if_updated_at: made.body.updatedAt,
    });
    expect(up.status).toBe(200);
    expect((await api.get(`/notes/${made.body.id}`)).body.metadata).toEqual({ a: 2, b: "keep" });
  });

  test("tags can be added and removed without touching the body", async () => {
    const made = await api.post("/notes", { content: "body", path: `${runId("notes")}/tags`, tags: ["one"] });
    const up = await api.patch(`/notes/${made.body.id}`, {
      tags: { add: ["two"], remove: ["one"] },
      if_updated_at: made.body.updatedAt,
    });
    expect(up.status).toBe(200);
    const got = await api.get(`/notes/${made.body.id}`);
    expect(got.body.tags).toEqual(["two"]);
    expect(got.body.content).toBe("body");
  });

  test("a deleted note is gone by id and by path", async () => {
    const path = `${runId("notes")}/gone`;
    const made = await api.post("/notes", { content: "bye", path });
    expect((await api.del(`/notes/${made.body.id}`)).status).toBe(200);
    expect((await api.get(`/notes/${made.body.id}`)).status).toBe(404);
    expect((await api.get(`/notes/${enc(path)}`)).status).toBe(404);
  });

  test("no token, no notes", async () => {
    const { services } = await import("../lib.ts");
    const r = await fetch(`${services().vaultViaHub}/api/notes`);
    expect(r.status).toBe(401);
  });
});
