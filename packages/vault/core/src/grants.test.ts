// The grant rules a vault holds itself (docs/SPEC-1.0-grants.md, first slice). The door contracts
// (contracts/suites/door/typed-keys.test.ts) hold what a key can reach; these hold what the door can't show from
// outside, because the hub refuses a revoked token before the vault sees it: an ended grant stays ended, a date ends
// it, an id is never reused, and a grant the vault can't hold is refused rather than read around.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { checkDoorGrant, endGrant, fileDoorGrant, getGrant, grantReach, grantState, listGrants } from "./grants.ts";

const now = new Date("2026-11-21T12:00:00Z");
const later = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
});

const recipes = { grantee: "key:claude", types: { recipe: ["read", "create", "update", "delete"] }, expires_at: later(30) };

describe("a door grant", () => {
  it("is in force when filed, ends by revoke for good, and by its date", () => {
    expect(fileDoorGrant(db, "claude", recipes, now)).toBe("filed");
    expect(grantState(getGrant(db, "claude")!, now)).toBe("in_force");
    expect(grantState(getGrant(db, "claude")!, new Date(Date.parse(later(31))))).toBe("expired");
    expect(endGrant(db, "claude", now)?.revoked_at).toBe(now.toISOString());
    expect(grantState(getGrant(db, "claude")!, now)).toBe("revoked");
    // Filed again, the ended id doesn't come back.
    expect(fileDoorGrant(db, "claude", recipes, now)).toBe("taken");
    expect(grantState(getGrant(db, "claude")!, now)).toBe("revoked");
    // Nothing is deleted.
    expect(listGrants(db).map((g) => g.id)).toEqual(["claude"]);
  });

  it("is one grant per id: the same content again is a no-op, other content is refused", () => {
    expect(fileDoorGrant(db, "claude", recipes, now)).toBe("filed");
    expect(fileDoorGrant(db, "claude", recipes, now)).toBe("same");
    expect(fileDoorGrant(db, "claude", { ...recipes, types: { recipe: ["read"], journal: ["read"] } }, now)).toBe("taken");
    expect(getGrant(db, "claude")!.types).toEqual({ recipe: ["read", "create", "update", "delete"] });
  });

  it("reaches its types, and writes only when it can", () => {
    fileDoorGrant(db, "reader", { ...recipes, grantee: "key:reader", types: { recipe: ["read"] } }, now);
    expect(grantReach(getGrant(db, "reader")!)).toEqual({ types: ["recipe"], write: false });
    fileDoorGrant(db, "claude", recipes, now);
    expect(grantReach(getGrant(db, "claude")!)).toEqual({ types: ["recipe"], write: true });
  });

  it("is unknown on a vault that never filed one", () => {
    expect(getGrant(db, "claude")).toBeNull();
    expect(endGrant(db, "claude", now)).toBeNull();
  });
});

describe("what a vault refuses to file", () => {
  const problem = (id: string, body: unknown) => {
    const r = checkDoorGrant(id, body, now);
    return "problem" in r ? r.problem : null;
  };
  it("takes a grant it can hold", () => {
    expect(problem("claude", recipes)).toBeNull();
    expect(problem("claude", { ...recipes, types: { recipe: ["read"], cook_log: ["read"] } })).toBeNull();
  });
  it("refuses an unknown field, never reading around it", () => {
    expect(problem("claude", { ...recipes, deny: ["private"] })).toContain("unknown field");
  });
  it("refuses verbs it doesn't hold yet, mixed verbs, every record, and no types", () => {
    expect(problem("claude", { ...recipes, types: { recipe: ["create"] } })).toContain("read");
    expect(problem("claude", { ...recipes, types: { recipe: ["read", "admin"] } })).toContain("verbs");
    expect(problem("claude", { ...recipes, types: { recipe: ["read"], journal: ["read", "create", "update", "delete"] } })).toContain("same verbs");
    expect(problem("claude", { ...recipes, types: { "*": ["read"] } })).toContain("can't be granted");
    expect(problem("claude", { ...recipes, types: {} })).toContain("types");
  });
  it("refuses a date past, or more than 366 days out, and a bad id", () => {
    expect(problem("claude", { ...recipes, expires_at: later(-1) })).toContain("future");
    expect(problem("claude", { ...recipes, expires_at: later(367) })).toContain("366");
    expect(problem("has space", recipes)).toContain("id");
  });
});
