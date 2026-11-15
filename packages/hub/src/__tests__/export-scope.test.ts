/**
 * The backup scope `vault:<name>:export` (0.9.3) at the hub: who may be granted it and which vault it binds to.
 * The vault side (a key holding only it opens GET /api/export and nothing else) is pinned black-box in
 * contracts/suites/door/exit.test.ts; these are the hub-side edges that suite can't reach on a one-owner box.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { inferAudience } from "../jwt-audience.ts";
import { capScopesToUserAuthority } from "../oauth-handlers.ts";
import { canGrant } from "../scope-attenuation.ts";
import { createUser } from "../users.ts";

let db: Database;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-export-scope-"));
  db = openHubDb(hubDbPath(dir));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("vault:<name>:export", () => {
  test("a token that carries it is bound to that vault's audience (a CLI or manage-keys mint sets no --aud)", () => {
    expect(inferAudience(["vault:arcade:export"])).toBe("vault.arcade");
  });

  test("a host:auth bearer or an admin of that vault may mint it; an admin of another vault or a reader may not", () => {
    expect(canGrant(["parachute:host:auth"], "vault:arcade:export")).toBe(true);
    expect(canGrant(["vault:arcade:admin"], "vault:arcade:export")).toBe(true);
    expect(canGrant(["vault:other:admin"], "vault:arcade:export")).toBe(false);
    expect(canGrant(["vault:arcade:write"], "vault:arcade:export")).toBe(false);
    expect(canGrant(["vault:arcade:read"], "vault:arcade:export")).toBe(false);
  });

  test("an OAuth consent can't hand it to someone who is not the owner, for any vault, held or not", async () => {
    await createUser(db, "owner", "owner-passphrase-1");
    const friend = await createUser(db, "friend", "friend-passphrase-1", { allowMulti: true });
    for (const v of ["arcade", "other"]) {
      expect(capScopesToUserAuthority(db, friend.id, [`vault:${v}:export`], { userIsAdmin: false })).toEqual([]);
    }
    // The owner may consent to it.
    expect(capScopesToUserAuthority(db, friend.id, ["vault:arcade:export"], { userIsAdmin: true })).toEqual(["vault:arcade:export"]);
  });
});
