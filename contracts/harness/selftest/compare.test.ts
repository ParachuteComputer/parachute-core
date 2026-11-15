// compare(): with a box on the release line, each other door is held to the box, never to another cloud-style door.
import { describe, expect, test } from "bun:test";
import { compare, type Deliberate } from "../doors/compare.ts";

const fp = (o: Record<string, unknown>) => new Map(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
const box = fp({ "a/approval": "consent screen", "a/stamp": "key:<client>", "a/same": 1 });
const cloud = fp({ "a/approval": "consent screen", "a/stamp": "mcp", "a/same": 1 });
const personal = fp({ "a/approval": "none", "a/stamp": "key:<client>", "a/same": 1 });
const deliberate: Deliberate[] = [
  { id: "stamp", keys: ["a/stamp"], between: ["box", "cloud"], status: "drift", owner: "t", why: "t" },
  { id: "approval", keys: ["a/approval"], between: ["box", "personal"], status: "drift", owner: "t", why: "t" },
];

describe("compare", () => {
  test("cloud and personal are each compared with the box, not with each other", () => {
    const r = compare({ "box-0.9.1": box, "cloud-0.9.1": cloud, "personal-0.9.1": personal }, deliberate);
    expect(r.summary).toStartWith("PASS compare (2 pairs;");
  });
  test("an unnamed difference from the box still fails", () => {
    const r = compare({ "box-0.9.1": box, "cloud-0.9.1": fp({ "a/approval": "consent screen", "a/stamp": "key:<client>", "a/same": 2 }) }, deliberate);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("1 unexplained");
  });
  test("with no box on the line, the doors there are still compared with each other", () => {
    const r = compare({ "cloud-0.9.1": cloud, "personal-0.9.1": personal }, deliberate);
    expect(r.summary).toContain("1 pair;");
  });
});
