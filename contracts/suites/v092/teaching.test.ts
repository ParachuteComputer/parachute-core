// 0.9.2 row 4, "Teaching, through one eval". The eval is the gate for the words (SPEC §4.5): these contracts hold
// only what is deterministic at the door, so the eval and the door can't drift apart.
//   - the nearest existing name when a new type or field is close to one (a warning, never a refusal);
//   - the tag map in `vault-info` capped, saying how many types there are;
//   - the four field options that exist but aren't taught (`reference`, `required`, `strict`, `cardinality`) are in
//     manage-types' own schema, which an AI reads without asking for help;
//   - query-records says search needs every word.
// "Invent a type when none fits" is words only, judged by the eval (reported apart), so it has no contract here.
import { describe, expect, test } from "bun:test";
import { enc, mcp, rest, runId } from "../door/_door.ts";
import { must, otherMcp, red, said } from "./_v092.ts";

const api = rest("admin");
const LANE = "0.9.2 teaching";

describe("0.9.2 teaching", () => {
  red("a new type one letter from an existing type is accepted with a warning naming the existing one", { reason: /^no nearest-name warning/, lane: LANE }, async () => {
    const base = `meeting${runId("n")}`;
    const near = base.replace("meeting", "meetng");
    expect((await api.put(`/tags/${enc(base)}`, { fields: { held_on: { type: "date" } } })).status).toBe(200);
    const m = await mcp("write");
    try {
      const made: any = await m.call("create-record", { path: `${runId("t")}/x`, types: [near], fields: { held_on: "2026-11-10" } });
      must(said(made).includes(`"${base}"`) || said(made).includes(`'${base}'`) || said(made).includes(`\\"${base}\\"`), `no nearest-name warning for ${near}: ${said(made).slice(0, 400)}`);
    } finally {
      await m.close();
    }
  });

  red("a new field one letter from a field the type declares is kept, with a warning naming the declared one", { reason: /^no nearest-name warning/, lane: LANE }, async () => {
    const tag = runId("t");
    const field = `status_${runId("f")}`;
    const near = field.replace("status", "stauts");
    expect((await api.put(`/tags/${enc(tag)}`, { fields: { [field]: { type: "string" } } })).status).toBe(200);
    const made = await rest("write").post("/notes", { content: "", path: `${runId("t")}/y`, tags: [tag], metadata: { [near]: "open" } });
    expect(made.status).toBe(201);
    expect(made.body.metadata[near]).toBe("open");
    must(said(made.body.validation_status ?? made.body.warnings).includes(field), `no nearest-name warning for ${near}: ${said(made.body.validation_status ?? made.body.warnings ?? null).slice(0, 300)}`);
  });

  red("vault-info's tag map is capped: with 700 types it fits in about 4,000 tokens and says how many there are", { reason: /^uncapped: /, lane: LANE }, async () => {
    // The largest vault moving to cloud has 688 type names; at its shape the map is 5.7k of vault-info's 9k tokens.
    // Filled on the run's second vault, so the other contracts' vault stays small.
    const m = await otherMcp();
    try {
      const prefix = runId("cap");
      const batch = 25;
      for (let i = 0; i < 700; i += batch) {
        await Promise.all(Array.from({ length: batch }, (_, k) => m.call("manage-types", { action: "update", tag: `${prefix}/t${String(i + k).padStart(3, "0")}`, description: "A made-up type with two fields", fields: { [`a${(i + k) % 40}`]: { type: "string" }, [`n${(i + k) % 40}`]: { type: "integer" } } })));
      }
      const vi: any = await m.call("vault-info", {});
      const size = said(vi).length;
      // 16,000 characters is about 4,000 tokens: the writer-list budget the 0.9.1 multi-vault door is held to.
      must(size <= 16_000, `uncapped: vault-info is ${size} characters with 700 types`);
      // The total is a number somewhere in the reply (a JSON value of 700 or more: the run's types plus the seed's).
      must(/:\s*7\d\d[,}\]]/.test(said(vi)), `capped, but it doesn't say how many types there are (700+)`);
    } finally {
      await m.close();
    }
  });

  red("manage-types' own schema teaches reference, required, strict and cardinality, without a call to help", { reason: /^untaught: /, lane: LANE }, async () => {
    // The full reference (`vault-info {help: "manage-types"}`) already has all four; an AI that doesn't ask for it
    // sees only the tool's description and input schema, and that is where they're missing today.
    const m = await mcp("read");
    try {
      const tool = said((await m.tools()).find((t) => t.name === "manage-types"));
      const missing = ["reference", "required", "strict", "cardinality"].filter((w) => !tool.includes(w));
      must(missing.length === 0, `untaught: ${missing.join(", ")}`);
    } finally {
      await m.close();
    }
  });

  red("query-records says that search needs every word", { reason: /^untaught: search/, lane: LANE }, async () => {
    const m = await mcp("read");
    try {
      const tool = (await m.tools()).find((t) => t.name === "query-records");
      const help = said(await m.call("vault-info", { help: "query-records" }));
      const text = `${said(tool)} ${help}`;
      must(/every word|all (the )?words|each word/i.test(text), `untaught: search needs every word`);
    } finally {
      await m.close();
    }
  });
});
