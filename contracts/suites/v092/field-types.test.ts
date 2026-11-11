// 0.9.2 row 3, "One data type per field: warn". SPEC §2.2: a field name holds one data type per vault, staged.
// 0.9.2 warns: every type on a record is checked (today the first type in the walk wins and the other's rules are
// "ignored"), and `doctor` reports a field holding values of more than one data type (today only for indexed fields).
// 1.0 refuses; that is not here.
import { describe, expect, test } from "bun:test";
import { enc, rest, runId } from "../door/_door.ts";
import { findings, must, red, said } from "./_v092.ts";

const api = rest("admin");
const writer = rest("write");
const LANE = "0.9.2 field types";

describe("0.9.2 one data type per field: warn", () => {
  test("setup: two types may declare one field with different enums today (the case below)", async () => {
    const field = `st_${runId("f")}`;
    expect((await api.put(`/tags/${enc(runId("ta"))}`, { fields: { [field]: { type: "string", enum: ["open", "done"] } } })).status).toBe(200);
    expect((await api.put(`/tags/${enc(runId("tb"))}`, { fields: { [field]: { type: "string", enum: ["todo", "done"] } } })).status).toBe(200);
  });

  red("a record with two types whose rules for a field disagree is checked against both, and warned by each it fails", { reason: /^not checked against/, lane: LANE }, async () => {
    const [A, B] = [runId("ta"), runId("tb")];
    const field = `st_${runId("f")}`;
    must((await api.put(`/tags/${enc(A)}`, { fields: { [field]: { type: "string", enum: ["open", "done"] } } })).status === 200, "setup: type A");
    must((await api.put(`/tags/${enc(B)}`, { fields: { [field]: { type: "string", enum: ["todo", "done"] } } })).status === 200, "setup: type B");
    const r = runId("ft");
    // "open" meets A and fails B; "todo" meets B and fails A. Whichever type comes first, each failure is warned.
    for (const [value, fails] of [["open", B], ["todo", A]] as const) {
      for (const order of [[A, B], [B, A]]) {
        const made = await writer.post("/notes", { content: "", path: `${r}/${value}-${order[0]}`, tags: order, metadata: { [field]: value } });
        must(made.status === 201, `setup: ${made.status} ${said(made.body)}`);
        const warnings: any[] = made.body.validation_status?.warnings ?? made.body.warnings ?? [];
        const fromFailing = warnings.some((w) => w.field === field && w.schema === fails && w.reason !== "schema_conflict");
        must(fromFailing, `not checked against ${fails === A ? "A" : "B"} (tags ${order[0] === A ? "A,B" : "B,A"}, value ${value}): ${said(warnings).slice(0, 400)}`);
      }
    }
  });

  red("doctor reports a field no type declares that holds two data types", { reason: /^doctor: no mixed-type finding/, lane: LANE }, async () => {
    const field = `mixed_${runId("f")}`;
    const r = runId("ft");
    must((await writer.post("/notes", { content: "", path: `${r}/n`, metadata: { [field]: 5 } })).status === 201, "setup: the number");
    must((await writer.post("/notes", { content: "", path: `${r}/s`, metadata: { [field]: "five" } })).status === 201, "setup: the string");
    const doc = await api.get("/doctor");
    must(doc.status === 200, `doctor gave ${doc.status}`);
    const mine = findings(doc.body).filter((x) => /mixed/.test(x.type) && said(x).includes(field));
    must(mine.length > 0, `doctor: no mixed-type finding for ${field}: ${said(findings(doc.body).map((x) => x.type))}`);
    must(said(mine).match(/integer|number/) && said(mine).includes("string"), `the finding doesn't name both data types: ${said(mine).slice(0, 300)}`);
  });

  red("doctor reports a declared field that isn't indexed and holds two data types", { reason: /^doctor: no mixed-type finding/, lane: LANE }, async () => {
    const tag = runId("ft");
    const field = `qty_${runId("f")}`;
    must((await api.put(`/tags/${enc(tag)}`, { fields: { [field]: { type: "integer" } } })).status === 200, "setup: the type");
    const r = runId("ft");
    must((await writer.post("/notes", { content: "", path: `${r}/n`, tags: [tag], metadata: { [field]: 5 } })).status === 201, "setup: the number");
    // A loose field: the wrong type is kept, with a warning.
    must((await writer.post("/notes", { content: "", path: `${r}/s`, tags: [tag], metadata: { [field]: "a few" } })).status === 201, "setup: the string");
    const doc = await api.get("/doctor");
    const mine = findings(doc.body).filter((x) => /mixed/.test(x.type) && said(x).includes(field));
    must(mine.length > 0, `doctor: no mixed-type finding for ${field}: ${said(findings(doc.body).map((x) => x.type))}`);
  });
});
