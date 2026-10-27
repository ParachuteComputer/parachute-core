// Tags with schemas: an app declares a type (a tag with fields); the vault holds every note to it.
import { describe, expect, test } from "bun:test";
import { enc, operator, paths, runId } from "../lib.ts";

const api = operator();

describe("tags and types", () => {
  test("an app declares a type with fields, and reads the declaration back", async () => {
    const tag = runId("task");
    const put = await api.put(`/tags/${enc(tag)}`, {
      description: "A thing to do",
      fields: {
        status: { type: "string", enum: ["open", "done"], strict: true },
        due: { type: "date" },
        estimate: { type: "number" },
      },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = await api.get(`/tags?tag=${enc(tag)}`);
    expect(got.status).toBe(200);
    const decl = Array.isArray(got.body) ? got.body.find((t: any) => t.name === tag) : got.body;
    expect(decl.description).toBe("A thing to do");
    expect(Object.keys(decl.fields ?? decl.schema?.fields ?? {}).sort()).toEqual(["due", "estimate", "status"]);
  });

  test("a strict field refuses a wrong value; the note is not written", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { status: { type: "string", enum: ["open", "done"], strict: true } } });
    const path = `${runId("tags")}/bad`;
    const bad = await api.post("/notes", { content: "x", path, tags: [tag], metadata: { status: "maybe" } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("status");
    expect((await api.get(`/notes/${enc(path)}`)).status).toBe(404);

    const good = await api.post("/notes", { content: "x", path, tags: [tag], metadata: { status: "done" } });
    expect(good.status).toBe(201);
  });

  test("a strict field also guards updates, including adding the type later", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { status: { type: "string", enum: ["open", "done"], strict: true } } });
    const made = await api.post("/notes", { content: "x", path: `${runId("tags")}/later`, metadata: { status: "maybe" } });
    expect(made.status).toBe(201);
    const tagIt = await api.patch(`/notes/${made.body.id}`, { tags: { add: [tag] }, if_updated_at: made.body.updatedAt });
    expect(tagIt.status).toBe(422);
  });

  test("a loose field accepts a wrong value but says so", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { estimate: { type: "number" } } });
    const made = await api.post("/notes", {
      content: "x",
      path: `${runId("tags")}/loose`,
      tags: [tag],
      metadata: { estimate: "a lot" },
    });
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body.validation_status ?? made.body.warnings ?? {})).toContain("estimate");
  });

  test("notes can be listed by tag, and by all or any of several tags", async () => {
    const r = runId("tags");
    const [a, b] = [`${r}-a`, `${r}-b`];
    await api.post("/notes", { content: "1", path: `${r}/1`, tags: [a] });
    await api.post("/notes", { content: "2", path: `${r}/2`, tags: [a, b] });
    await api.post("/notes", { content: "3", path: `${r}/3`, tags: [b] });
    await api.post("/notes", { content: "4", path: `${r}/4` });

    expect(paths((await api.get(`/notes?tag=${a}`)).body)).toEqual([`${r}/1`, `${r}/2`]);
    expect(paths((await api.get(`/notes?tag=${a},${b}&tag_match=all`)).body)).toEqual([`${r}/2`]);
    expect(paths((await api.get(`/notes?tag=${a},${b}&tag_match=any`)).body)).toEqual([`${r}/1`, `${r}/2`, `${r}/3`]);
  });

  test("notes can be found by a typed field", async () => {
    const tag = runId("task");
    // Field names are shared across types in one vault today (an indexed `status` here would clash with the
    // loose `status` other contracts declare), so this one gets its own name.
    const field = `stage_${runId("f").slice(2).replace(/-/g, "")}`;
    const put = await api.put(`/tags/${enc(tag)}`, { fields: { [field]: { type: "string", indexed: true } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r = runId("tags");
    await api.post("/notes", { content: "o", path: `${r}/open`, tags: [tag], metadata: { [field]: "open" } });
    await api.post("/notes", { content: "d", path: `${r}/done`, tags: [tag], metadata: { [field]: "done" } });
    const open = await api.get(`/notes?tag=${tag}&meta[${field}][eq]=open`);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(paths(open.body)).toEqual([`${r}/open`]);
  });

  test("two types that disagree about a shared field's type are refused, not silently merged", async () => {
    const field = `when_${runId("f").slice(2).replace(/-/g, "")}`;
    const first = await api.put(`/tags/${enc(runId("a"))}`, { fields: { [field]: { type: "date", indexed: true } } });
    expect(first.status).toBe(200);
    const second = await api.put(`/tags/${enc(runId("b"))}`, { fields: { [field]: { type: "number", indexed: true } } });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });
});
