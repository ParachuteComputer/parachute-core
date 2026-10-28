// The two checks every command makes on its home (home.ts). The contracts hold them end to end
// (contracts/suites/embedded/newer-data, modes); these hold the corners a contract can't reach cheaply: a symlink
// out of the home, an unreadable file, a WAL left by a crash.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UncheckedError, newerData, repairModes, schemaOf } from "./home.ts";

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
/** Each file in a folder with a hash of its bytes. */
const files = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => `${f} ${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}`);

/** A WAL-mode database with schema_version rows 1..top, closed cleanly (no -wal left). */
function db(path: string, top: number): void {
  const d = new Database(path);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let v = 1; v <= top; v++) d.run("INSERT INTO schema_version VALUES (?, ?)", [v, "2026-10-27T00:00:00Z"]);
  d.close();
}

/** A writer killed right after committing `version`: the commit is only in the -wal, with a -shm index beside it. */
function crashAfterCommit(path: string, version: number): void {
  const w = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { Database } = require("bun:sqlite");
     const d = new Database(${JSON.stringify(path)});
     d.exec("PRAGMA wal_autocheckpoint = 0");
     d.run("INSERT INTO schema_version VALUES (${version}, '2026-10-28T00:00:00Z')");
     process.kill(process.pid, "SIGKILL");`,
  ]);
  expect(w.signalCode).toBe("SIGKILL");
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
}

describe("newerData", () => {
  test("names a newer hub.db and a newer vault, and passes an older or equal one", () => {
    const home = tmp();
    db(join(home, "hub.db"), 25);
    for (const [name, top] of [["a", 32], ["b", 33], ["c", 20]] as const) {
      mkdirSync(join(home, "vault", "data", name), { recursive: true });
      db(join(home, "vault", "data", name, "vault.db"), top);
    }
    expect(newerData(home, { hub: 24, vault: 32 }).newer).toEqual([
      "hub.db is at schema 25; this program knows up to 24",
      "vault/data/b/vault.db is at schema 33; this program knows up to 32",
    ]);
    expect(newerData(home, { hub: 25, vault: 33 })).toEqual({ newer: [], unchecked: [] });
  });

  test("reads without leaving a -wal or -shm, on a path with a space and a #", () => {
    const home = join(tmp(), "a home #1");
    mkdirSync(home);
    db(join(home, "hub.db"), 30);
    expect(schemaOf(join(home, "hub.db"))).toBe(30);
    expect(readdirSync(home)).toEqual(["hub.db"]);
  });

  test("a WAL a crashed writer left: sees the commit only the WAL holds, and changes no byte, -shm included", () => {
    const home = tmp();
    const path = join(home, "hub.db");
    db(path, 24);
    crashAfterCommit(path, 25);
    const before = files(home);
    expect(schemaOf(path, home + "-outside")).toBe(25); // an unusable outside: falls back to the temp folder
    expect(schemaOf(path, dirname(home))).toBe(25);
    expect(files(home)).toEqual(before);
    // Without the -shm (a careless copy), none is made.
    rmSync(`${path}-shm`);
    const noShm = files(home);
    expect(schemaOf(path, dirname(home))).toBe(25);
    expect(files(home)).toEqual(noShm);
    expect(readdirSync(dirname(home)).filter((n) => n.startsWith(".parachute-schema-check-"))).toEqual([]);
  });

  test("a WAL with nowhere outside the home to copy it to: reported as unchecked, and nothing changes", () => {
    const parent = tmp();
    const home = join(parent, "home");
    mkdirSync(home);
    const path = join(home, "hub.db");
    db(path, 24);
    crashAfterCommit(path, 25);
    const before = files(home);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(parent, "no-such-temp");
    chmodSync(parent, 0o500); // the home's parent takes no scratch folder either
    try {
      expect(() => schemaOf(path, parent)).toThrow(UncheckedError);
      expect(newerData(home, { hub: 24, vault: 32 })).toEqual({
        newer: [],
        unchecked: ["hub.db has a WAL that no scratch folder outside the home could take"],
      });
    } finally {
      chmodSync(parent, 0o700);
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(files(home)).toEqual(before);
  });

  test("finds vaults in the two older layouts the vault moves on open", () => {
    const home = tmp();
    for (const folder of ["vaults", "vault/vaults"]) {
      mkdirSync(join(home, folder, "old"), { recursive: true });
      db(join(home, folder, "old", "vault.db"), 33);
    }
    expect(newerData(home, { hub: 24, vault: 32 }).newer).toEqual([
      "vaults/old/vault.db is at schema 33; this program knows up to 32",
      "vault/vaults/old/vault.db is at schema 33; this program knows up to 32",
    ]);
  });

  test("a database without schema_version, or a file that isn't one, is not refused", () => {
    const home = tmp();
    new Database(join(home, "hub.db")).close();
    mkdirSync(join(home, "vault", "data", "x"), { recursive: true });
    writeFileSync(join(home, "vault", "data", "x", "vault.db"), "not a database");
    expect(newerData(home, { hub: 24, vault: 32 })).toEqual({ newer: [], unchecked: [] });
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
