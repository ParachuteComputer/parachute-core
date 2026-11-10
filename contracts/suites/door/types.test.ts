// Surface B: types (tags with fields). An app declares a type; the vault holds every note to it, at every door.
import { describe, expect, test } from "bun:test";
import { enc, fp, paths, refusal, rest, runId, shape } from "./_door.ts";

const api = rest("admin");
const writer = rest("write");

describe("types", () => {
  test("an app declares a type with fields, and reads the declaration back", async () => {
    const tag = runId("task");
    const put = await api.put(`/tags/${enc(tag)}`, {
      description: "A thing to do",
      fields: { status: { type: "string", enum: ["open", "done"], strict: true }, due: { type: "date" }, estimate: { type: "number" } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    fp("types/declare.shape", shape(put.body));
    const got = await api.get(`/tags/${enc(tag)}`);
    expect(got.status).toBe(200);
    expect(got.body.description).toBe("A thing to do");
    expect(Object.keys(got.body.fields ?? {}).sort()).toEqual(["due", "estimate", "status"]);
    fp("types/get.shape", shape(got.body));
    const listed = await api.get(`/tags?include_schema=true`);
    const mine = listed.body.find((t: any) => t.name === tag);
    expect(mine).toBeTruthy();
    fp("types/list.item.shape", shape(mine));
    const eff = await api.get(`/tags/${enc(tag)}/effective`);
    fp("types/effective", { status: eff.status, shape: eff.status === 200 ? shape(eff.body) : null });
  });

  test("declaring a type needs an admin credential", async () => {
    const r = await writer.put(`/tags/${enc(runId("task"))}`, { fields: { a: { type: "string" } } });
    expect(r.status).toBe(403);
    fp("types/refusal.declare-without-admin", refusal(r));
  });

  test("a strict field refuses a wrong value; the note is not written", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { status: { type: "string", enum: ["open", "done"], strict: true } } });
    const path = `${runId("types")}/bad`;
    const bad = await writer.post("/notes", { content: "x", path, tags: [tag], metadata: { status: "maybe" } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("status");
    fp("types/refusal.strict", refusal(bad));
    expect((await writer.get(`/notes/${enc(path)}`)).status).toBe(404);
    expect((await writer.post("/notes", { content: "x", path, tags: [tag], metadata: { status: "done" } })).status).toBe(201);
  });

  test("a strict field also guards updates, including adding the type later", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { status: { type: "string", enum: ["open", "done"], strict: true } } });
    const made = await writer.post("/notes", { content: "x", path: `${runId("types")}/later`, metadata: { status: "maybe" } });
    expect(made.status).toBe(201);
    const tagIt = await writer.patch(`/notes/${made.body.id}`, { tags: { add: [tag] }, if_updated_at: made.body.updatedAt });
    expect(tagIt.status).toBe(422);
  });

  test("a loose field accepts a wrong value but says so", async () => {
    const tag = runId("task");
    await api.put(`/tags/${enc(tag)}`, { fields: { estimate: { type: "number" } } });
    const made = await writer.post("/notes", { content: "x", path: `${runId("types")}/loose`, tags: [tag], metadata: { estimate: "a lot" } });
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body.validation_status ?? made.body.warnings ?? {})).toContain("estimate");
    fp("types/loose.warning.shape", shape(made.body.warnings ?? made.body.validation_status ?? null));
  });

  test("notes can be listed by tag, and by all or any of several tags", async () => {
    const r = runId("types");
    const [a, b] = [`${r}-a`, `${r}-b`];
    await writer.post("/notes", { content: "1", path: `${r}/1`, tags: [a] });
    await writer.post("/notes", { content: "2", path: `${r}/2`, tags: [a, b] });
    await writer.post("/notes", { content: "3", path: `${r}/3`, tags: [b] });
    await writer.post("/notes", { content: "4", path: `${r}/4` });
    expect(paths((await writer.get(`/notes?tag=${a}`)).body)).toEqual([`${r}/1`, `${r}/2`]);
    expect(paths((await writer.get(`/notes?tag=${a},${b}&tag_match=all`)).body)).toEqual([`${r}/2`]);
    expect(paths((await writer.get(`/notes?tag=${a},${b}&tag_match=any`)).body)).toEqual([`${r}/1`, `${r}/2`, `${r}/3`]);
  });

  test("notes can be found by a typed field, with the same operators", async () => {
    const tag = runId("task");
    const field = `stage_${runId("f")}`;
    const num = `points_${runId("f")}`;
    const put = await api.put(`/tags/${enc(tag)}`, { fields: { [field]: { type: "string", indexed: true }, [num]: { type: "integer", indexed: true } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r = runId("types");
    await writer.post("/notes", { content: "o", path: `${r}/open`, tags: [tag], metadata: { [field]: "open", [num]: 3 } });
    await writer.post("/notes", { content: "d", path: `${r}/done`, tags: [tag], metadata: { [field]: "done", [num]: 8 } });
    expect(paths((await writer.get(`/notes?tag=${tag}&meta[${field}][eq]=open`)).body)).toEqual([`${r}/open`]);
    expect(paths((await writer.get(`/notes?tag=${tag}&meta[${field}]=done`)).body)).toEqual([`${r}/done`]);
    expect(paths((await writer.get(`/notes?tag=${tag}&meta[${num}][gte]=5`)).body)).toEqual([`${r}/done`]);
    expect(paths((await writer.get(`/notes?tag=${tag}&meta[${field}][in]=open,done`)).body)).toEqual([`${r}/done`, `${r}/open`]);
    const badOp = await writer.get(`/notes?tag=${tag}&meta[${field}][nope]=x`);
    fp("types/refusal.unknown-operator", refusal(badOp));
    const badType = await api.put(`/tags/${enc(runId("task"))}`, { fields: { [`n_${runId("f")}`]: { type: "number", indexed: true } } });
    expect(badType.status).toBe(400);
    fp("types/refusal.unindexable-type", refusal(badType));
  });

  test("two types that disagree about a shared field's type are refused, not silently merged", async () => {
    const field = `when_${runId("f")}`;
    expect((await api.put(`/tags/${enc(runId("a"))}`, { fields: { [field]: { type: "date", indexed: true } } })).status).toBe(200);
    const second = await api.put(`/tags/${enc(runId("b"))}`, { fields: { [field]: { type: "integer", indexed: true } } });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    fp("types/refusal.field-type-clash", refusal(second));
  });

  test("a type can be renamed and deleted, and its notes follow", async () => {
    const [from, to] = [runId("old"), runId("new")];
    await api.put(`/tags/${enc(from)}`, { fields: { a: { type: "string" } } });
    const r = runId("types");
    await writer.post("/notes", { content: "x", path: `${r}/x`, tags: [from] });
    const ren = await api.post(`/tags/${enc(from)}/rename`, { new_name: to });
    expect(ren.status, JSON.stringify(ren.body)).toBe(200);
    fp("types/rename.shape", shape(ren.body));
    expect((await writer.get(`/notes/${enc(`${r}/x`)}`)).body.tags).toEqual([to]);
    const del = await api.del(`/tags/${enc(to)}`);
    expect(del.status).toBe(200);
    fp("types/delete.shape", shape(del.body));
    expect((await writer.get(`/notes/${enc(`${r}/x`)}`)).body.tags).toEqual([]);
  });
});
