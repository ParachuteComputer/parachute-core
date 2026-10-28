// The two checks every command makes on its home (home.ts). The contracts hold them end to end
// (contracts/suites/embedded/newer-data, modes); these hold the corners a contract can't reach cheaply: a symlink
// out of the home, an unreadable file, a WAL left by a crash.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerData, repairModes, schemaOf } from "./home.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pcore-home-"));
  made.push(d);
  return d;
}
const mode = (p: string) => statSync(p).mode & 0o777;

/** A WAL-mode database with schema_version rows 1..top, closed cleanly (no -wal left). */
function db(path: string, top: number): void {
  const d = new Database(path);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let v = 1; v <= top; v++) d.run("INSERT INTO schema_version VALUES (?, ?)", [v, "2026-10-27T00:00:00Z"]);
  d.close();
}

describe("newerData", () => {
  test("names a newer hub.db and a newer vault, and passes an older or equal one", () => {
    const home = tmp();
    db(join(home, "hub.db"), 25);
    for (const [name, top] of [["a", 32], ["b", 33], ["c", 20]] as const) {
      mkdirSync(join(home, "vault", "data", name), { recursive: true });
      db(join(home, "vault", "data", name, "vault.db"), top);
    }
    expect(newerData(home, { hub: 24, vault: 32 })).toEqual([
      "hub.db is at schema 25; this program knows up to 24",
      "vault/data/b/vault.db is at schema 33; this program knows up to 32",
    ]);
    expect(newerData(home, { hub: 25, vault: 33 })).toEqual([]);
  });

  test("reads without leaving a -wal or -shm, on a path with a space and a #", () => {
    const home = join(tmp(), "a home #1");
    mkdirSync(home);
    db(join(home, "hub.db"), 30);
    expect(schemaOf(join(home, "hub.db"))).toBe(30);
    expect(readdirSync(home)).toEqual(["hub.db"]);
  });

  test("sees a schema bump that is still only in the WAL", () => {
    const home = tmp();
    const path = join(home, "hub.db");
    db(path, 24);
    // A writer that never closes leaves its commit in the -wal, as a crash does.
    const w = new Database(path);
    w.exec("PRAGMA journal_mode = WAL");
    w.exec("PRAGMA wal_autocheckpoint = 0");
    w.run("INSERT INTO schema_version VALUES (25, '2026-10-28T00:00:00Z')");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(schemaOf(path)).toBe(25);
    w.close();
  });

  test("a database without schema_version, or a file that isn't one, is not refused", () => {
    const home = tmp();
    new Database(join(home, "hub.db")).close();
    mkdirSync(join(home, "vault", "data", "x"), { recursive: true });
    writeFileSync(join(home, "vault", "data", "x", "vault.db"), "not a database");
    expect(newerData(home, { hub: 24, vault: 32 })).toEqual([]);
  });
});

describe("repairModes", () => {
  test("folders 0700 and files 0600, the home and unreadable entries included", () => {
    const home = tmp();
    mkdirSync(join(home, "vault", "data"), { recursive: true });
    writeFileSync(join(home, "hub.db"), "x");
    writeFileSync(join(home, "vault", "locked"), "x");
    chmodSync(home, 0o755);
    chmodSync(join(home, "vault"), 0o755);
    chmodSync(join(home, "hub.db"), 0o644);
    chmodSync(join(home, "vault", "locked"), 0o000);
    const changed = repairModes(home);
    expect(changed).toContain(". 755 -> 700");
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "vault"))).toBe(0o700);
    expect(mode(join(home, "vault", "data"))).toBe(0o700);
    expect(mode(join(home, "hub.db"))).toBe(0o600);
    expect(mode(join(home, "vault", "locked"))).toBe(0o600);
    expect(repairModes(home)).toEqual([]);
  });

  test("never follows a symlink out of the home", () => {
    const outside = tmp();
    const target = join(outside, "elsewhere.txt");
    writeFileSync(target, "x");
    chmodSync(target, 0o644);
    mkdirSync(join(outside, "dir"));
    chmodSync(join(outside, "dir"), 0o755);
    const home = tmp();
    symlinkSync(target, join(home, "link-to-file"));
    symlinkSync(join(outside, "dir"), join(home, "link-to-dir"));
    repairModes(home);
    expect(mode(target)).toBe(0o644);
    expect(mode(join(outside, "dir"))).toBe(0o755);
  });
});
