// The write stamp's pure rule: the permission check and the name rules (the doors' contracts are safety/on-behalf).
import { describe, expect, test } from "bun:test";
import { grantNameProblem, parseActsForClaim, parseKeyClaim, prefixProblem, resolveBy, StampClaimError } from "./write-stamp.ts";

describe("resolveBy", () => {
  test("no value: the token's own principal", () => {
    expect(resolveBy(undefined, null, "u1", "rest")).toEqual({ by: "u1" });
    // A parameter sent as null is a value, not an absence: refused like any other.
    expect("refusal" in resolveBy(null, null, "u1", "mcp")).toBe(true);
    expect("refusal" in resolveBy(null, "fernhill", "u1", "mcp")).toBe(true);
  });

  test("a value without the permission is refused, never ignored, and names how the owner grants it", () => {
    const r = resolveBy("client-42", null, "u1", "rest") as { refusal: { status: number; error_type: string; message: string } };
    expect(r.refusal.status).toBe(403);
    expect(r.refusal.error_type).toBe("on_behalf_not_allowed");
    expect(r.refusal.message).toContain("Parachute-On-Behalf-Of");
    expect(r.refusal.message).toContain("on_behalf_of: true");
    // Even an empty or malformed value is refused, not dropped.
    expect("refusal" in resolveBy("", null, "u1", "mcp")).toBe(true);
  });

  test("with the permission: the prefix from the token, only the id from the request", () => {
    expect(resolveBy("client-42", "fernhill", "u1", "rest")).toEqual({ by: "fernhill:client-42" });
    expect(resolveBy("A.b_c-9", "unforced.dev", "u1", "mcp")).toEqual({ by: "unforced.dev:A.b_c-9" });
  });

  test("an id that could reach outside the prefix is refused", () => {
    for (const bad of ["nostr:abc", "x:y", "mara@fernhill.example", "a".repeat(65), "", "two words", 42, {}, "é"]) {
      const r = resolveBy(bad, "fernhill", "u1", "rest");
      expect("refusal" in r, String(bad)).toBe(true);
      expect((r as { refusal: { status: number } }).refusal.status).toBe(400);
    }
    expect(resolveBy("a".repeat(64), "fernhill", "u1", "rest")).toEqual({ by: `fernhill:${"a".repeat(64)}` });
  });
});

describe("names", () => {
  test("a prefix is lowercase [a-z0-9.-]{1,64} and never reserved", () => {
    expect(prefixProblem("unforced.dev")).toBeNull();
    for (const bad of ["Fernhill", "under_score", "a:b", "a@b", "", "a".repeat(65), "nostr", "key", "api", "mcp", "operator", 7]) {
      expect(prefixProblem(bad), String(bad)).not.toBeNull();
    }
    expect(grantNameProblem("surface")).toContain("reserved");
  });

  test("claims fail closed when present and malformed", () => {
    expect(parseKeyClaim(undefined)).toBeNull();
    expect(parseKeyClaim({ key: { name: "claude", kind: "app" } })).toEqual({ name: "claude", kind: "app" });
    for (const key of ["claude", { name: "claude" }, { name: "has space", kind: "app" }, { name: "c", kind: "robot" }, { name: "c", kind: "app", extra: 1 }]) {
      expect(() => parseKeyClaim({ key }), JSON.stringify(key)).toThrow(StampClaimError);
    }
    const k = { name: "fernhill", kind: "app" };
    expect(parseActsForClaim({ acts_for: "fernhill" }, k)).toBe("fernhill");
    expect(parseActsForClaim({ scoped_tags: ["a"] }, k)).toBeNull();
    expect(() => parseActsForClaim({ acts_for: "fernhill" }, null)).toThrow(StampClaimError); // needs a named key
    expect(() => parseActsForClaim({ acts_for: "nostr" }, k)).toThrow(StampClaimError);
    expect(() => parseActsForClaim({ acts_for: "Upper" }, k)).toThrow(StampClaimError);
  });
});
