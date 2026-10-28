// First-run takeover: v0.8 moving onto a machine where the old hub and vault already run (uni's cut-over, and
// Adam's friends box). Aaron's 10-27 requirement (PLAN §8.0; lane E).
//
// `parachute-core takeover [--home <dir>] [--dry-run] [--yes] [--json]` finds an existing Parachute home and the old
// programs (installed or running), says what it found in plain words, and with --yes: backs up the home, pauses the
// old services, starts on the same data (no data conversion), checks every answer, and keeps the old programs
// installed but off. `takeover --rollback` goes back. Exit codes: 0 done; 2 flags; 7 an old process still holds the
// data (names its pid; nothing changed); 8 a check failed after start (it rolled itself back). `parachute-core serve`
// on a home with the old programs present and no takeover record refuses with exit 7 and says to run takeover.
//
// Each test builds a person's machine (_takeover-lib.ts): the stock 0.7 programs laid out as `bun add -g` does, a
// fake systemctl (an outside system) with an enabled, running parachute-hub.service and a leftover, disabled
// parachute-vault.service (Adam's box has both unit files), and a stock home made by those old programs. The
// takeover must pause only the units that are active or enabled.
//
// Not covered here: a home older than the core's schema (Adam's: hub schema 16, vaults at 26). There, opening the
// home runs today's existing migrations, so rollback means restoring the backup ("restore-backup"). That path is
// proven by rehearsal/adam on a copy of the real backup, not in CI. Exit 8 (a failed post-start check) has no
// black-box trigger here either.
//
// Green since lane E (packages/cli/src/takeover.ts). The setup test proves the old install and stock home are real
// (the old `parachute` from the fake global install serves the notes). Takeover writes parachute-core.service into
// the unit folder and enables it; the fake systemctl knows a unit by its file, as systemd does after daemon-reload,
// and runs it for real (its ExecStart with its Environment), so the v0.8 a test talks to after a takeover is the one
// the unit runs (coreUnit). The old units it only keeps state for: each test runs the old programs itself
// (startOldBox), "as the unit would".
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "../candidate-lib.ts";
import { rest } from "../lib.ts";
import {
  OLD_UNITS,
  core,
  fileHashes,
  findFiles,
  holders,
  json,
  makeStockHome,
  must,
  newMachine,
  oldStock,
  readNotes,
  requireCore,
  schemaOf,
  coreUnit,
  startOldBox,
  oldInstallHash,
  treeHash,
  type Machine,
  type StockHome,
} from "./_takeover-lib.ts";

const HUB_UNIT = "parachute-hub.service";
const VAULT_UNIT = "parachute-vault.service";

let machines: Machine[] = [];
afterEach(async () => {
  for (const m of machines) await m.dispose();
  machines = [];
});

/** A machine with the old programs, both old units, and a stock home with made-up notes (old box stopped). */
async function oldMachine(label: string): Promise<{ m: Machine; s: StockHome; noteCount: number }> {
  const m = await newMachine(label, { units: OLD_UNITS });
  machines.push(m);
  const s = await makeStockHome(m);
  // Every note in the vault (vault create seeds a few welcome notes of its own), read through the old box.
  const box = await startOldBox(m, s);
  const all = await readNotes(s.origin, s.vaultName, s.readPass);
  await box.stop();
  must(all.status === 200 && all.notes.length >= s.notes.length, `setup: the old box listed ${all.status} / ${all.notes.length} notes`);
  return { m, s, noteCount: all.notes.length };
}

/**
 * What must not change: the home, the old global install, the npm prefix, the old unit files and unit states.
 * With `live`, an old box is running, and its own writes to its open SQLite files (`*.db`, `-wal`, `-shm`) are
 * not counted: those files must still be there, and every other file must be byte-identical.
 */
async function snapshot(m: Machine, live = false) {
  const home = live
    ? JSON.stringify([...fileHashes(m.home)].map(([p, h]) => [p, /\.db(-wal|-shm)?$/.test(p) ? "live sqlite file" : h]))
    : await treeHash(m.home);
  return {
    home,
    oldInstall: await oldInstallHash(m),
    npm: await treeHash(m.npmPrefix),
    unitFiles: Object.fromEntries(m.units.map((u) => [u, readFileSync(join(m.unitDir, u), "utf8")])),
    unitStates: Object.fromEntries(m.units.map((u) => [u, m.unit(u)])),
  };
}

