// 0.9.2 row 2, "Safe schema change": a retype is refused while records disagree with it, and a dry-run migrate says
// what a retype would change before anything is written. Today a retype is accepted with no check, and after it the
// records that disagree can't be edited (T-378 perspective 8, measured); migrate is a CLI command only. The count a
// refusal needs exists already: `POST /api/tags/<type>/conformance {fields}` (store.countTagConformance) counts the
// records a proposed spec would violate. Build the refusal and the migrate plan on it, so the two can't disagree.
// The other half of the row (a type PUT walks references only when a reference field changes) is timed by the bench:
// at 94k a PUT on a type with a reference field returns in about 3 s today (BENCH-0.9.2.md).
//
// Wire shape assumed (proposed, not decided; change it here first if the build picks another):
//   PUT  /api/tags/<type> that retypes a field some records disagree with → 409 {error: "retype_conflict", field,
//        count, hint}; the type is unchanged.
//   POST /api/tags/<type>/migrate {field, transform: {kind: "to_string"|"to_int"|…}, apply?: false} → 200 a plan:
//        {would_change, errored, sample}; writes nothing unless `apply: true` (admin).
//   MCP  manage-types {action: "migrate", tag, field, transform, apply?} → the same plan.
import { beforeAll, describe, expect, test } from "bun:test";
import { enc, mcp, rest, runId } from "../door/_door.ts";
import { must, red, said } from "./_v092.ts";

const api = rest("admin");
const writer = rest("write");
const LANE = "0.9.2 schema";

const tag = runId("s092");
const f = runId("f");
const [count, label] = [`count_${f}`, `label_${f}`];
const r = runId("s");

beforeAll(async () => {
  const put = await api.put(`/tags/${enc(tag)}`, { fields: { [count]: { type: "integer", indexed: true }, [label]: { type: "string" } } });
  if (put.status !== 200) throw new Error(`setup: ${put.status} ${said(put.body)}`);
  for (const [i, n] of [3, 8, 13].entries()) {
    const made = await writer.post("/notes", { content: "", path: `${r}/${i}`, tags: [tag], metadata: { [count]: n, [label]: `item ${n}` } });
    if (made.status !== 201) throw new Error(`setup: ${made.status} ${said(made.body)}`);
  }
});

describe("0.9.2 safe schema change", () => {
  test("a retype every record already meets is accepted (it stays accepted)", async () => {
    // `label` holds strings everywhere; declaring it a strict string again changes nothing for the data.
    const put = await api.put(`/tags/${enc(tag)}`, { fields: { [count]: { type: "integer", indexed: true }, [label]: { type: "string", strict: true } } });
    expect(put.status, said(put.body)).toBe(200);
  });

  red("a retype that would strand records is refused, says how many, and leaves the type as it was", { reason: /^accepted: 200/, lane: LANE }, async () => {
    const put = await api.put(`/tags/${enc(tag)}`, { fields: { [count]: { type: "date", indexed: true }, [label]: { type: "string", strict: true } } });
    try {
      must(put.status >= 400 && put.status < 500, `accepted: ${put.status}`);
      must(said(put.body).includes(count), `the refusal doesn't name the field: ${said(put.body).slice(0, 300)}`);
      // The count, as a JSON number or in words: not a digit inside a name.
      must(/:\s*3[,}\]]|\b3 records?\b/.test(said(put.body)), `the refusal doesn't say how many records disagree (3): ${said(put.body).slice(0, 300)}`);
      const now = await api.get(`/tags/${enc(tag)}`);
      must(now.body.fields?.[count]?.type === "integer", `the type changed anyway: ${said(now.body.fields)}`);
    } finally {
      // Today the retype lands: put it back so the next contracts start from the declared type.
      if (put.status === 200) await api.put(`/tags/${enc(tag)}`, { fields: { [count]: { type: "integer", indexed: true }, [label]: { type: "string", strict: true } } });
    }
  });

  red("a dry-run migrate over REST says what a retype would change, and writes nothing", { reason: /^no migrate over REST: 404/, lane: LANE }, async () => {
    const plan = await api.post(`/tags/${enc(tag)}/migrate`, { field: count, transform: { kind: "to_string" } });
    must(plan.status !== 404, `no migrate over REST: ${plan.status}`);
    must(plan.status === 200, `migrate gave ${plan.status} ${said(plan.body).slice(0, 300)}`);
    must(said(plan.body).match(/would_change"?:\s*3\b/), `the plan doesn't say 3 records would change: ${said(plan.body).slice(0, 300)}`);
    const after = await writer.get(`/notes?tag=${tag}&meta[${count}][eq]=8`);
    must(after.body.length === 1 && after.body[0].metadata[count] === 8, `the dry run wrote: ${said(after.body).slice(0, 300)}`);
  });

  red("a dry-run migrate needs an admin credential", { reason: /^no migrate over REST: 404/, lane: LANE }, async () => {
    const plan = await writer.post(`/tags/${enc(tag)}/migrate`, { field: count, transform: { kind: "to_string" } });
    must(plan.status !== 404, `no migrate over REST: ${plan.status}`);
    must(plan.status === 403, `a write credential got ${plan.status}`);
  });

  red("over MCP, manage-types migrate gives the same dry-run plan", { reason: /^no migrate over MCP: .*manage-types has no parameter `field`/, lane: LANE }, async () => {
    const m = await mcp("admin");
    try {
      let plan: unknown;
      try {
        plan = await m.call("manage-types", { action: "migrate", tag, field: count, transform: { kind: "to_string" } });
      } catch (err) {
        must(false, `no migrate over MCP: ${(err as Error).message.slice(0, 300)}`);
      }
      must(said(plan).match(/would_change"?:\s*3\b/), `the plan doesn't say 3 records would change: ${said(plan).slice(0, 300)}`);
    } finally {
      await m.close();
    }
  });
});
