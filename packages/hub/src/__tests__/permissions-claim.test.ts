// The tag-attenuation rule for the mint endpoint (fix 13) and the key allowlist (fix 14): a security check whose
// edge cases are the point. The endpoint-level behaviour is covered black-box by parachute-core's
// contracts/suites/safety (mint-attenuation, permissions-fail-closed).
import { describe, expect, test } from "bun:test";
import { bearerPermissionsProblem, scopedTagsWiderThanMinter, unknownPermissionKeys } from "../permissions-claim.ts";

describe("unknownPermissionKeys", () => {
  test("only scoped_tags and principal_pubkey are known", () => {
    expect(unknownPermissionKeys({ scoped_tags: ["a"], principal_pubkey: "x" })).toEqual([]);
    expect(unknownPermissionKeys({ vault: {}, write_tags: [], scoped_tags: ["a"] })).toEqual(["vault", "write_tags"]);
  });
});

describe("bearerPermissionsProblem", () => {
  test("a minting pass with unknown or malformed permissions can't mint", () => {
    expect(bearerPermissionsProblem(undefined)).toBeNull();
    expect(bearerPermissionsProblem({ scoped_tags: ["a"], principal_pubkey: "x" })).toBeNull();
    expect(bearerPermissionsProblem({ write_tags: ["a"] })).toContain("write_tags");
    expect(bearerPermissionsProblem("scoped")).toContain("malformed");
    expect(bearerPermissionsProblem([])).toContain("malformed");
  });
});

describe("scopedTagsWiderThanMinter", () => {
  test("an unscoped minter may ask for any tags, or none", () => {
    expect(scopedTagsWiderThanMinter(undefined, undefined)).toBeNull();
    expect(scopedTagsWiderThanMinter({}, { scoped_tags: ["x"] })).toBeNull();
    expect(scopedTagsWiderThanMinter({ scoped_tags: null }, undefined)).toBeNull();
    expect(scopedTagsWiderThanMinter({ principal_pubkey: "ab" }, undefined)).toBeNull();
  });

  test("a scoped minter may ask for its own tags or tags under them", () => {
    expect(scopedTagsWiderThanMinter({ scoped_tags: ["health"] }, { scoped_tags: ["health"] })).toBeNull();
    expect(scopedTagsWiderThanMinter({ scoped_tags: ["health", "work"] }, { scoped_tags: ["health/food", "work"] })).toBeNull();
  });

  test("a scoped minter may not ask for no tags, other tags, or a name that only starts the same", () => {
    const minter = { scoped_tags: ["health"] };
    expect(scopedTagsWiderThanMinter(minter, undefined)).toContain("only mint passes limited to those tags");
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: [] })).not.toBeNull();
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: null })).not.toBeNull();
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: ["work"] })).toContain('"work"');
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: ["health", "work"] })).toContain('"work"');
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: ["healthy"] })).toContain('"healthy"');
    expect(scopedTagsWiderThanMinter(minter, { scoped_tags: [5] })).not.toBeNull();
  });

  test("a minter whose own tags are malformed may mint nothing tag-limited or not", () => {
    for (const bad of ["health", [], [""], [5], {}]) {
      expect(scopedTagsWiderThanMinter({ scoped_tags: bad }, { scoped_tags: ["health"] })).toContain("malformed");
    }
  });
});