function vaultDb(m: Machine, s: StockHome): string {
  const dbs = findFiles(m.home, "vault.db").filter((p) => p.includes(`/${s.vaultName}/`));
  must(dbs.length === 1, `setup: expected one vault.db for ${s.vaultName}, found ${dbs.length}`);
  return dbs[0]!;
}

function hubDb(m: Machine): string {
  const dbs = findFiles(m.home, "hub.db");
  must(dbs.length === 1, `setup: expected one hub.db in the home, found ${dbs.length}`);
  return dbs[0]!;
}

const MUTATING = /\b(start|stop|restart|enable|disable|mask|kill)\b/;

/** systemctl calls since `from` that change something, for `unit`. */
function changesTo(m: Machine, unit: string, from: number): string[] {
  const base = unit.replace(/\.service$/, "");
  return m.systemctlCalls().slice(from).filter((c) => MUTATING.test(c) && new RegExp(`\\b${base}(\\.service)?\\b`).test(c));
}

describe("takeover: setup", () => {
  test("setup works: the old global install is laid out as bun -g does and serves the stock home's notes", async () => {
    const stock = await oldStock();
    const { m, s, noteCount } = await oldMachine("tk-setup");
    // `parachute` on the person's PATH is the old hub from the global install, and so is the vault it starts.
    const which = await m.run(["sh", "-c", "command -v parachute; command -v parachute-vault; parachute --version"]);
    expect(which.stdout.trim().split("\n")).toEqual([join(m.user, ".bun/bin/parachute"), join(m.user, ".bun/bin/parachute-vault"), stock.hubVersion]);
    const box = await startOldBox(m, s);
    try {
      const db = vaultDb(m, s);
      const held = holders(db);
      expect(held.length).toBe(1);
      expect(held[0]!.cmd).toContain(join(m.user, ".bun/bin/parachute-vault"));
      // The made-up notes, through the old hub, with the read pass the old hub minted.
      const got = await readNotes(s.origin, s.vaultName, s.readPass);
      expect(got.status).toBe(200);
      expect(got.notes.length).toBe(noteCount);
      for (const n of s.notes) expect(got.notes.find((x) => x.id === n.id)?.content).toBe(n.content);
      // A running old box changes nothing in the home but its open SQLite files, so the refusal test can compare
      // the rest of the home while it runs.
      const a = await snapshot(m, true);
      await Bun.sleep(1500);
      expect(await snapshot(m, true)).toEqual(a);
    } finally {
      await box.stop();
    }
    expect(schemaOf(vaultDb(m, s))).toBeGreaterThan(0);
    expect(schemaOf(hubDb(m))).toBeGreaterThan(0);
    // The fake systemctl answers like systemd does.
    const st = await m.run(["systemctl", "--user", "is-active", HUB_UNIT]);
    expect([st.code, st.stdout.trim()]).toEqual([0, "active"]);
    const vs = await m.run(["systemctl", "--user", "is-enabled", VAULT_UNIT]);
    expect([vs.code, vs.stdout.trim()]).toEqual([1, "disabled"]);
  }, 120_000);
});

