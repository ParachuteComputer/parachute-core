/**
 * A vault deleted and made again under the same name while the server runs (0.9.3, T-463): the open handle to the
 * old database file must not serve the new vault. The running server also lets go of a deleted vault's triggers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getVaultStore, evictVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { vaultDir } from "./config.ts";
import { openVaultDb } from "./db.ts";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = join(tmpdir(), `vault-recreate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "vault", "data"), { recursive: true });
  prev = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = home;
  clearVaultStoreCache();
});

afterEach(() => {
  if (prev === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prev;
  clearVaultStoreCache();
  rmSync(home, { recursive: true, force: true });
});

describe("getVaultStore after the vault's files are replaced", () => {
  test("the same name made again opens the new database, not the deleted one", async () => {
    const old = getVaultStore("again");
    await old.createNote("made-up: the heron counted nine pebbles", { path: "a" });
    expect((await old.queryNotes({})).length).toBe(1);

    // Deleted, then made again (the CLI's create): a new database file at the same path.
    rmSync(vaultDir("again"), { recursive: true, force: true });
    openVaultDb("again").close();
    const fresh = getVaultStore("again");
    expect(fresh).not.toBe(old);
    expect((await fresh.queryNotes({})).length).toBe(0);
    // The same file again: the cached store is kept.
    expect(getVaultStore("again")).toBe(fresh);
  });

  test("evictVaultStore closes the handle and the next call opens a new one", () => {
    const first = getVaultStore("gone");
    evictVaultStore("gone");
    expect(() => first.db.query("select 1").get()).toThrow();
    expect(getVaultStore("gone")).not.toBe(first);
  });
});
