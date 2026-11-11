// 0.9.2 row 5, "`doctor` additions": the declared-reference gap, near names, and the indexed-field count with a
// teaching refusal near 88 (SPEC §8: cloud keeps every indexed field as a column, 100 columns per table, 12 taken).
//
// Proposed, not decided: the refusal at the 89th indexed field holds on every door, not only cloud, so a vault never
// meets the limit late when it moves from a box to cloud (one system). If the build keeps it cloud-only, this
// contract needs a `lacks` entry for the box in suites/door/deliberate.json, and Aaron decides.
import { describe, expect, test } from "bun:test";
import { door, enc, rest, runId } from "../door/_door.ts";
import { findings, must, red, said } from "./_v092.ts";

const api = rest("admin");
const writer = rest("write");
const LANE = "0.9.2 doctor";

describe("0.9.2 doctor additions", () => {
  test("setup: doctor answers an admin today", async () => {
    const doc = await api.get("/doctor");
    expect(doc.status).toBe(200);
    expect(Array.isArray(doc.body.findings)).toBe(true);
  });

  red("doctor finds a field whose values name records but that no type declares a reference", { reason: /^doctor: no reference-gap finding/, lane: LANE }, async () => {
    const r = runId("dr");
    const field = `project_${runId("f")}`;
    for (const p of ["alder", "birch"]) await writer.post("/notes", { content: "", path: `${r}/projects/${p}` });
    for (let i = 0; i < 4; i++) await writer.post("/notes", { content: "", path: `${r}/tasks/${i}`, metadata: { [field]: `${r}/projects/${i % 2 ? "alder" : "birch"}` } });
    const doc = await api.get("/doctor");
    const mine = findings(doc.body).filter((x) => /reference/.test(x.type) && said(x).includes(field));
    must(mine.length > 0, `doctor: no reference-gap finding for ${field}: ${said(findings(doc.body).map((x) => x.type))}`);
    must(said(mine).includes("reference"), `the finding doesn't say to declare it a reference: ${said(mine).slice(0, 300)}`);
  });

  red("doctor finds two type names one letter apart", { reason: /^doctor: no near-name finding/, lane: LANE }, async () => {
    const base = `ledger${runId("n")}`;
    const near = `${base}s`;
    await api.put(`/tags/${enc(base)}`, { fields: { amount_due: { type: "integer" } } });
    await api.put(`/tags/${enc(near)}`, { fields: { amount_due: { type: "integer" } } });
    const doc = await api.get("/doctor");
    const mine = findings(doc.body).filter((x) => said(x).includes(base) && said(x).includes(near));
    must(mine.length > 0, `doctor: no near-name finding for ${base} and ${near}: ${said(findings(doc.body).map((x) => x.type))}`);
  });

  red("doctor finds two field names one letter apart", { reason: /^doctor: no near-name finding/, lane: LANE }, async () => {
    const field = `due_on_${runId("f")}`;
    const near = field.replace("due_on", "dueon");
    const r = runId("dr");
    await writer.post("/notes", { content: "", path: `${r}/a`, metadata: { [field]: "2026-11-10" } });
    await writer.post("/notes", { content: "", path: `${r}/b`, metadata: { [near]: "2026-11-11" } });
    const doc = await api.get("/doctor");
    const mine = findings(doc.body).filter((x) => said(x).includes(field) && said(x).includes(near));
    must(mine.length > 0, `doctor: no near-name finding for ${field} and ${near}: ${said(findings(doc.body).map((x) => x.type))}`);
  });

  red("doctor counts indexed fields against the limit of 88, and the 89th is refused with what to prune", { reason: /^doctor: no indexed-field count/, lane: LANE }, async () => {
    // On the run's second vault, so the 88 columns don't land on the vault the other contracts use.
    const other = rest("admin", door().otherVault);
    const tag = runId("ix");
    const fields: Record<string, unknown> = {};
    const have = (await other.get("/tags?include_schema=true")).body;
    const already = new Set<string>();
    for (const t of Array.isArray(have) ? have : []) for (const [k, v] of Object.entries<any>(t.fields ?? {})) if (v?.indexed) already.add(k);
    for (let i = 0; already.size + Object.keys(fields).length < 88; i++) fields[`ix${i}_${runId("f")}`] = { type: "string", indexed: true };
    const put = await other.put(`/tags/${enc(tag)}`, { fields });
    must(put.status === 200, `setup: declaring 88 indexed fields gave ${put.status} ${said(put.body).slice(0, 200)}`);
    const doc = await other.get("/doctor");
    must(/"(count|indexed_fields?)"?[^}]{0,80}\b88\b/.test(said(doc.body)), `doctor: no indexed-field count of 88: ${said(doc.body).slice(0, 400)}`);
    const over = await other.put(`/tags/${enc(`${tag}b`)}`, { fields: { [`ix_over_${runId("f")}`]: { type: "string", indexed: true } } });
    must(over.status >= 400 && over.status < 500, `the 89th indexed field was accepted: ${over.status}`);
    must(/prune|unused/i.test(said(over.body)), `the refusal doesn't say what to prune: ${said(over.body).slice(0, 300)}`);
  });
});