describe("takeover", () => {
  test("detection: --dry-run --json reports the old hub and vault, both units, the vaults with note counts and schemas, no migrations, a code-only rollback", async () => {
    const stock = await oldStock();
    const { m, s, noteCount } = await oldMachine("tk-detect");
    const vaultSchema = schemaOf(vaultDb(m, s));
    const hubSchema = schemaOf(hubDb(m));
    const r = await core(m, ["takeover", "--home", m.home, "--dry-run", "--json"]);
    must(r.code === 0, `takeover --dry-run --json exited ${r.code}: ${r.stderr.slice(-600)}`);
    const rep = json(r, "takeover --dry-run --json");
    expect(rep.home).toBe(m.home);
    expect(rep.old.hub.version).toBe(stock.hubVersion);
    expect(rep.old.vault.version).toBe(stock.vaultVersion);
    expect(String(rep.old.hub.path).startsWith(join(m.user, ".bun/"))).toBe(true);
    expect(String(rep.old.vault.path).startsWith(join(m.user, ".bun/"))).toBe(true);
    const unit = (n: string) => (rep.units as any[]).find((u) => u.name === n || u.name === n.replace(/\.service$/, ""));
    expect(unit(HUB_UNIT)).toMatchObject({ manager: "systemd", active: true, enabled: true });
    expect(unit(VAULT_UNIT)).toMatchObject({ manager: "systemd", active: false, enabled: false });
    expect(rep.running).toEqual([]);
    expect(rep.vaults).toEqual([{ name: s.vaultName, notes: noteCount, schema: vaultSchema }]);
    expect(rep.hub_schema).toBe(hubSchema);
    // Same-schema home: core opens it without a migration, so going back is starting the old programs.
    expect(rep.migrations).toEqual([]);
    expect(rep.rollback).toBe("code-only");
    expect(Array.isArray(rep.plan) && rep.plan.length > 0).toBe(true);
  }, 120_000);

  test("a dry run changes nothing and says in plain words what it found", async () => {
    const { m, s, noteCount } = await oldMachine("tk-dry");
    const old = await oldStock();
    const before = await snapshot(m);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--dry-run"]);
    must(r.code === 0, `takeover --dry-run exited ${r.code}: ${r.stderr.slice(-600)}`);
    const text = r.stdout + r.stderr;
    for (const want of [old.hubVersion, old.vaultVersion, HUB_UNIT, VAULT_UNIT, s.vaultName]) expect(text).toContain(want);
    expect(text).toMatch(new RegExp(`\\b${noteCount} notes\\b`));
    // Same schema, so nothing about restoring a backup to go back.
    expect(text).not.toMatch(/restor\w* the backup/i);
    expect(await snapshot(m)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("an unknown flag exits 2 and changes nothing", async () => {
    const { m } = await oldMachine("tk-flags");
    const before = await snapshot(m);
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--no-such-flag"]);
    must(r.code === 2, `takeover with an unknown flag exited ${r.code}, want 2: ${r.stderr.slice(-600)}`);
    expect(await snapshot(m)).toEqual(before);
  }, 120_000);

  test("serve refuses a home the old programs still own: exit 7, and it says to run takeover", async () => {
    const { m, s } = await oldMachine("tk-serve7");
    const before = await snapshot(m);
    const r = await m.run([requireCore(m.info), "serve"], { env: s.serveEnv, timeoutMs: 30_000 });
    must(r.code !== 137, "serve started on a home the old programs still own (still running after 30 s)");
    must(r.code === 7, `serve on a home the old programs still own exited ${r.code}, want 7: ${r.stderr.slice(-600)}`);
    expect(r.stdout + r.stderr).toMatch(/parachute-core takeover/);
    expect(await snapshot(m)).toEqual(before);
  }, 120_000);

  test("takeover backs up the home first: the manifest's sha256 of each file equals the file before takeover", async () => {
    const { m } = await oldMachine("tk-backup");
    const pre = fileHashes(m.home);
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes exited ${r.code}: ${r.stderr.slice(-600)}`);
    const rep = json(r, "takeover --yes --json");
    const backup = String(rep.backup);
    expect(backup.startsWith(join(m.user, "parachute-takeover") + "/")).toBe(true);
    const manifest = readManifest(backup);
    // Every file of the home is in the manifest (SQLite's -shm index aside), with the hash it had before takeover.
    for (const [path, sha] of pre) {
      if (path.endsWith("-shm")) continue;
      expect({ path, sha: manifest.get(path) }).toEqual({ path, sha });
    }
    // And the backup holds those bytes: each manifest hash is the hash of some file in the backup folder.
    const copies = new Set(fileHashes(backup).values());
    for (const [path, sha] of manifest) expect({ path, inBackup: copies.has(sha) }).toEqual({ path, inBackup: true });
  }, 120_000);

  test("takeover refuses while an old process holds the database: exit 7 names its pid, and nothing changes", async () => {
    const { m, s } = await oldMachine("tk-held");
    const box = await startOldBox(m, s); // the old stock serve, from the global install, left running
    const held = holders(vaultDb(m, s));
    must(held.length === 1, `setup: expected the old vault to hold vault.db, got ${JSON.stringify(held)}`);
    const pid = held[0]!.pid;
    const before = await snapshot(m, true);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 7, `takeover while an old process holds the data exited ${r.code}, want 7: ${r.stderr.slice(-600)}`);
    expect(r.stdout + r.stderr).toMatch(new RegExp(`\\b${pid}\\b`));
    // Refused before anything: no old unit was stopped or disabled (and started again) on the way.
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    // Nothing changed: the home, the old install, the unit files, the units end as they were; no backup folder.
    expect(await snapshot(m, true)).toEqual(before);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
    // The old box is still the one serving.
    expect(box.proc.exitCode).toBe(null);
    expect((await readNotes(s.origin, s.vaultName, s.readPass)).status).toBe(200);
  }, 120_000);

  test("after takeover: old units stopped and disabled, old install untouched, core serves the same notes, an old pass verifies, schemas unchanged", async () => {
    const { m, s } = await oldMachine("tk-after");
    const box = await startOldBox(m, s);
    const notesBefore = (await readNotes(s.origin, s.vaultName, s.readPass)).notes;
    await box.stop();
    const vaultSchema = schemaOf(vaultDb(m, s));
    const hubSchema = schemaOf(hubDb(m));
    const before = await snapshot(m);
    const calls = m.systemctlCalls().length;

    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes exited ${r.code}: ${r.stderr.slice(-600)}`);

    // The old hub unit is paused and won't come back at boot; the leftover vault unit (off, disabled) is left alone.
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
    expect(changesTo(m, HUB_UNIT, calls).length).toBeGreaterThan(0);
    expect(m.unit(VAULT_UNIT)).toEqual({ active: false, enabled: false });
    expect(changesTo(m, VAULT_UNIT, calls)).toEqual([]);
    // The old programs stay installed, byte for byte, and so do their unit files.
    const after = await snapshot(m);
    expect(after.oldInstall).toBe(before.oldInstall);
    expect(after.npm).toBe(before.npm);
    expect(after.unitFiles).toEqual(before.unitFiles);

    const c = await coreUnit(m, s);
    try {
      const got = await readNotes(s.origin, s.vaultName, s.readPass); // minted by the old hub before takeover
      expect(got.status).toBe(200);
      expect(got.notes).toEqual(notesBefore);
    } finally {
      await c.stop();
    }
    expect(schemaOf(vaultDb(m, s))).toBe(vaultSchema);
    expect(schemaOf(hubDb(m))).toBe(hubSchema);
  }, 120_000);

  test("the old units keep ~/.parachute only: core serves another home of its own on the same machine", async () => {
    const { m, s } = await oldMachine("tk-other");
    const other = join(m.user, "other-home");
    const env = { ...s.serveEnv, PARACHUTE_HOME: other };
    const made = await core(m, ["vault", "create", "elsewhere", "--no-mirror", "--json"], env);
    must(made.code === 0, `setup: parachute-core vault create on another home exited ${made.code}: ${made.stderr.slice(-400)}`);
    const box = m.spawn([requireCore(m.info), "serve"], { env });
    try {
      const up = await until(async () => box.proc.exitCode !== null || holders(join(other, "vault", "data", "elsewhere", "vault.db")).length > 0, 60_000);
      must(up && box.proc.exitCode === null, `serve on a home the old units don't keep exited ${box.proc.exitCode}: ${box.log().slice(-600)}`);
    } finally {
      await box.stop();
    }
  }, 120_000);

  test("a home with a link out of it is refused before anything changes: the backup couldn't copy it as it is", async () => {
    const { m } = await oldMachine("tk-link");
    // The snapshot helper hashes trees and refuses links, so it is taken without the link, and the link is checked
    // and removed before comparing.
    const before = await snapshot(m);
    const link = join(m.home, "linked-out");
    symlinkSync(join(m.user, "elsewhere"), link);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code !== 0, "takeover went ahead on a home with a link out of it");
    expect(r.stderr).toContain("linked-out");
    expect(readlinkSync(link)).toBe(join(m.user, "elsewhere"));
    unlinkSync(link);
    expect(await snapshot(m)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("takeover from a shell that still has the old box's settings (its port, origin and key source) checks v0.8 against itself and succeeds", async () => {
    // Found by lane E's walkthrough: a check run that took the shell's PARACHUTE_HUB_JWKS_ORIGIN fetched keys from
    // the old box's address, where nothing listens once it is paused, and every vault answered 401.
    const { m, s } = await oldMachine("tk-shell");
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"], s.serveEnv);
    must(r.code === 0, `takeover --yes from the old box's environment exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
    const c = await coreUnit(m, s);
    try {
      expect((await readNotes(s.origin, s.vaultName, s.readPass)).status).toBe(200);
    } finally {
      await c.stop();
    }
  }, 120_000);

  test("when parachute-core.service can't serve (its port is taken), takeover puts everything back and exits 8", async () => {
    const { m, s } = await oldMachine("tk-unitfail");
    // Something else on the machine holds the hub's port, so the unit's v0.8 can't bind it. The check run (on a free
    // port) passes; only the hand-over to the unit fails.
    const squatter = m.spawn([process.execPath, "-e", `Bun.listen({ hostname: "127.0.0.1", port: ${s.port}, socket: { data() {} } }); await Bun.sleep(600000)`]);
    await Bun.sleep(500);
    try {
      const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
      must(r.code === 8, `takeover with a unit that can't serve exited ${r.code}, want 8: ${r.stderr.slice(-600)}`);
      expect(r.stderr).toContain("parachute-core.service");
      // The old hub unit is back on, v0.8's unit is off, and there is no takeover record.
      expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
      expect(m.unit(VAULT_UNIT)).toEqual({ active: false, enabled: false });
      expect(m.unit("parachute-core.service")).toEqual({ active: false, enabled: false });
      expect(existsSync(join(m.home, "takeover.json"))).toBe(false);
    } finally {
      await squatter.stop();
    }
    // The old programs, as their unit runs them, serve the notes as before.
    const box = await startOldBox(m, s);
    try {
      const got = await readNotes(s.origin, s.vaultName, s.readPass);
      expect(got.status).toBe(200);
      for (const n of s.notes) expect(got.notes.find((x) => x.id === n.id)?.content).toBe(n.content);
    } finally {
      await box.stop();
    }
  }, 180_000);

  test("a parachute-core.service that serves another home is never replaced: refused before anything changes", async () => {
    const { m } = await oldMachine("tk-coreunit");
    const theirs = join(m.unitDir, "parachute-core.service");
    const text = `[Service]\nExecStart=/opt/elsewhere/bin/parachute-core serve\nEnvironment=PARACHUTE_HOME=${join(m.user, "another-home")}\n`;
    writeFileSync(theirs, text);
    const before = await snapshot(m);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code !== 0, "takeover went ahead and replaced another home's parachute-core.service");
    expect(r.stderr).toContain("parachute-core.service");
    expect(readFileSync(theirs, "utf8")).toBe(text);
    expect(await snapshot(m)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("rollback: a note written under core reads and updates under the old programs", async () => {
    const { m, s } = await oldMachine("tk-rollback");
    const before = await snapshot(m);
    const t = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(t.code === 0, `takeover --yes exited ${t.code}: ${t.stderr.slice(-600)}`);

    // Written to the v0.8 the unit runs; the rollback is what stops it.
    await coreUnit(m, s);
    const made = await rest(`${s.origin}/vault/${s.vaultName}`, s.writePass).post("/notes", {
      path: "garden/written-under-core",
      content: "Planted garlic in October; mulch after the first frost.",
      tags: ["made-up"],
    });
    expect(made.status).toBe(201);
    const written = { id: made.body.id, updatedAt: made.body.updatedAt };

    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--rollback", "--yes", "--json"]);
    must(r.code === 0, `takeover --rollback --yes exited ${r.code}: ${r.stderr.slice(-600)}`);
    // The old hub unit is back on and enabled; the leftover vault unit stays as it was.
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
    expect(changesTo(m, HUB_UNIT, calls).length).toBeGreaterThan(0);
    expect(m.unit(VAULT_UNIT)).toEqual({ active: false, enabled: false });
    expect((await snapshot(m)).oldInstall).toBe(before.oldInstall);

    // The old programs, as the unit would start them, on the same home.
    const box = await startOldBox(m, s);
    try {
      const api = rest(`${s.origin}/vault/${s.vaultName}`, s.writePass);
      const got = await api.get(`/notes/${written.id}`);
      expect(got.status).toBe(200);
      expect(got.body.content).toBe("Planted garlic in October; mulch after the first frost.");
      const up = await api.patch(`/notes/${written.id}`, { content: "Garlic mulched.", if_updated_at: got.body.updatedAt });
      expect(up.status).toBe(200);
      expect((await api.get(`/notes/${written.id}`)).body.content).toBe("Garlic mulched.");
      for (const n of s.notes) expect((await api.get(`/notes/${n.id}`)).body.content).toBe(n.content);
    } finally {
      await box.stop();
    }
  }, 120_000);
});

/**
 * The backup's manifest: `<backup>/manifest.json`, a sha256 per file with paths relative to the home. Accepts
 * {files: {path: sha}}, {files: [{path, sha256}]}, [{path, sha256}] or {path: sha}.
 */
function readManifest(backup: string): Map<string, string> {
  const file = join(backup, "manifest.json");
  must(existsSync(file), `no manifest.json in the backup folder (it has: ${existsSync(backup) ? readdirSync(backup).join(", ") : "no folder"})`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const body = raw.files ?? raw;
  const out = new Map<string, string>();
  if (Array.isArray(body)) for (const e of body) out.set(String(e.path).replace(/^\.\//, ""), e.sha256);
  else for (const [k, v] of Object.entries(body)) out.set(k.replace(/^\.\//, ""), String(v));
  return out;
}
