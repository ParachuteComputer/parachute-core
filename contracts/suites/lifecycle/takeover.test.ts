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
// (the old `parachute` from the fake global install serves the notes). The fake systemctl runs every unit it is
// asked to start (ExecStart with Environment, drop-ins and environment files), so the machine is as a person has it:
// parachute-hub.service runs the old programs on the home. The takeover pauses a unit only on evidence (its process
// has this home's data open), and after a takeover the tests talk to the v0.8 parachute-core.service runs.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeJwt, importPKCS8, SignJWT } from "jose";
import { until } from "../candidate-lib.ts";
import { rest } from "../lib.ts";
import {
  OLD_UNITS,
  core,
  dbHolders,
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
  serving,
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

/**
 * A machine with the old programs, both old units, and a stock home with made-up notes, as a person has it:
 * parachute-hub.service runs the old programs (the fake systemctl runs it), parachute-vault.service is off.
 */
async function oldMachine(label: string): Promise<{ m: Machine; s: StockHome; noteCount: number }> {
  const m = await newMachine(label, { units: OLD_UNITS });
  machines.push(m);
  const s = await makeStockHome(m);
  // Every note in the vault (vault create seeds a few welcome notes of its own), read through the old hub unit.
  const all = await readNotes(s.origin, s.vaultName, s.readPass);
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
    // The old hub unit runs the old programs on the home (the vault its child).
    {
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
    // The running hub unit has this home's data open, so it is the one to pause; the leftover vault unit isn't.
    expect(unit(HUB_UNIT)).toMatchObject({ manager: "systemd", active: true, enabled: true, old: true });
    expect(unit(VAULT_UNIT)).toMatchObject({ manager: "systemd", active: false, enabled: false, old: false });
    expect((rep.running as any[]).length).toBeGreaterThan(0);
    for (const h of rep.running as any[]) expect(h.unit).toBe(HUB_UNIT);
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
    const before = await snapshot(m, true);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--dry-run"]);
    must(r.code === 0, `takeover --dry-run exited ${r.code}: ${r.stderr.slice(-600)}`);
    const text = r.stdout + r.stderr;
    for (const want of [old.hubVersion, old.vaultVersion, HUB_UNIT, VAULT_UNIT, s.vaultName]) expect(text).toContain(want);
    expect(text).toMatch(new RegExp(`\\b${noteCount} notes\\b`));
    // Same schema, so nothing about restoring a backup to go back.
    expect(text).not.toMatch(/restor\w* the backup/i);
    expect(await snapshot(m, true)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("an unknown flag exits 2 and changes nothing", async () => {
    const { m } = await oldMachine("tk-flags");
    const before = await snapshot(m, true);
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--no-such-flag"]);
    must(r.code === 2, `takeover with an unknown flag exited ${r.code}, want 2: ${r.stderr.slice(-600)}`);
    expect(await snapshot(m, true)).toEqual(before);
  }, 120_000);

  test("serve refuses a home the old programs still own: exit 7, and it says to run takeover", async () => {
    const { m, s } = await oldMachine("tk-serve7");
    const before = await snapshot(m, true);
    const r = await m.run([requireCore(m.info), "serve"], { env: s.serveEnv, timeoutMs: 30_000 });
    must(r.code !== 137, "serve started on a home the old programs still own (still running after 30 s)");
    must(r.code === 7, `serve on a home the old programs still own exited ${r.code}, want 7: ${r.stderr.slice(-600)}`);
    expect(r.stdout + r.stderr).toMatch(/parachute-core takeover/);
    expect(await snapshot(m, true)).toEqual(before);
  }, 120_000);

  test("takeover backs up the home first: every file in a sha256 manifest, the databases holding the notes as before", async () => {
    const { m, s } = await oldMachine("tk-backup");
    // The old hub runs, so its open databases change as it stops (a checkpoint): every other file is compared by
    // its bytes, the databases by what they hold.
    const pre = fileHashes(m.home);
    const ids = (await readNotes(s.origin, s.vaultName, s.readPass)).notes.map((n) => n.id).sort();
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes exited ${r.code}: ${r.stderr.slice(-600)}`);
    const rep = json(r, "takeover --yes --json");
    const backup = String(rep.backup);
    expect(backup.startsWith(join(m.user, "parachute-takeover") + "/")).toBe(true);
    const manifest = readManifest(backup);
    for (const [path, sha] of pre) {
      if (path === "hub-instance.json") continue; // the running old hub's own run file, gone once it stops
      if (/\.db(-wal|-shm)?$/.test(path)) {
        if (path.endsWith(".db")) expect({ path, inManifest: manifest.has(path) }).toEqual({ path, inManifest: true });
        continue;
      }
      expect({ path, sha: manifest.get(path) }).toEqual({ path, sha });
    }
    // The backup holds those bytes: each manifest hash is the hash of some file in the backup folder.
    const byHash = new Map([...fileHashes(backup)].map(([p, h]) => [h, join(backup, p)]));
    for (const [path, sha] of manifest) expect({ path, inBackup: byHash.has(sha) }).toEqual({ path, inBackup: true });
    // And the backed-up vault database holds exactly the notes the old hub served.
    const rel = [...manifest.keys()].find((p) => p.endsWith(`/${s.vaultName}/vault.db`))!;
    const copy = byHash.get(manifest.get(rel)!)!;
    expect(notesIn(copy)).toEqual(ids);
  }, 120_000);

  test("takeover refuses while an old process holds the database: exit 7 names its pid, and nothing changes", async () => {
    const { m, s } = await oldMachine("tk-held");
    // The old programs, started by hand instead of by their unit (which is stopped, still enabled).
    await (await serving(m, s, HUB_UNIT)).stop();
    const box = await startOldBox(m, s);
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
    const notesBefore = (await readNotes(s.origin, s.vaultName, s.readPass)).notes;
    const vaultSchema = schemaOf(vaultDb(m, s));
    const hubSchema = schemaOf(hubDb(m));
    const before = await snapshot(m, true);
    const calls = m.systemctlCalls().length;

    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes exited ${r.code}: ${r.stderr.slice(-600)}`);

    // The old hub unit is paused and won't come back at boot; the leftover vault unit (off, disabled) is left alone.
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
    expect(changesTo(m, HUB_UNIT, calls).length).toBeGreaterThan(0);
    expect(m.unit(VAULT_UNIT)).toEqual({ active: false, enabled: false });
    expect(changesTo(m, VAULT_UNIT, calls)).toEqual([]);
    // The old programs stay installed, byte for byte, and so do their unit files.
    const after = await snapshot(m, true);
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
    // The old hub unit (stopped here only to free the ports; its unit file stays) keeps ~/.parachute.
    await (await serving(m, s, HUB_UNIT)).stop();
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
    const before = await snapshot(m, true);
    const link = join(m.home, "linked-out");
    symlinkSync(join(m.user, "elsewhere"), link);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code !== 0, "takeover went ahead on a home with a link out of it");
    expect(r.stderr).toContain("linked-out");
    expect(readlinkSync(link)).toBe(join(m.user, "elsewhere"));
    unlinkSync(link);
    expect(await snapshot(m, true)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("a home whose links stay inside it (a library's version links) is taken over: the backup keeps each link as a link", async () => {
    // Found by rehearsal/uni (lane H): uni's home has transcription/bin/libggml.so -> libggml.so.0 -> libggml.so.0.15.1
    // and the like, and takeover refused the whole home for them.
    const { m } = await oldMachine("tk-inlinks");
    const bin = join(m.home, "transcription", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "libmadeup.so.0.15.1"), "made-up library bytes");
    symlinkSync("libmadeup.so.0.15.1", join(bin, "libmadeup.so.0"));
    symlinkSync("libmadeup.so.0", join(bin, "libmadeup.so"));
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes on a home with links inside it exited ${r.code}: ${r.stderr.slice(-600)}`);
    const backup = String(json(r, "takeover --yes --json").backup);
    for (const home of [m.home, join(backup, "home")]) {
      expect(readlinkSync(join(home, "transcription", "bin", "libmadeup.so"))).toBe("libmadeup.so.0");
      expect(readlinkSync(join(home, "transcription", "bin", "libmadeup.so.0"))).toBe("libmadeup.so.0.15.1");
      expect(readFileSync(join(home, "transcription", "bin", "libmadeup.so"), "utf8")).toBe("made-up library bytes");
    }
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
  }, 120_000);

  test("takeover doesn't need a usable operator token: one issued under the box's old name (as uni's) is left alone, and the takeover succeeds", async () => {
    // Found by rehearsal/uni (lane H): uni's operator.token (and every script pass) carries the tailnet's old name as
    // its issuer, which the old hub's server accepts through its unit's RENDER_EXTERNAL_URL but `auth mint-token`
    // doesn't. The takeover's check minted its read passes with that command, so every vault check failed (exit 8).
    const { m } = await oldMachine("tk-oldop");
    const opFile = join(m.home, "operator.token");
    const hub = new Database(hubDb(m), { readonly: true });
    const key = hub.query("SELECT kid, private_key_pem FROM signing_keys WHERE retired_at IS NULL").get() as { kid: string; private_key_pem: string };
    hub.close();
    const claims = decodeJwt(readFileSync(opFile, "utf8").trim());
    const renamed = await new SignJWT({ ...claims, iss: "https://box-old-name.example-tailnet.test" })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .sign(await importPKCS8(key.private_key_pem, "RS256"));
    writeFileSync(opFile, `${renamed}\n`, { mode: 0o600 });
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code === 0, `takeover --yes with an operator token from the old name exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(readFileSync(opFile, "utf8")).toBe(`${renamed}\n`);
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
  }, 120_000);

  test("a takeover cut off during its check run (an ssh drop) is put back and finished by running takeover again", async () => {
    // Found by rehearsal/adam (lane H): cut off after pausing the old hub, a takeover left nothing serving the home,
    // and running it again "succeeded" with no unit to hand over to and nothing for --rollback to put back.
    const { m, s } = await oldMachine("tk-cut");
    const run = m.spawn([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"]);
    const checking = await until(() => dbHolders(m.home).some((h) => h.cmd.includes("--listen")), 90_000, 50);
    must(checking, `setup: the takeover's check run never opened the data:\n${run.log().slice(-1500)}`);
    // The session drops: the takeover and its check run die together, mid-check.
    const cut = [
      ...readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
        try {
          const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8");
          return cmd.includes("takeover") && cmd.includes(m.home);
        } catch {
          return false;
        }
      }).map(Number),
      ...dbHolders(m.home).filter((h) => h.cmd.includes("--listen")).map((h) => h.pid),
    ];
    for (const pid of cut) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await run.stop("SIGKILL");
    must(await until(() => dbHolders(m.home).length === 0, 15_000, 100), "setup: the cut-off check run still holds the data");
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false }); // what the cut left: nothing serves the home
    // The dry run says the paused unit is put back, paused again and handed over, not "nothing to pause".
    const dry = json(await core(m, ["takeover", "--home", m.home, "--dry-run", "--json"]), "takeover --dry-run --json");
    expect(dry.plan[0]).toContain(`put ${HUB_UNIT} back`);
    expect(dry.plan).toContain("run it from now on as parachute-core.service");
    // What a cut-off check run's modules leave (rehearsal/adam: an orphaned scribe holding its port, so the next check
    // run's scribe couldn't start): processes carrying the check run's mark. This home's are stopped; another's not.
    const idle = [process.execPath, "-e", "Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); await Bun.sleep(600000)"];
    const orphan = m.spawn(idle, { env: { PARACHUTE_TAKEOVER_CHECK: "1", PARACHUTE_HOME: m.home } });
    const stranger = m.spawn(idle, { env: { PARACHUTE_TAKEOVER_CHECK: "1", PARACHUTE_HOME: join(m.user, "another-home") } });

    const again = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(again.code === 0, `takeover after the cut exited ${again.code}: ${again.stderr.slice(-800)}`);
    expect(again.stderr).toContain("was interrupted");
    // Stopped by a signal: Bun then reports signalCode, and exitCode stays null.
    const ended = (p: typeof orphan) => p.proc.exitCode !== null || p.proc.signalCode !== null;
    expect(await until(() => ended(orphan), 10_000, 100)).toBe(true);
    expect(ended(stranger)).toBe(false);
    await stranger.stop();
    const record = JSON.parse(readFileSync(join(m.home, "takeover.json"), "utf8"));
    expect({ state: record.state, paused: record.paused.map((u: { name: string }) => u.name), core_unit: record.core_unit }).toEqual({ state: "taken-over", paused: [HUB_UNIT], core_unit: "parachute-core.service" });
    const c = await coreUnit(m, s);
    try {
      expect((await readNotes(s.origin, s.vaultName, s.readPass)).status).toBe(200);
    } finally {
      await c.stop();
    }
    const back = await core(m, ["takeover", "--home", m.home, "--rollback", "--yes", "--json"]);
    must(back.code === 0, `rollback after the finished takeover exited ${back.code}: ${back.stderr.slice(-600)}`);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
  }, 240_000);

  test("one takeover of a home at a time: a second one started while the first runs refuses with exit 7 and changes nothing", async () => {
    // Codex's review of the rehearsal fixes (lane H): two takeovers could both pass detection, then both pause, back
    // up and check the same home, and one could stop the other's check run.
    const { m } = await oldMachine("tk-twice");
    const first = m.spawn([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"]);
    const started = await until(() => {
      try {
        return JSON.parse(readFileSync(join(m.home, "takeover.json"), "utf8")).state === "taking-over";
      } catch {
        return false;
      }
    }, 90_000, 20);
    must(started, `setup: the first takeover never recorded its start:\n${first.log().slice(-1500)}`);
    const backups = () => (existsSync(join(m.user, "parachute-takeover")) ? readdirSync(join(m.user, "parachute-takeover")).length : 0);
    const before = backups();
    // The second reaches the same home through a link to it: the same lock all the same.
    const alias = join(m.user, "home-link");
    symlinkSync(m.home, alias);
    const second = await core(m, ["takeover", "--home", alias, "--yes", "--json"]);
    expect(second.code).toBe(7);
    // Refused by the lock, before it reads anything (the record's pid check is only a second line).
    expect(second.stderr).toContain("another takeover or rollback of");
    expect(backups()).toBe(before);
    const code = await first.proc.exited;
    must(code === 0, `the first takeover exited ${code}: ${first.log().slice(-1200)}`);
    expect(JSON.parse(readFileSync(join(m.home, "takeover.json"), "utf8")).state).toBe("taken-over");
    expect(m.unit(HUB_UNIT)).toEqual({ active: false, enabled: false });
  }, 240_000);

  test("a restore cut off between its two renames (no home, the restored copy beside it) is finished by --rollback", async () => {
    // Codex's review of the rehearsal fixes (lane H): restore() moves the home aside, then the restored copy in; a cut
    // between the two left no home at all, and neither takeover nor --rollback found anything to finish.
    const { m, s } = await oldMachine("tk-swap");
    await (await serving(m, s, HUB_UNIT)).stop();
    must((await m.run(["systemctl", "--user", "disable", HUB_UNIT])).code === 0, "setup: disabling the old hub unit failed");
    const staged = `${m.home}.restoring-cut`;
    cpSync(m.home, staged, { recursive: true });
    const now = new Date().toISOString();
    const record = {
      state: "taking-over", stage: "checking", at: now, version: "made-up", home: m.home, backup: "", rollback: "code-only", migrations: [],
      paused: [{ name: HUB_UNIT, manager: "systemd", active: true, enabled: true }], core_unit: null, issuer: s.origin,
      restored_at: now, moved_aside: `${m.home}.after-takeover-cut`,
    };
    writeFileSync(join(staged, "takeover.json"), JSON.stringify(record));
    renameSync(m.home, `${m.home}.after-takeover-cut`);
    const dry = await core(m, ["takeover", "--home", m.home, "--dry-run"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("--rollback --yes` finishes it");
    const back = await core(m, ["takeover", "--home", m.home, "--rollback", "--yes", "--json"]);
    must(back.code === 0, `--rollback after a cut-off restore exited ${back.code}: ${back.stderr.slice(-800)}`);
    expect(back.stderr).toContain("was cut off before the restored copy took its place");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(join(m.home, "takeover.json"))).toBe(false);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
    const c = await serving(m, s, HUB_UNIT);
    try {
      expect((await readNotes(s.origin, s.vaultName, s.readPass)).status).toBe(200);
    } finally {
      await c.stop();
    }
  }, 240_000);

  test("putting a cut-off takeover back keeps its record until the old unit has the data open again", async () => {
    // Codex's review of the rehearsal fixes (lane H): systemd accepting a start doesn't mean the old hub serves; if
    // the record went first, a unit that then failed left paused data and nothing for --rollback to finish.
    const { m, s } = await oldMachine("tk-stuck");
    const run = m.spawn([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"]);
    must(await until(() => dbHolders(m.home).some((h) => h.cmd.includes("--listen")), 90_000, 50), `setup: no check run:\n${run.log().slice(-1500)}`);
    for (const p of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      try {
        const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8");
        if ((cmd.includes("takeover") && cmd.includes(m.home)) || cmd.includes("--listen")) process.kill(Number(p), "SIGKILL");
      } catch {}
    }
    await run.stop("SIGKILL");
    must(await until(() => dbHolders(m.home).length === 0, 15_000, 100), "setup: the cut-off check run still holds the data");
    // The old hub's unit now starts something that never opens the home (as a unit that fails after starting would).
    const unitFile = join(m.unitDir, HUB_UNIT);
    const text = readFileSync(unitFile, "utf8");
    writeFileSync(unitFile, text.replace(/^ExecStart=.*$/m, "ExecStart=/bin/sleep 600"));
    const stuck = await m.run([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"], { timeoutMs: 200_000 });
    expect(stuck.code).not.toBe(0);
    expect(stuck.stderr).toContain("the record stays");
    expect(JSON.parse(readFileSync(join(m.home, "takeover.json"), "utf8")).state).toBe("taking-over");
    // Fixed, --rollback finishes the put-back.
    await m.run(["systemctl", "--user", "stop", HUB_UNIT]);
    writeFileSync(unitFile, text);
    const back = await m.run([requireCore(m.info), "takeover", "--home", m.home, "--rollback", "--yes", "--json"], { timeoutMs: 200_000 });
    must(back.code === 0, `--rollback after fixing the unit exited ${back.code}: ${back.stderr.slice(-800)}`);
    expect(existsSync(join(m.home, "takeover.json"))).toBe(false);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
    await serving(m, s, HUB_UNIT);
  }, 400_000);

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
    // Something else on the machine takes the hub's port as soon as the old hub lets go of it, so the unit's v0.8
    // can't bind it. The check run (on a free port) passes; only the hand-over to the unit fails.
    const squatter = m.spawn([process.execPath, "-e", `for (;;) { try { Bun.listen({ hostname: "127.0.0.1", port: ${s.port}, socket: { data() {} } }); break; } catch { await Bun.sleep(20); } } await Bun.sleep(600000)`]);
    try {
      const r = await m.run([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"], { timeoutMs: 240_000 });
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
    // The old programs, as their unit runs them again (restarted now the port is free), serve the notes as before.
    await m.run(["systemctl", "--user", "restart", HUB_UNIT]);
    await serving(m, s, HUB_UNIT);
    const got = await readNotes(s.origin, s.vaultName, s.readPass);
    expect(got.status).toBe(200);
    for (const n of s.notes) expect(got.notes.find((x) => x.id === n.id)?.content).toBe(n.content);
  }, 180_000);

  test("a unit whose environment file names another home is left alone, even when a drop-in's Environment= names this one (systemd's precedence)", async () => {
    const { m } = await oldMachine("tk-envfile");
    // systemd.exec(5): variables from EnvironmentFile= override Environment=, whatever the order of the lines.
    const envFile = join(m.user, "hub.env");
    writeFileSync(envFile, `PARACHUTE_HOME=${join(m.user, "another-home")}\n`);
    const unit = join(m.unitDir, HUB_UNIT);
    writeFileSync(unit, readFileSync(unit, "utf8").replace("[Service]\n", `[Service]\nEnvironmentFile=${envFile}\n`));
    mkdirSync(`${unit}.d`, { recursive: true });
    writeFileSync(join(`${unit}.d`, "home.conf"), `[Service]\nEnvironment=PARACHUTE_HOME=${m.home}\n`);
    await m.run(["systemctl", "--user", "restart", HUB_UNIT]); // now serving the other home, as systemd would run it
    await Bun.sleep(3000);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--dry-run", "--json"]);
    must(r.code === 0, `takeover --dry-run exited ${r.code}: ${r.stderr.slice(-600)}`);
    const hub = (json(r, "takeover --dry-run --json").units as any[]).find((u) => u.name === HUB_UNIT);
    expect(hub?.old).toBe(false);
    const y = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    expect(changesTo(m, HUB_UNIT, calls)).toEqual([]);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
    void y;
  }, 180_000);

  test("a unit whose quoted home has a space in it is read whole: one that serves '<this home> other' is left alone", async () => {
    const { m } = await oldMachine("tk-quoted");
    const unit = join(m.unitDir, HUB_UNIT);
    mkdirSync(`${unit}.d`, { recursive: true });
    writeFileSync(join(`${unit}.d`, "home.conf"), `[Service]\nEnvironment="PARACHUTE_HOME=${m.home} other"\n`);
    await m.run(["systemctl", "--user", "restart", HUB_UNIT]); // now serving '<this home> other'
    await Bun.sleep(3000);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--dry-run", "--json"]);
    must(r.code === 0, `takeover --dry-run exited ${r.code}: ${r.stderr.slice(-600)}`);
    const hub = (json(r, "takeover --dry-run --json").units as any[]).find((u) => u.name === HUB_UNIT);
    expect(hub?.old).toBe(false);
    await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    expect(changesTo(m, HUB_UNIT, calls)).toEqual([]);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
  }, 180_000);

  test("an old unit that is enabled but not running can't be seen serving any home: refused before anything changes", async () => {
    const { m, s } = await oldMachine("tk-unseen");
    await (await serving(m, s, HUB_UNIT)).stop(); // stopped, still enabled: what it serves can't be seen
    const before = await snapshot(m);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code !== 0, "takeover went ahead with an enabled old unit it couldn't see");
    expect(r.stderr).toContain(HUB_UNIT);
    expect(await snapshot(m)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("a drop-in that makes parachute-core.service reach another unit (Also=) stops the hand-over: exit 8, everything back, that unit untouched", async () => {
    const { m, s } = await oldMachine("tk-also");
    // A drop-in left on the core unit's name; enabling or disabling it would also enable or disable the vault unit.
    const dir = join(m.unitDir, "parachute-core.service.d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "also.conf"), `[Install]\nAlso=${VAULT_UNIT}\n`);
    const calls = m.systemctlCalls().length;
    const r = await m.run([requireCore(m.info), "takeover", "--home", m.home, "--yes", "--json"], { timeoutMs: 240_000 });
    must(r.code === 8, `takeover with a core unit that reaches ${VAULT_UNIT} exited ${r.code}, want 8: ${r.stderr.slice(-600)}`);
    expect(r.stderr).toContain(VAULT_UNIT);
    expect(changesTo(m, VAULT_UNIT, calls)).toEqual([]);
    expect(m.systemctlCalls().slice(calls).filter((c) => /\benable\b.*parachute-core/.test(c))).toEqual([]);
    expect(m.unit(HUB_UNIT)).toEqual({ active: true, enabled: true });
    expect(existsSync(join(m.home, "takeover.json"))).toBe(false);
    await serving(m, s, HUB_UNIT);
  }, 300_000);

  test("a parachute-core.service that serves another home is never replaced: refused before anything changes", async () => {
    const { m } = await oldMachine("tk-coreunit");
    const theirs = join(m.unitDir, "parachute-core.service");
    const text = `[Service]\nExecStart=/opt/elsewhere/bin/parachute-core serve\nEnvironment=PARACHUTE_HOME=${join(m.user, "another-home")}\n`;
    writeFileSync(theirs, text);
    const before = await snapshot(m, true);
    const calls = m.systemctlCalls().length;
    const r = await core(m, ["takeover", "--home", m.home, "--yes", "--json"]);
    must(r.code !== 0, "takeover went ahead and replaced another home's parachute-core.service");
    expect(r.stderr).toContain("parachute-core.service");
    expect(readFileSync(theirs, "utf8")).toBe(text);
    expect(await snapshot(m, true)).toEqual(before);
    expect(m.systemctlCalls().slice(calls).filter((c) => MUTATING.test(c))).toEqual([]);
    expect(existsSync(join(m.user, "parachute-takeover"))).toBe(false);
  }, 120_000);

  test("rollback: a note written under core reads and updates under the old programs", async () => {
    const { m, s } = await oldMachine("tk-rollback");
    const before = await snapshot(m, true);
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
    expect((await snapshot(m, true)).oldInstall).toBe(before.oldInstall);

    // The old programs, as their unit runs them again, on the same home.
    await serving(m, s, HUB_UNIT);
    {
      const api = rest(`${s.origin}/vault/${s.vaultName}`, s.writePass);
      const got = await api.get(`/notes/${written.id}`);
      expect(got.status).toBe(200);
      expect(got.body.content).toBe("Planted garlic in October; mulch after the first frost.");
      const up = await api.patch(`/notes/${written.id}`, { content: "Garlic mulched.", if_updated_at: got.body.updatedAt });
      expect(up.status).toBe(200);
      expect((await api.get(`/notes/${written.id}`)).body.content).toBe("Garlic mulched.");
      for (const n of s.notes) expect((await api.get(`/notes/${n.id}`)).body.content).toBe(n.content);
    }
  }, 120_000);
});

/** The note ids in a vault database file (a backup copy, read from a scratch copy of it). */
function notesIn(db: string): string[] {
  const d = new Database(db, { readonly: true });
  try {
    return (d.query("SELECT id FROM notes ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  } finally {
    d.close();
  }
}

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
