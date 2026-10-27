// First-run takeover: v0.8 moving onto a machine where the old hub and vault already run (uni's cut-over, and
// Adam's friends box if T-36 slips). Aaron's 10-27 requirement (PLAN §8.1/§8.2, takeover section being added; lane E).
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
// All red: on the stock build there is no bin/parachute-core; on the core build (lane A1) there is no `takeover`
// command yet, and serve starts on a home the old programs own. The setup test is green and proves the old install
// and stock home are real (the old `parachute` from the fake global install serves the notes).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { red, rest } from "../lib.ts";
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
  startCore,
  startOldBox,
  oldInstallHash,
  treeHash,
  type Machine,
  type StockHome,
} from "./_takeover-lib.ts";

// What the core build says while there is no takeover yet (lane E): the command is unknown, and serve starts on a
// home the old programs own instead of refusing it.
const NO_TAKEOVER = /unknown command "takeover"/;
const SERVE_TAKES_HOME = /serve started on a home the old programs still own/;
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
  red("detection: --dry-run --json reports the old hub and vault, both units, the vaults with note counts and schemas, no migrations, a code-only rollback", { reason: NO_TAKEOVER, lane: "E" }, async () => {
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

  red("a dry run changes nothing and says in plain words what it found", { reason: NO_TAKEOVER, lane: "E" }, async () => {
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

  red("an unknown flag exits 2 and changes nothing", { reason: NO_TAKEOVER, lane: "E" }, async () => {
    const { m } = await oldMachine("tk-flags");
    const before = await snapshot(m);
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--no-such-flag"]);
    must(r.code === 2, `takeover with an unknown flag exited ${r.code}, want 2: ${r.stderr.slice(-600)}`);
    expect(await snapshot(m)).toEqual(before);
  }, 120_000);

  red("serve refuses a home the old programs still own: exit 7, and it says to run takeover", { reason: SERVE_TAKES_HOME, lane: "E" }, async () => {
    const { m, s } = await oldMachine("tk-serve7");
    const before = await snapshot(m);
    const r = await m.run([requireCore(m.info), "serve"], { env: s.serveEnv, timeoutMs: 30_000 });
    must(r.code !== 137, "serve started on a home the old programs still own (still running after 30 s)");
    must(r.code === 7, `serve on a home the old programs still own exited ${r.code}, want 7: ${r.stderr.slice(-600)}`);
    expect(r.stdout + r.stderr).toMatch(/parachute-core takeover/);
    expect(await snapshot(m)).toEqual(before);
  }, 120_000);

  red("takeover backs up the home first: the manifest's sha256 of each file equals the file before takeover", { reason: NO_TAKEOVER, lane: "E" }, async () => {
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

  red("takeover refuses while an old process holds the database: exit 7 names its pid, and nothing changes", { reason: NO_TAKEOVER, lane: "E" }, async () => {
    const { m, s } = await oldMachine("tk-held");
    const box = await startOldBox(m, s); // the old stock serve, from the global install, left running
    const held = holders(vaultDb(m, s));
    must(held.length === 1, `setup: expected the old vault to hold vault.db, got ${JSON.stringify(held)}`);
    const pid = held[0]!.pid;
    const before = await snapshot(m, true);
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 7, `takeover while an old process holds the data exited ${r.code}, want 7: ${r.stderr.slice(-600)}`);
    expect(r.stdout + r.stderr).toMatch(new RegExp(`\\b${pid}\\b`));
    // Nothing changed: the home, the old install, the unit files, the units end as they were; no backup folder.
    expect(await snapshot(m, true)).toEqual(before);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
    // The old box is still the one serving.
    expect(box.proc.exitCode).toBe(null);
    expect((await readNotes(s.origin, s.vaultName, s.readPass)).status).toBe(200);
  }, 120_000);

  red("after takeover: old units stopped and disabled, old install untouched, core serves the same notes, an old pass verifies, schemas unchanged", { reason: NO_TAKEOVER, lane: "E" }, async () => {
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

    const c = await startCore(m, s);
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

  red("rollback: a note written under core reads and updates under the old programs", { reason: NO_TAKEOVER, lane: "E" }, async () => {
    const { m, s } = await oldMachine("tk-rollback");
    const before = await snapshot(m);
    const t = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(t.code === 0, `takeover --yes exited ${t.code}: ${t.stderr.slice(-600)}`);

    const c = await startCore(m, s);
    let written = { id: "", updatedAt: "" };
    try {
      const made = await rest(`${s.origin}/vault/${s.vaultName}`, s.writePass).post("/notes", {
        path: "garden/written-under-core",
        content: "Planted garlic in October; mulch after the first frost.",
        tags: ["made-up"],
      });
      expect(made.status).toBe(201);
      written = { id: made.body.id, updatedAt: made.body.updatedAt };
    } finally {
      await c.stop();
    }

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
