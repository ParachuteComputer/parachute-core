/**
 * Unit tests for scope primitives — parse, match, inheritance, legacy
 * permission fallback. Integration tests for scope enforcement at the
 * HTTP boundary live in routing.test.ts + vault.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_ADMIN,
  SCOPE_MIGRATE,
  parseScopes,
  parseScopeFlags,
  hasScope,
  hasScopeForVault,
  hasMigrateScopeForVault,
  hasExportScopeForVault,
  isExportOnly,
  validateMintedScopes,
  findBroadVaultScopes,
  scopeForMethod,
  verbForMethod,
  legacyPermissionToScopes,
  serializeScopes,
} from "./scopes.ts";

describe("hasMigrateScopeForVault — migration-bypass capability (vault#299)", () => {
  test("broad vault:migrate satisfies any vault", () => {
    expect(hasMigrateScopeForVault([SCOPE_MIGRATE], "default")).toBe(true);
    expect(hasMigrateScopeForVault([SCOPE_MIGRATE], "anything")).toBe(true);
  });

  test("narrowed vault:<name>:migrate satisfies only that vault", () => {
    expect(hasMigrateScopeForVault(["vault:gitcoin:migrate"], "gitcoin")).toBe(true);
    expect(hasMigrateScopeForVault(["vault:gitcoin:migrate"], "default")).toBe(false);
  });

  test("admin does NOT imply migrate — orthogonal axis", () => {
    expect(hasMigrateScopeForVault([SCOPE_ADMIN], "default")).toBe(false);
    expect(hasMigrateScopeForVault(["vault:default:admin"], "default")).toBe(false);
  });

  test("no migrate scope → false", () => {
    expect(hasMigrateScopeForVault([SCOPE_WRITE, SCOPE_READ], "default")).toBe(false);
    expect(hasMigrateScopeForVault([], "default")).toBe(false);
  });
});

describe("parseScopes", () => {
  test("returns [] for null or empty input", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
  });

  test("splits on whitespace and trims", () => {
    expect(parseScopes("vault:read vault:write")).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(parseScopes("  vault:read   vault:write  ")).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(parseScopes("vault:read\tvault:write\nvault:admin")).toEqual([
      SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN,
    ]);
  });

  test("preserves vault:<name>:<verb> narrowed shape verbatim", () => {
    expect(parseScopes("vault:journal:read")).toEqual(["vault:journal:read"]);
    expect(parseScopes("vault:journal:write vault:work:admin")).toEqual([
      "vault:journal:write", "vault:work:admin",
    ]);
  });

  test("preserves unrecognized scopes verbatim", () => {
    expect(parseScopes("profile email")).toEqual(["profile", "email"]);
    expect(parseScopes("vault:unknown:frob")).toEqual(["vault:unknown:frob"]);
  });

  test("empty name segment is treated as unrecognized (vault::read stays literal)", () => {
    // Guard against a hand-crafted DB row with `vault::read` satisfying a
    // `vault:read` check by accident. Only reachable via direct DB write,
    // not API input, but the parser stays honest.
    expect(parseScopes("vault::read")).toEqual(["vault::read"]);
    expect(hasScope(parseScopes("vault::read"), SCOPE_READ)).toBe(false);
    expect(hasScopeForVault(parseScopes("vault::read"), "", "read")).toBe(false);
  });
});

describe("hasScope — inheritance admin ⊇ write ⊇ read", () => {
  test("exact match succeeds", () => {
    expect(hasScope([SCOPE_READ], SCOPE_READ)).toBe(true);
    expect(hasScope([SCOPE_WRITE], SCOPE_WRITE)).toBe(true);
    expect(hasScope([SCOPE_ADMIN], SCOPE_ADMIN)).toBe(true);
  });

  test("vault:write satisfies vault:read", () => {
    expect(hasScope([SCOPE_WRITE], SCOPE_READ)).toBe(true);
  });

  test("vault:admin satisfies vault:read and vault:write", () => {
    expect(hasScope([SCOPE_ADMIN], SCOPE_READ)).toBe(true);
    expect(hasScope([SCOPE_ADMIN], SCOPE_WRITE)).toBe(true);
  });

  test("vault:read does NOT satisfy vault:write or vault:admin", () => {
    expect(hasScope([SCOPE_READ], SCOPE_WRITE)).toBe(false);
    expect(hasScope([SCOPE_READ], SCOPE_ADMIN)).toBe(false);
  });

  test("vault:write does NOT satisfy vault:admin", () => {
    expect(hasScope([SCOPE_WRITE], SCOPE_ADMIN)).toBe(false);
  });

  test("empty granted list fails", () => {
    expect(hasScope([], SCOPE_READ)).toBe(false);
    expect(hasScope([], SCOPE_WRITE)).toBe(false);
    expect(hasScope([], SCOPE_ADMIN)).toBe(false);
  });

  test("non-vault scopes require exact match — no inheritance", () => {
    expect(hasScope(["profile"], "profile")).toBe(true);
    expect(hasScope(["profile"], "email")).toBe(false);
    expect(hasScope([SCOPE_ADMIN], "profile")).toBe(false);
  });

  test("narrowed grant satisfies broad query (more-specific is at-least-as-strong)", () => {
    expect(hasScope(["vault:work:write"], SCOPE_READ)).toBe(true);
    expect(hasScope(["vault:work:write"], SCOPE_WRITE)).toBe(true);
    expect(hasScope(["vault:work:write"], SCOPE_ADMIN)).toBe(false);
    expect(hasScope(["vault:work:admin"], SCOPE_ADMIN)).toBe(true);
  });

  test("broad query against narrowed query returns false (use hasScopeForVault for that)", () => {
    // hasScope refuses to answer narrowed queries — they need a vault context.
    expect(hasScope([SCOPE_ADMIN], "vault:work:read")).toBe(false);
    expect(hasScope(["vault:work:write"], "vault:work:read")).toBe(false);
  });
});

describe("hasScopeForVault — per-vault matching with inheritance", () => {
  test("broad grant satisfies any vault (caller pins via DB lookup / aud check)", () => {
    expect(hasScopeForVault([SCOPE_READ], "work", "read")).toBe(true);
    expect(hasScopeForVault([SCOPE_WRITE], "work", "read")).toBe(true);
    expect(hasScopeForVault([SCOPE_WRITE], "work", "write")).toBe(true);
    expect(hasScopeForVault([SCOPE_ADMIN], "anything", "admin")).toBe(true);
  });

  test("narrowed grant satisfies only the matching vault", () => {
    expect(hasScopeForVault(["vault:work:read"], "work", "read")).toBe(true);
    expect(hasScopeForVault(["vault:work:read"], "personal", "read")).toBe(false);
    expect(hasScopeForVault(["vault:work:write"], "work", "read")).toBe(true);
    expect(hasScopeForVault(["vault:work:admin"], "work", "write")).toBe(true);
  });

  test("narrowed grant does NOT satisfy a higher verb on its vault", () => {
    expect(hasScopeForVault(["vault:work:read"], "work", "write")).toBe(false);
    expect(hasScopeForVault(["vault:work:write"], "work", "admin")).toBe(false);
  });

  test("mixed grant — narrowed for one vault, broad fallback nowhere", () => {
    expect(hasScopeForVault(["vault:work:write"], "personal", "read")).toBe(false);
  });

  test("empty grant fails everywhere", () => {
    expect(hasScopeForVault([], "any", "read")).toBe(false);
  });
});

describe("findBroadVaultScopes", () => {
  test("returns broad vault scopes only", () => {
    expect(findBroadVaultScopes([SCOPE_READ, SCOPE_WRITE])).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(findBroadVaultScopes(["vault:work:read"])).toEqual([]);
    expect(findBroadVaultScopes([SCOPE_READ, "vault:work:write", "profile"])).toEqual([SCOPE_READ]);
    expect(findBroadVaultScopes([])).toEqual([]);
  });
});

describe("scopeForMethod / verbForMethod", () => {
  test("read methods → vault:read / read", () => {
    expect(scopeForMethod("GET")).toBe(SCOPE_READ);
    expect(scopeForMethod("HEAD")).toBe(SCOPE_READ);
    expect(scopeForMethod("OPTIONS")).toBe(SCOPE_READ);
    expect(scopeForMethod("get")).toBe(SCOPE_READ); // case-insensitive
    expect(verbForMethod("GET")).toBe("read");
  });

  test("write methods → vault:write / write", () => {
    expect(scopeForMethod("POST")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("PATCH")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("PUT")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("DELETE")).toBe(SCOPE_WRITE);
    expect(verbForMethod("POST")).toBe("write");
  });

  test("unknown method falls back to write (default-deny)", () => {
    expect(scopeForMethod("TRACE")).toBe(SCOPE_WRITE);
    expect(verbForMethod("TRACE")).toBe("write");
  });
});

describe("legacyPermissionToScopes", () => {
  test("'read' → [vault:read]", () => {
    expect(legacyPermissionToScopes("read")).toEqual([SCOPE_READ]);
  });

  test("'full' and anything else → [read, write, admin]", () => {
    expect(legacyPermissionToScopes("full")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
    expect(legacyPermissionToScopes("admin")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
    expect(legacyPermissionToScopes("write")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
  });
});

describe("parseScopeFlags", () => {
  test("returns null scopes when --scope is absent", () => {
    expect(parseScopeFlags([])).toEqual({ scopes: null, error: null });
    expect(parseScopeFlags(["--vault", "default", "--label", "x"]))
      .toEqual({ scopes: null, error: null });
  });

  test("single --scope with one value", () => {
    expect(parseScopeFlags(["--scope", "vault:read"]))
      .toEqual({ scopes: [SCOPE_READ], error: null });
  });

  test("single --scope with comma-separated values", () => {
    expect(parseScopeFlags(["--scope", "vault:read,vault:write"]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("repeated --scope flags", () => {
    expect(parseScopeFlags(["--scope", "vault:read", "--scope", "vault:write"]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("dedupes while preserving first-occurrence order", () => {
    expect(parseScopeFlags(["--scope", "vault:write,vault:read,vault:write"]))
      .toEqual({ scopes: [SCOPE_WRITE, SCOPE_READ], error: null });
  });

  test("trims whitespace around each scope", () => {
    expect(parseScopeFlags(["--scope", "  vault:read ,  vault:write  "]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("rejects unknown scopes with a helpful error", () => {
    const result = parseScopeFlags(["--scope", "vault:frob"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("Unknown scope");
    expect(result.error).toContain("vault:frob");
    expect(result.error).toContain("vault:read, vault:write, vault:admin");
  });

  test("rejects a mixed list with one invalid scope", () => {
    const result = parseScopeFlags(["--scope", "vault:read,admin"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("admin");
  });

  test("rejects --scope with no value (end of argv)", () => {
    const result = parseScopeFlags(["--scope"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("--scope requires a value");
  });

  test("rejects --scope followed by another flag", () => {
    const result = parseScopeFlags(["--scope", "--label", "x"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("--scope requires a value");
  });

  test("rejects --scope with an empty value", () => {
    const result = parseScopeFlags(["--scope", ""]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("empty");
  });

  test("rejects --scope with only commas", () => {
    const result = parseScopeFlags(["--scope", ",,"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("empty");
  });
});

describe("serializeScopes — round-trips with parseScopes", () => {
  test("joins with spaces", () => {
    expect(serializeScopes([SCOPE_READ, SCOPE_WRITE])).toBe("vault:read vault:write");
    expect(serializeScopes([])).toBe("");
  });

  test("serialize then parse is the identity (for known scopes)", () => {
    const scopes = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
    expect(parseScopes(serializeScopes(scopes))).toEqual(scopes);
  });
});

describe("vault:export, the backup scope (0.9.3)", () => {
  test("a key holding only the export scope passes no read, write or admin check", () => {
    for (const held of [["vault:v:export"], ["vault:export"]]) {
      for (const verb of ["read", "write", "admin"] as const) expect(hasScopeForVault(held, "v", verb)).toBe(false);
      expect(hasScope(held, SCOPE_READ)).toBe(false);
      expect(hasMigrateScopeForVault(held, "v")).toBe(false);
      expect(isExportOnly(held, "v")).toBe(true);
    }
  });

  test("narrowed export names its vault; read, write and admin do not grant export", () => {
    expect(hasExportScopeForVault(["vault:v:export"], "v")).toBe(true);
    expect(hasExportScopeForVault(["vault:v:export"], "other")).toBe(false);
    for (const s of ["vault:v:read", "vault:v:write", "vault:v:admin", SCOPE_ADMIN]) expect(hasExportScopeForVault([s], "v")).toBe(false);
    // Lookalikes grant nothing.
    for (const s of ["vault:v:EXPORT", "vault::export", "vault:v:export:x", "export"]) expect(hasExportScopeForVault([s], "v")).toBe(false);
  });

  test("a key with read as well as export is not export-only", () => {
    expect(isExportOnly(["vault:v:read", "vault:v:export"], "v")).toBe(false);
    // Read on another vault doesn't make it more than export-only here.
    expect(isExportOnly(["vault:other:read", "vault:v:export"], "v")).toBe(true);
  });

  test("a hub token may not carry the broad form", () => {
    expect(findBroadVaultScopes(["vault:export"])).toEqual(["vault:export"]);
    expect(findBroadVaultScopes(["vault:v:export"])).toEqual([]);
  });

  test("only an admin of the vault may mint it, and only for that vault", () => {
    expect(validateMintedScopes(["vault:v:export"], "v", ["vault:v:admin"])).toEqual({ ok: true });
    expect(validateMintedScopes(["vault:v:export"], "v", ["vault:v:write"]).ok).toBe(false);
    expect(validateMintedScopes(["vault:v:export"], "v", ["vault:v:read"]).ok).toBe(false);
    expect(validateMintedScopes(["vault:other:export"], "v", ["vault:v:admin"]).ok).toBe(false);
  });
});
