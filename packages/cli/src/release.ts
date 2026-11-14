// The step from one release to the next on a home (DESIGN-0.9 §6 "every step up to 1.0 has a migration path", §7
// "data always migrates automatically, forward, with a backup first"), and its way back.
//
//   run/release.json             which release last served this home, the one before it, the backup taken
//                                between them, and the channel `parachute upgrade` follows. `parachute changes`
//                                and the rollback read it.
//   parachute upgrade --rollback [--restore] [--yes] [--json]
//   parachute upgrade            on a home another release served last: the step, asked for by name (upgrade.ts)
//
// 0.8 → 0.9 is additive: the vault's tags gain a `kind` column and the hub a `keys` table, and neither schema number
// moves (DESIGN §8a, build note). So, by the 0.8 takeover's own rule (takeover.ts detect(): a migration is a schema
// number below the program's), there is no migration and 0.8 opens a 0.9 home unchanged. What 0.8 doesn't know it
// leaves alone, and 0.9 re-derives it on its next start (a NULL kind from the rule, a token 0.8 minted as a key).
//
// Still, the first 0.9 start on a home an older release served takes a backup first, the takeover's way: every
// database copied (VACUUM INTO: a consistent copy even with a -wal beside it) to
// <home>/../parachute-upgrade/<from>-to-<to>-<time>/home/, with manifest.json (a sha256 and the schema number per
// file). A home the 0.8 takeover just made (its record names this version) already has that backup and gets no
// second one. A host-managed (embedded) home is the host's to back up, so it gets none (Prism's contract v1).
//
// The step is never taken under a running server: while a Parachute server holds the home's databases, the command
// that would take it stops with exit 7 and changes nothing. A home must not be recorded as moved while the older
// release still serves it.
//
// The rollback, like the takeover's:
//   - code-only (the default): every database is at a schema number the previous release opens, so nothing changes
//     on disk and every 0.9 write is kept. It checks that, refuses while anything holds the data (exit 7), and
//     records the rollback;
//   - then it points the install's links back: where this release was installed beside the previous one
//     (`<prefix>/bin/parachute-core` → `../<version>/bin/`, install.ts), the links go back to the previous version,
//     so the unit's next start runs it. Where no previous copy is kept (an npm or bun install, an unpacked tarball)
//     it says exactly what to reinstall;
//   - a home marked rolled back is refused by this release and any other but the one it was rolled back to (exit 7,
//     nothing opened), until `parachute upgrade` is run with the newer release: that takes the step again, with a
//     new backup first. Without this, a unit still pointing at the newer release would move the home forward again
//     at its next restart;
//   - --restore: the backup's databases go back in place, after every note changed since is exported beside the
//     backup; what 0.9 left moves aside. Needed once a release moves a schema number (the first is planned for
//     0.9.1's enforced key scopes) or when 0.9 damaged data.
// Exit codes, as the takeover's: 0 done · 1 nothing to roll back, or it can't be done code-only · 2 flags, or no
// --yes where nobody can be asked · 5 no room for the backup · 7 a process holds the data.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import core from "../../../package.json" with { type: "json" };
import { isLockBusy, takeFileLock } from "./file-lock.ts";
import { databases, readDatabase, schemaOf } from "./home.ts";
import { hasVersion, installedPrefix, linkedVersion, pointLinks, readLinksRecord } from "./install.ts";
import { exportChanged, holders, RECORD_FILE, serveRefusal } from "./takeover.ts";

export const RELEASE_FILE = join("run", "release.json");
/** One command at a time backs up, catches up or rolls back a home: an exclusive SQLite lock, released on exit. */
export const RELEASE_LOCK = join("run", "release.lock");
export const EXIT = { ok: 0, failed: 1, usage: 2, noRoom: 5, held: 7 } as const;

export interface Release {
  /** The release serving this home now. */
  version: string;
  /** The release that served it before, or null for a home this release made: its exact version where the install
   *  knows it (0.8.0), else its line (0.8: before 0.9 nothing recorded a version). */
  previous: string | null;
  /** The npm dist-tag `parachute upgrade` fetches from (latest, next or beta). */
  channel?: string;
  since: string;
  /** The backup taken before this release first opened the home (a folder with home/ and manifest.json), or null. */
  backup: string | null;
  /** "restoring" from the moment a restore starts moving databases until it has finished. */
  state: "current" | "rolled-back" | "restoring";
  /** Databases the backup couldn't read: each is backed up into the same backup as soon as it can be read. */
  skipped?: string[];
  /** Set when this release came to the home by its own takeover (0.7 → this): roll back with the takeover. */
  via?: "takeover";
  rolled_back_at?: string;
  restored_at?: string;
  /** Where a restore moved what was live; a retried restore adds its own folders in moved_aside_retries. */
  moved_aside?: string;
  moved_aside_retries?: string[];
}

interface Manifest {
  from: string;
  to: string;
  at: string;
  home: string;
  files: Record<string, string>;
  schemas: Record<string, number | null>;
  /** Databases that couldn't be read, so weren't copied. A restore leaves them where they are. */
  skipped?: string[];
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readRelease(home: string): Release | undefined {
  const r = readJson(join(home, RELEASE_FILE));
  return r && typeof r.version === "string" ? (r as Release) : undefined;
}

export function writeRelease(home: string, r: Release): void {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const path = join(home, RELEASE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run `fn` holding the home's release lock. Every decision about run/release.json is re-read and made under it, so
 * two commands opening an older home at once take one backup, and a catch-up can't overwrite a rollback's state.
 */
export function withReleaseLock<T>(home: string, fn: () => T, waitMs = 60_000, busy = "another parachute command is backing up or rolling back this home; run this again when it has finished"): T {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  let db: Database;
  try {
    db = takeFileLock(join(home, RELEASE_LOCK), waitMs);
  } catch (err) {
    if (isLockBusy(err)) throw new Exit(EXIT.held, busy);
    throw err;
  }
  try {
    return fn();
  } finally {
    db.close();
  }
}

let sharedHold: Database | undefined;

/**
 * Hold the release lock shared for the rest of this process: any number of commands at once, but never while a
 * backup, catch-up or rollback holds it exclusively (each waits for the other). The OS lets go when the process
 * ends, however it ends.
 */
function holdShared(home: string): void {
  if (sharedHold) return;
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const db = new Database(join(home, RELEASE_LOCK), { create: true });
  try {
    chmodSync(join(home, RELEASE_LOCK), 0o600);
    db.exec("PRAGMA busy_timeout = 60000");
    db.exec("BEGIN");
    db.query("SELECT count(*) FROM sqlite_master").get(); // a read transaction left open: a SHARED lock
  } catch (err) {
    db.close();
    if (/locked|busy/i.test(String((err as Error)?.message))) {
      throw new Exit(EXIT.held, "another parachute command is backing up or rolling back this home; run this again when it has finished");
    }
    throw err;
  }
  sharedHold = db;
}

function letGoShared(): void {
  sharedHold?.close();
  sharedHold = undefined;
}

/** The channel a release is published on when nothing says otherwise: a prerelease on `beta`, a stable on `latest`. */
export function defaultChannel(version: string = core.version): string {
  return version.includes("-") ? "beta" : "latest";
}

/** Whether `version` is a release of `line` ("0.8.0-pre.3" and "0.8.0" are of "0.8"; "0.80.0" is not). */
const ofLine = (version: string, line: string) => version === line || version.startsWith(`${line}.`);

/**
 * The exact version that served a home before this release, where the install knows: this program is installed
 * under a prefix whose links were switched to it from a version of `line` (install.ts keeps that). Else `line`.
 */
function exactPrevious(line: string): string {
  const base = installedPrefix();
  const links = base ? readLinksRecord(base) : null;
  return links && links.current === core.version && ofLine(links.previous, line) ? links.previous : line;
}

/** Why this release leaves a rolled-back home alone, or null when it is the release the home was rolled back to. */
export function rolledBackRefusal(r: Release | undefined): string | null {
  if (!r || r.state !== "rolled-back" || r.previous === core.version) return null;
  return `this home was rolled back to ${r.previous}${r.rolled_back_at ? ` on ${r.rolled_back_at}` : ""}: ${r.previous} serves it, and ${core.version} leaves it alone. Nothing was opened or changed. To move it to ${core.version} again, stop Parachute and run \`parachute upgrade\` with ${core.version}.`;
}

/**
 * Why no command of this release may open `home` at all, whatever the command: it is marked rolled back to another
 * release, or a restore on it was cut off. For the commands that never reach beforeOpen (the host's `serve
 * --embedded` and `bootstrap`, `config`, an old name's usage count): dispatch asks this first.
 */
export function homeRefusal(home: string): { code: number; message: string } | null {
  if (process.env.PARACHUTE_TAKEOVER_CHECK === "1") return null;
  const r = readRelease(home);
  const rolled = rolledBackRefusal(r);
  if (rolled) return { code: EXIT.held, message: rolled };
  if (r?.state === "restoring") return { code: EXIT.failed, message: `a restore on this home was interrupted; what ${r.version} left is in ${r.moved_aside}. Run \`parachute upgrade --rollback --restore --yes\` again to finish it.` };
  return null;
}

/** Stop (exit 7) while any other process holds the home's databases: nothing is recorded under a running server. */
function notHeld(home: string, doing: string): void {
  const held = holders(home);
  if (held.length) {
    throw new Exit(EXIT.held, `${doing}, but something holds its data: ${held.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Nothing was changed. Stop Parachute (parachute stop, or its unit), then run this again.`);
  }
}

/** A Parachute server's command line: `parachute serve`, `parachute-core serve`, `parachute-vault serve`, from any install. */
const SERVER = /(^|[\s/])(parachute|parachute-core|parachute-vault)(\.ts)? serve\b|@openparachute\/(hub|vault|core)\b.* serve\b/;

/**
 * Stop (exit 7) while a Parachute server holds the home's databases: the older release is still serving it. Only a
 * server counts here (a backup tool or a script reading a database doesn't make the home anyone's), so the unit's
 * own first start is never stopped by a reader.
 */
const servedBy = (home: string) => holders(home).filter((h) => SERVER.test(h.cmd));

function notServed(home: string, doing: string): void {
  const served = servedBy(home);
  if (served.length) {
    throw new Exit(EXIT.held, `${doing}, but a Parachute server is running on it: ${served.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Nothing was changed: a home is not recorded as moved while another release serves it. Stop it (\`parachute stop\` and \`parachute restart\` still work from here, or use its unit), then run this again; \`parachute upgrade --check\` tries the step on a copy meanwhile.`);
  }
}

/** Copy each of the home's databases into `dest/home/<rel>`, consistently, with a checked manifest. */
export function snapshot(home: string, dest: string, from: string, skipped: string[] = []): Manifest {
  const dbs = databases(home, { hub: 0, vault: 0 }).filter((d) => !skipped.includes(d.rel));
  const need = dbs.reduce((n, d) => n + statSync(join(home, d.rel)).size + (existsSync(join(home, `${d.rel}-wal`)) ? statSync(join(home, `${d.rel}-wal`)).size : 0), 0);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const free = statfsSync(dirname(dest));
  if (free.bavail * free.bsize < need * 1.1 + 50e6) {
    throw new Exit(EXIT.noRoom, `the backup before ${core.version} first opens this home needs ${size(need)} and ${dirname(dest)} has ${size(free.bavail * free.bsize)} free. Nothing was changed.`);
  }
  mkdirSync(join(dest, "home"), { recursive: true, mode: 0o700 });
  const manifest: Manifest = { from, to: core.version, at: new Date().toISOString(), home, files: {}, schemas: {}, ...(skipped.length ? { skipped } : {}) };
  for (const d of dbs) {
    const to = join(dest, "home", d.rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    readDatabase(join(home, d.rel), (db) => db.run("VACUUM INTO ?", [to]), dest);
    chmodSync(to, 0o600);
    manifest.files[d.rel] = sha256(to);
    manifest.schemas[d.rel] = schemaOf(to, dest) ?? null;
  }
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/**
 * Before a command of this release opens the home: if another release served it last, record the step and back the
 * databases up first. A fresh home only gets its record. Throws Exit(5) when there is no room, before anything is
 * written. Leaves alone a host's (embedded) home, a home the old 0.7 programs still own (the takeover's job), and
 * the takeover's own check run.
 */
/** The newer-data check, run again once the lock is held: an exit code (having said why), or null. */
export type Recheck = () => number | null;

/** Stop with the recheck's code; it has already said why. */
function recheckOrStop(recheck: Recheck): void {
  const code = recheck();
  if (code !== null) throw new Exit(code, "");
}

export function beforeOpen(home: string, say: (s: string) => void = (s) => console.error(s), recheck: Recheck = () => null, forward = false, lifecycle = false): Release | undefined {
  if (process.env.PARACHUTE_TAKEOVER_CHECK === "1") return undefined;
  if (!existsSync(home) || existsSync(join(home, "embedded.json"))) return undefined;
  // `stop` and `restart` of the whole service, and `logs` (`lifecycle`: dispatch says which), are how the older
  // release's server is stopped from here: a newer release was just installed and the links name it, but the old
  // server still runs. They open no database, take no step and record nothing while it does; the server's next
  // start (this release's) takes the step.
  if (lifecycle && !forward) {
    const r = readRelease(home);
    if ((!r || r.version !== core.version || r.state !== "current") && !rolledBackRefusal(r) && r?.state !== "restoring" && servedBy(home).length) return undefined;
  }
  // A home the old 0.7 programs still own is the takeover's: nothing is written to it, not even the lock.
  if (!readRelease(home) && serveRefusal(home) !== null) return undefined;
  // A rolled-back home is the previous release's until `parachute upgrade` asks for the step again (`forward`):
  // refused before anything is opened, the lock included.
  if (!forward) {
    const refusal = rolledBackRefusal(readRelease(home));
    if (refusal) throw new Exit(EXIT.held, refusal);
  }
  // A step that would be refused under a running server is refused here, before the lock: the home of a release
  // that is still serving gets nothing from this one, not even an empty lock file. (Decided again under the lock.)
  if (stepNeeded(home, readRelease(home))) notServed(home, `${core.version} would back this home up and record the step`);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Every command holds the lock shared while it runs, so no rollback can move a database under it. Once held, the
    // newer-data check runs again: a newer release may have moved the home while this one waited.
    holdShared(home);
    recheckOrStop(recheck);
    const r = readRelease(home);
    if (!r || r.version !== core.version || r.state !== "current") {
      // A step to take: let go, take the lock exclusively (it waits for the other commands), then hold it shared again.
      letGoShared();
      let seen = "";
      const done = withReleaseLock(home, () => {
        recheckOrStop(recheck);
        const d = beforeOpenLocked(home, say, forward);
        seen = JSON.stringify(readRelease(home) ?? null);
        return d;
      });
      if (done === "old-owner") return undefined; // the takeover's home: serve refuses it with 7 (dispatch)
      if (done === "unreadable") {
        // Nothing recorded (no database can be read). Run holding the lock shared, once nothing changed meanwhile:
        // the same record, and still nothing readable. Otherwise take it from the top.
        holdShared(home);
        recheckOrStop(recheck);
        const nothingReadable = databases(home, { hub: 0, vault: 0 }).every((d) => !readable(join(home, d.rel), dirname(home)));
        if (nothingReadable && JSON.stringify(readRelease(home) ?? null) === seen) return undefined;
        letGoShared();
      }
      continue;
    }
    const recovered = (r.skipped ?? []).filter((rel) => existsSync(join(home, rel)) && readable(join(home, rel), dirname(home)));
    if (!recovered.length) return r; // the usual case: this release serves the home, and nothing waits to be backed up
    // A skipped database can be read now. Back it up if no other command runs; never wait on one (serve holds the
    // lock shared for its whole run, and waiting would block even `parachute stop`): try again at the next command.
    letGoShared();
    try {
      withReleaseLock(home, () => (recheckOrStop(recheck), beforeOpenLocked(home, say, forward)), 1_500);
    } catch (err) {
      if (!(err instanceof Exit) || err.code !== EXIT.held) throw err;
      say(`parachute: ${recovered.join(", ")} can be read now, but another parachute command is running; it is backed up at the next command that runs alone`);
      // Held shared again, everything is checked again: the home may have moved while the lock was let go.
      holdShared(home);
      recheckOrStop(recheck);
      const again = readRelease(home);
      if (again && again.version === core.version && again.state === "current") return again;
      letGoShared();
    }
  }
  throw new Exit(EXIT.failed, "this home's release record kept changing while this command started; run it again");
}

/**
 * Whether the locked step below would back the home up and record this release (the part never done under a
 * running server). Reads only, and follows beforeOpenLocked's own order of cases.
 */
function stepNeeded(home: string, was: Release | undefined): boolean {
  try {
    if (was && (was.state === "restoring" || (was.version === core.version && was.state === "current"))) return false;
    if (was?.state === "rolled-back" && was.previous === core.version) return false;
    if (serveRefusal(home) !== null) return false;
    const all = databases(home, { hub: 0, vault: 0 });
    const dbs = all.filter((d) => readable(join(home, d.rel), dirname(home)));
    if (dbs.length === 0) return false;
    if (!was && madeByThisLine(home, dbs)) return false;
    const takeover = readJson(join(home, RECORD_FILE));
    if (!was && takeover?.state === "taken-over" && takeover.version === core.version) return false;
    return true;
  } catch {
    return false; // can't tell without the lock: the locked step decides
  }
}

/** What the locked step did: the record now in force, or why it recorded nothing. */
function beforeOpenLocked(home: string, say: (s: string) => void, forward = false): Release | "old-owner" | "unreadable" {
  const was = readRelease(home);
  if (was && was.version === core.version && was.state === "current") return was.skipped?.length ? catchUp(home, was, say) : was;
  if (was?.state === "restoring") {
    throw new Exit(EXIT.failed, `a restore on this home was interrupted; what ${was.version} left is in ${was.moved_aside}. Run \`parachute upgrade --rollback --restore --yes\` again to finish it.`);
  }
  if (serveRefusal(home) !== null) return "old-owner";
  // Read again under the lock: a rollback may have finished while this command waited for it.
  const refusal = forward ? null : rolledBackRefusal(was);
  if (refusal) throw new Exit(EXIT.held, refusal);
  const since = new Date().toISOString();
  const channel = was?.channel ?? defaultChannel();
  if (was?.state === "rolled-back" && was.previous === core.version) {
    // This is the release the home was rolled back to, serving it again: it opens every database as it is (the
    // rollback checked that, or restored its backup), so there is no step to take and nothing to back up.
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current", channel };
    writeRelease(home, r);
    return r;
  }
  let dbs = databases(home, { hub: 0, vault: 0 });
  // A database that can't be read can't be backed up or judged: it is named, left out of the backup, and left alone
  // by a restore. Every readable one is still backed up first. The command then goes on and fails its own way if it
  // needs the broken one (a vault that can't open stops serve with 75). A home with nothing readable records nothing.
  const unreadable = dbs.filter((d) => !readable(join(home, d.rel), dirname(home))).map((d) => d.rel);
  const all = dbs;
  dbs = dbs.filter((d) => !unreadable.includes(d.rel));
  if (unreadable.length) say(`parachute: can't read ${unreadable.join(", ")}; it is not in any upgrade backup`);
  if (unreadable.length && dbs.length === 0) return "unreadable";
  if (all.length === 0) {
    const fresh: Release = { version: core.version, previous: was?.version ?? null, since, backup: null, state: "current", channel };
    writeRelease(home, fresh);
    return fresh;
  }
  // Before 0.9 nothing wrote this record. A home with data and no record was last served by 0.8 (a 0.7 home is the
  // takeover's until it has moved), unless 0.9 made it: a command that created the home found nothing to record
  // before it ran, and left 0.9's own structures (the hub's keys table, the tags' kind column) behind.
  if (!was && madeByThisLine(home, dbs)) {
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current", channel };
    writeRelease(home, r);
    return r;
  }
  const takeover = readJson(join(home, RECORD_FILE));
  if (!was && takeover?.state === "taken-over" && takeover.version === core.version) {
    // This release's own takeover moved the home from 0.7 minutes ago, with its own whole-home backup: the way
    // back is `parachute takeover --rollback`, not this record's.
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current", channel, via: "takeover" };
    writeRelease(home, r);
    return r;
  }
  const previous = was ? (was.state === "rolled-back" ? (was.previous ?? "0.8") : was.version) : exactPrevious("0.8");
  // The step itself, from here: never under a running server. A server holding the data is the older release still
  // serving this home, and a home it serves must not be recorded as moved.
  notServed(home, `${previous} → ${core.version} would back this home up and record the step`);
  const backup = join(dirname(home), "parachute-upgrade", `${previous}-to-${core.version}-${stamp()}`);
  say(`parachute: ${previous} → ${core.version} on this home: backing up its databases first, to ${backup}`);
  snapshot(home, backup, previous, unreadable);
  const r: Release = { version: core.version, previous, since, backup, state: "current", channel, ...(unreadable.length ? { skipped: unreadable } : {}) };
  writeRelease(home, r);
  return r;
}

/**
 * A database the backup skipped (it couldn't be read) and that can be read now, repaired or replaced: copy it into
 * the same backup before this release opens it, so the backup still holds every database as it was before 0.9.
 */
function catchUp(home: string, r: Release, say: (s: string) => void): Release {
  const now = r.skipped!.filter((rel) => existsSync(join(home, rel)) && readable(join(home, rel), dirname(home)));
  if (!now.length || !r.backup) return r;
  const path = join(r.backup, "manifest.json");
  const manifest = readJson(path) as Manifest;
  for (const rel of now) {
    if (rel in manifest.files) continue; // already copied: never replace a copy taken before 0.9 opened it
    const to = join(r.backup, "home", rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    rmSync(to, { force: true });
    readDatabase(join(home, rel), (db) => db.run("VACUUM INTO ?", [to]), r.backup);
    chmodSync(to, 0o600);
    manifest.files[rel] = sha256(to);
    manifest.schemas[rel] = schemaOf(to, r.backup) ?? null;
  }
  const left = (manifest.skipped ?? []).filter((rel) => !now.includes(rel));
  if (left.length) manifest.skipped = left;
  else delete manifest.skipped;
  writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  const next: Release = { ...r, ...(left.length ? { skipped: left } : {}) };
  if (!left.length) delete next.skipped;
  writeRelease(home, next);
  say(`parachute: ${now.join(", ")} can be read now; backed it up first, to ${r.backup}`);
  return next;
}

/** Whether SQLite can read `path` as a database (without changing a byte of the home). */
function readable(path: string, outside: string): boolean {
  try {
    readDatabase(path, (db) => db.query("SELECT count(*) FROM sqlite_master").get(), outside);
    return true;
  } catch {
    return false;
  }
}

/** Whether 0.9 already opened every database here (it adds `keys` to hub.db and `kind` to each vault's tags). */
function madeByThisLine(home: string, dbs: { rel: string }[]): boolean {
  return dbs.every((d) =>
    readDatabase(
      join(home, d.rel),
      (db) =>
        d.rel === "hub.db"
          ? !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'keys'").get()
          : (db.query("PRAGMA table_info(tags)").all() as { name: string }[]).some((c) => c.name === "kind"),
      dirname(home),
    ),
  );
}

/**
 * `beforeOpen` for dispatch: the exit code to stop with, or null to go on. Every command goes through it, help
 * flags included: some commands read `--help` as a value and open the data anyway.
 */
export function beforeOpenOrExit(home: string, recheck: Recheck = () => null, forward = false, lifecycle = false): number | null {
  try {
    beforeOpen(home, undefined, recheck, forward, lifecycle);
    return null;
  } catch (err) {
    if (err instanceof Exit) {
      if (err.message) console.error(`parachute: ${err.message}`);
      return err.code;
    }
    throw err;
  }
}

/**
 * systemd user units that start a fixed copy under this prefix (`…/.store/<version>-<id>/…`) instead of
 * `<prefix>/bin/parachute-core`: `parachute init` writes such a unit. Moving the links doesn't change what they
 * start, so whoever moved the links is told. (The takeover's unit runs `<prefix>/bin/parachute-core`.) Only the
 * user's own systemd units are looked at: a system unit or a macOS launchd agent is not seen.
 */
export function fixedUnits(base: string): { units_fixed?: string[] } {
  const dir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config"), "systemd", "user");
  const found: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".service")) continue;
      const exec = /^ExecStart=(.*)$/m.exec(readFileSync(join(dir, name), "utf8"))?.[1] ?? "";
      if (exec.includes(`${base}/.store/`)) found.push(name);
    }
  } catch {}
  return found.length ? { units_fixed: found } : {};
}

/** What to say when a unit won't follow the links (fixedUnits). */
export function fixedUnitsNote(links: LinksMove): string | null {
  if (!links.units_fixed?.length || !links.prefix) return null;
  return `${links.units_fixed.join(", ")} ${links.units_fixed.length > 1 ? "start" : "starts"} a fixed copy, not ${join(links.prefix, "bin", "parachute-core")}: moving the links doesn't change what ${links.units_fixed.length > 1 ? "they run" : "it runs"}. Set ${links.units_fixed.length > 1 ? "their" : "its"} ExecStart to \`${join(links.prefix, "bin", "parachute-core")} serve\`, then \`systemctl --user daemon-reload\`.`;
}

export interface LinksMove {
  moved: boolean;
  /** Units that start a fixed copy and so don't follow the links. */
  units_fixed?: string[];
  prefix?: string;
  bin?: string;
  to?: string;
  /** Not moved: why, and what to do instead. */
  why?: string;
  next?: string;
}

/** The version under `base` to go back to: the recorded one when it is still there, else the newest kept copy of that line. */
function previousCopy(base: string, previous: string): string | null {
  if (hasVersion(base, previous)) return previous;
  const links = readLinksRecord(base);
  if (links && links.current === core.version && ofLine(links.previous, previous) && hasVersion(base, links.previous)) return links.previous;
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {}
  const kept = names.filter((n) => n !== core.version && ofLine(n, previous) && hasVersion(base, n));
  // Newest first, compared as versions (0.8.10 after 0.8.9; 0.8.0 after 0.8.0-pre.3).
  kept.sort((a, b) => Bun.semver.order(b, a));
  return kept[0] ?? null;
}

/**
 * After a rollback is recorded: point the install's links back at the previous release, where this program is
 * installed beside it. Never throws: the rollback is done either way, and what it couldn't do it says.
 */
function linksBack(previous: string): LinksMove {
  const reinstall = `Reinstall ${previous} (\`bun add -g ${core.name}@${previous}\`, or its bundle's \`parachute install\`), then start it.`;
  const base = installedPrefix();
  if (!base) return { moved: false, why: `This ${core.version} is not installed beside ${previous} (an npm or bun install, or an unpacked bundle), so there are no links to point back.`, next: reinstall };
  const bin = join(base, "bin", "parachute-core");
  try {
    const to = previousCopy(base, previous);
    if (!to) return { moved: false, prefix: base, why: `No copy of ${previous} is kept in ${base}.`, next: reinstall };
    if (linkedVersion(base) !== to) pointLinks(base, to);
    return { moved: true, prefix: base, bin, to, ...fixedUnits(base) };
  } catch (err) {
    return { moved: false, prefix: base, why: `The links in ${join(base, "bin")} could not be pointed back (${(err as Error)?.message ?? err}).`, next: `Point them at ${previous} by hand, or run its own \`parachute install --prefix ${base}\`, then start it.` };
  }
}

/**
 * `parachute upgrade` on a home another release served last, or that was rolled back: the step, asked for by name.
 * The backup first, then the record; refused (exit 7) while anything holds the data. Returns the record, and where
 * the install's links point now (moved to this release when it is installed under a prefix).
 */
export function stepForward(home: string, say: (s: string) => void, recheck: Recheck = () => null): { release: Release | undefined; links: LinksMove } {
  const release = beforeOpen(home, say, recheck, true);
  letGoShared();
  const base = installedPrefix();
  let links: LinksMove = { moved: false };
  // Only once the step is recorded: links that name this release on a home it hasn't taken would start it there.
  if (release?.version === core.version && release.state === "current" && base && hasVersion(base, core.version)) {
    try {
      if (linkedVersion(base) !== core.version) pointLinks(base, core.version);
      links = { moved: true, prefix: base, bin: join(base, "bin", "parachute-core"), to: core.version, ...fixedUnits(base) };
    } catch (err) {
      links = { moved: false, prefix: base, why: `The links in ${join(base, "bin")} could not be pointed at ${core.version} (${(err as Error)?.message ?? err}).`, next: `Run \`${join(base, core.version, "bin", "parachute")} install --prefix ${base}\`.` };
    }
  }
  return { release, links };
}

function plan(home: string, r: Release, restore: boolean) {
  const manifest = r.backup ? (readJson(join(r.backup, "manifest.json")) as Manifest | undefined) : undefined;
  const schemaOrNull = (rel: string) => {
    try {
      return schemaOf(join(home, rel), dirname(home)) ?? null;
    } catch {
      return null; // can't be read: a database the backup skipped, which a restore leaves where it is
    }
  };
  const now = databases(home, { hub: 0, vault: 0 }).map((d) => ({ rel: d.rel, schema: schemaOrNull(d.rel) }));
  // Code-only needs every database at a number the previous release opens: the number it had in the backup.
  const schemas = manifest?.schemas ?? {};
  const moved = now.filter((d) => d.rel in schemas && (d.schema ?? 0) > (schemas[d.rel] ?? 0));
  return { manifest, now, moved, mode: restore ? ("restore" as const) : ("code-only" as const) };
}

/** What a restore kept of the revocations made since the backup, by kind. */
export interface KeptRevocations {
  tokens: number;
  /** Tokens minted since the backup and still live: revoked, since the restored hub would not know them. */
  made_since: number;
  signing_keys: number;
  clients: number;
  grants: number;
  sessions: number;
  invites: number;
  sign_ins: number;
  /** Sign-in keys (Nostr pubkeys) unlinked from an account since: unlinked here too. */
  pubkeys: number;
}

/** What a restore brings back though it was taken away since, and can't safely undo itself: said, never silent. */
export interface NotCarried {
  /** Accounts deleted since the backup, by name: they are back (their tokens and sessions stay revoked). */
  accounts_back: string[];
  /** Accounts whose role or vault list changed since: they have the backup's again. */
  access_changed: string[];
}

/** A hub.db that came after the backup and can't tell what was revoked since: unreadable, or another hub's. */
export class SourceUnusable extends Error {
  constructor(
    readonly source: string,
    readonly why: string,
  ) {
    super(`${source}: ${why}`);
  }
}

/**
 * Carry every revocation made since the backup into the staged copy of the backup's hub.db, before it takes the live
 * one's place: putting the backup back must never make a revoked credential work again. Read from each hub.db that
 * came after the backup (the live one, and on a retried restore what earlier attempts moved aside), each only if it
 * is the same hub (it shares a signing key with the backup), so a hub.db made afresh since can't revoke everything.
 *
 *   tokens        revoked since: revoked here too. Minted and revoked since: its row is copied in, revoked, so the
 *                 revocation list names it (a vault takes any well-signed token the list doesn't name). Minted
 *                 since and still live: copied in, revoked now (`made_since`): what was made since the backup is
 *                 gone, and a key the hub has no record of must not go on working. Gone since
 *                 (the client reaper deletes only dead rows): revoked here, if not yet expired.
 *   signing keys  retired since: retired here too (the hub makes a new one when none is active).
 *   clients       removed since: removed here, with their grants and codes. No longer approved: not approved here.
 *   grants        removed since: removed here (the app asks for consent again). Narrowed: narrowed here.
 *   sessions      ended since (sign-out, password change): ended here.
 *   invites       revoked or used since: revoked or used here.
 *   sign-ins      an account's password or two-factor secrets changed since: the current ones here, so an old
 *                 password doesn't work again.
 *   sign-in keys  a Nostr pubkey unlinked from an account since: unlinked here too (it can sign in).
 * Not carried (`notCarried` names them, the command says them, docs/UPGRADE-0.9.md says why): accounts deleted
 * since, and changes to an account's vaults or role.
 *
 * A source that can't be read, or isn't this hub, can't say what was revoked: it throws SourceUnusable, and the
 * caller stops before anything moves unless it was told to go on without (`--forget-revocations`).
 */
export function keepRevocations(staged: string, sources: string[], outside: string, notCarried: NotCarried = { accounts_back: [], access_changed: [] }): KeptRevocations {
  const kept: KeptRevocations = { tokens: 0, made_since: 0, signing_keys: 0, clients: 0, grants: 0, sessions: 0, invites: 0, sign_ins: 0, pubkeys: 0 };
  const now = new Date().toISOString();
  const db = new Database(staged);
  try {
    const tables = (d: Database) => new Set((d.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    const columns = (d: Database, table: string) => (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const mine = tables(db);
    const kids = new Set(mine.has("signing_keys") ? (db.query("SELECT kid FROM signing_keys").all() as { kid: string }[]).map((k) => k.kid) : []);
    for (const source of sources) {
      let after: { has: Set<string>; cols: Record<string, string[]>; rows: Record<string, any[]> };
      try {
        after = readDatabase(source, (s) => {
          const has = tables(s);
          const cols: Record<string, string[]> = {};
          const rows: Record<string, any[]> = {};
          for (const t of ["signing_keys", "tokens", "clients", "grants", "sessions", "invites", "users", "user_pubkeys", "user_vaults"]) {
            if (!has.has(t)) continue;
            cols[t] = columns(s, t);
            rows[t] = s.query(`SELECT * FROM ${t}`).all() as any[];
          }
          return { has, cols, rows };
        }, outside);
      } catch (err) {
        throw new SourceUnusable(source, `can't be read (${String((err as Error)?.message ?? err).split("\n")[0]})`);
      }
      // (A backup whose hub never made a signing key can't be told apart by one: taken for the same hub.)
      if (kids.size > 0 && !(after.rows.signing_keys ?? []).some((k) => kids.has(k.kid))) throw new SourceUnusable(source, "shares no signing key with the backup's hub.db: it is not the same hub");
      const by = (table: string, key: (r: any) => string) => new Map((after.rows[table] ?? []).map((r) => [key(r), r]));
      const shared = (table: string) => (after.cols[table] ?? []).filter((c) => mine.has(table) && columns(db, table).includes(c));
      db.transaction(() => {
        if (mine.has("tokens") && after.has.has("tokens")) {
          const later = by("tokens", (r) => r.jti);
          const cols = shared("tokens");
          const users = new Set((db.query("SELECT id FROM users").all() as { id: string }[]).map((u) => u.id));
          for (const t of after.rows.tokens!) {
            const here = db.query("SELECT revoked_at FROM tokens WHERE jti = ?").get(t.jti) as { revoked_at: string | null } | null;
            if (here?.revoked_at) continue;
            if (!t.revoked_at) {
              // Live, and in the backup too: it goes on working. Live, and minted since: the restored hub has no
              // record of it, so nobody could list or revoke it, yet a vault would take it (well-signed, not on
              // the revocation list) until it expired. What was made since the backup is gone: its row goes in,
              // revoked now.
              if (here || !(t.expires_at > now)) continue;
              const row = { ...t, user_id: t.user_id && users.has(t.user_id) ? t.user_id : null, revoked_at: now };
              db.run(`INSERT INTO tokens (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c] ?? null));
              kept.made_since++;
              continue;
            }
            if (here) {
              const set = ["revoked_at", "revoked_by", "revoked_via"].filter((c) => cols.includes(c));
              db.run(`UPDATE tokens SET ${set.map((c) => `${c} = ?`).join(", ")} WHERE jti = ?`, [...set.map((c) => t[c] ?? null), t.jti]);
            } else {
              // Minted since the backup: its account may be newer than the backup too (user_id may be NULL).
              const row = { ...t, user_id: t.user_id && users.has(t.user_id) ? t.user_id : null };
              db.run(`INSERT INTO tokens (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c] ?? null));
            }
            kept.tokens++;
          }
          for (const t of db.query("SELECT jti FROM tokens WHERE revoked_at IS NULL AND expires_at > ?").all(now) as { jti: string }[]) {
            if (later.has(t.jti)) continue;
            db.run("UPDATE tokens SET revoked_at = ? WHERE jti = ?", [now, t.jti]);
            kept.tokens++;
          }
        }
        if (mine.has("signing_keys")) {
          for (const k of after.rows.signing_keys!) {
            if (!k.retired_at) continue;
            kept.signing_keys += db.run("UPDATE signing_keys SET retired_at = ? WHERE kid = ? AND retired_at IS NULL", [k.retired_at, k.kid]).changes;
          }
        }
        if (mine.has("clients") && after.has.has("clients")) {
          const later = by("clients", (r) => r.client_id);
          for (const c of db.query("SELECT client_id, status FROM clients").all() as { client_id: string; status: string }[]) {
            const l = later.get(c.client_id);
            if (!l) {
              // As the hub removes a client (clients.ts deleteClient): its codes and grants first.
              if (mine.has("auth_codes")) db.run("DELETE FROM auth_codes WHERE client_id = ?", [c.client_id]);
              if (mine.has("grants")) db.run("DELETE FROM grants WHERE client_id = ?", [c.client_id]);
              db.run("DELETE FROM clients WHERE client_id = ?", [c.client_id]);
              kept.clients++;
            } else if (c.status === "approved" && l.status !== "approved") {
              db.run("UPDATE clients SET status = ? WHERE client_id = ?", [l.status, c.client_id]);
              kept.clients++;
            }
          }
        }
        if (mine.has("grants") && after.has.has("grants")) {
          const later = by("grants", (r) => `${r.user_id} ${r.client_id}`);
          for (const g of db.query("SELECT user_id, client_id, scopes FROM grants").all() as { user_id: string; client_id: string; scopes: string }[]) {
            const l = later.get(`${g.user_id} ${g.client_id}`);
            const still = new Set(String(l?.scopes ?? "").split(" ").filter(Boolean));
            const scopes = g.scopes.split(" ").filter(Boolean);
            const left = scopes.filter((s) => still.has(s));
            if (left.length === scopes.length) continue;
            if (left.length) db.run("UPDATE grants SET scopes = ? WHERE user_id = ? AND client_id = ?", [left.join(" "), g.user_id, g.client_id]);
            else db.run("DELETE FROM grants WHERE user_id = ? AND client_id = ?", [g.user_id, g.client_id]);
            kept.grants++;
          }
        }
        if (mine.has("sessions") && after.has.has("sessions")) {
          const later = by("sessions", (r) => r.id);
          for (const s of db.query("SELECT id FROM sessions WHERE expires_at > ?").all(now) as { id: string }[]) {
            if (later.has(s.id)) continue;
            db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
            kept.sessions++;
          }
        }
        if (mine.has("invites") && after.has.has("invites")) {
          const cols = shared("invites");
          for (const i of after.rows.invites!) {
            const here = db.query("SELECT * FROM invites WHERE token = ?").get(i.token) as any;
            if (!here) continue;
            const revoked = i.revoked_at && !here.revoked_at;
            const used = cols.includes("used_count") ? (i.used_count ?? 0) > (here.used_count ?? 0) : !!i.used_at && !here.used_at;
            if (revoked) db.run("UPDATE invites SET revoked_at = ? WHERE token = ?", [i.revoked_at, i.token]);
            if (used) {
              const set = ["used_at", "used_count"].filter((c) => cols.includes(c));
              db.run(`UPDATE invites SET ${set.map((c) => `${c} = ?`).join(", ")} WHERE token = ?`, [...set.map((c) => i[c] ?? null), i.token]);
            }
            if (revoked || used) kept.invites++;
          }
        }
        if (mine.has("user_pubkeys") && after.has.has("user_pubkeys")) {
          const later = new Set(after.rows.user_pubkeys!.map((r) => `${r.pubkey} ${r.user_id}`));
          for (const k of db.query("SELECT pubkey, user_id FROM user_pubkeys").all() as { pubkey: string; user_id: string }[]) {
            if (later.has(`${k.pubkey} ${k.user_id}`)) continue;
            db.run("DELETE FROM user_pubkeys WHERE pubkey = ?", [k.pubkey]);
            kept.pubkeys++;
          }
        }
        if (mine.has("users") && after.has.has("users")) {
          // Said, not undone: an account deleted since is back, and a role or vault list changed since is the
          // backup's again.
          const later = by("users", (r) => r.id);
          const vaultsOf = (rows: any[], id: string) => rows.filter((v) => v.user_id === id).map((v) => `${v.vault_name}:${v.role ?? ""}`).sort().join(" ");
          const mineVaults = mine.has("user_vaults") ? (db.query("SELECT * FROM user_vaults").all() as any[]) : [];
          const userCols = columns(db, "users");
          for (const u of db.query("SELECT * FROM users").all() as any[]) {
            const name = String(u.username ?? u.id);
            const l = later.get(u.id);
            if (!l) {
              if (!notCarried.accounts_back.includes(name)) notCarried.accounts_back.push(name);
            } else if ((userCols.includes("role") && u.role !== l.role) || (after.has.has("user_vaults") && vaultsOf(mineVaults, u.id) !== vaultsOf(after.rows.user_vaults ?? [], u.id))) {
              if (!notCarried.access_changed.includes(name)) notCarried.access_changed.push(name);
            }
          }
        }
        if (mine.has("users") && after.has.has("users")) {
          const cols = shared("users").filter((c) => ["password_hash", "password_changed", "totp_secret", "totp_backup_codes", "totp_enrolled_at"].includes(c));
          for (const u of after.rows.users!) {
            const here = db.query("SELECT * FROM users WHERE id = ?").get(u.id) as any;
            if (!here || cols.every((c) => here[c] === u[c])) continue;
            db.run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => u[c] ?? null), u.id]);
            kept.sign_ins++;
          }
        }
      })();
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  // Only the database file itself is moved into the home: nothing may be left in a WAL beside it.
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${staged}${suffix}`;
    if (!existsSync(p)) continue;
    if (suffix === "-wal" && statSync(p).size > 0) throw new Exit(EXIT.failed, `the staged ${basename(staged)} kept a write-ahead log; nothing was changed`);
    rmSync(p);
  }
  return kept;
}

/** `parachute upgrade --rollback [--restore] [--yes] [--json]`: back to the release before this one. */
export async function rollback(home: string, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const restore = args.includes("--restore");
  const yes = args.includes("--yes") || args.includes("-y");
  const forget = args.includes("--forget-revocations");
  const unknown = args.find((a) => !["--rollback", "--restore", "--yes", "-y", "--json", "--forget-revocations"].includes(a)) ?? (forget && !restore ? "--forget-revocations (it goes with --restore)" : undefined);
  const say = (s: string) => (json ? console.error(s) : console.log(s));
  try {
    if (unknown) throw new Exit(EXIT.usage, `unknown argument '${unknown}'\nusage: parachute upgrade --rollback [--restore [--forget-revocations]] [--yes] [--json]`);
    const r = readRelease(home);
    const asked = r ?? undefined;
    if (r?.via === "takeover") throw new Exit(EXIT.failed, "this home came over from 0.7 by the takeover; `parachute takeover --rollback` goes back");
    const resuming = r?.state === "restoring";
    if (resuming && !restore) throw new Exit(EXIT.failed, "a restore on this home was interrupted; finish it with --restore --yes");
    if (r?.state === "rolled-back" && r.previous && r.previous !== core.version) {
      // Rolled back already. If the links couldn't be moved then (and can be now), finish that; else nothing to do.
      const base = installedPrefix();
      if (base && linkedVersion(base) === core.version) {
        const links = linksBack(r.previous);
        if (links.moved) {
          say(`This home was rolled back to ${r.previous} on ${r.rolled_back_at}; ${links.bin} runs ${links.to} again now: start it (its unit, or \`parachute serve\`).`);
          const note = fixedUnitsNote(links);
          if (note) say(note);
          if (json) console.log(JSON.stringify({ rolled_back: true, from: r.version, to: r.previous, mode: "links-only", links }));
          return EXIT.ok;
        }
        throw new Exit(EXIT.failed, `this home was rolled back to ${r.previous} on ${r.rolled_back_at}, but ${join(base, "bin")} still runs ${core.version}. ${links.why ?? ""} ${links.next ?? ""}`.trim());
      }
    }
    if (!r || (r.state !== "current" && !resuming) || !r.previous) {
      throw new Exit(EXIT.failed, r?.state === "rolled-back" ? `this home was rolled back to ${r.previous} on ${r.rolled_back_at}; nothing to roll back` : `no earlier release served this home (run/release.json says ${r ? `${r.version}, first` : "nothing"}); nothing to roll back`);
    }
    if (restore && !yes) {
      // Asked before any check below, so what is checked is what the restore then does.
      const at = (readJson(join(r.backup ?? "", "manifest.json")) as Manifest | undefined)?.at ?? "an unknown time";
      if (!process.stdin.isTTY) throw new Exit(EXIT.usage, "--restore puts the backup's databases back; add --yes to go ahead");
      process.stdout.write(`Put back the databases backed up at ${at} (notes changed since are exported first)? [y/N] `);
      const answer = await new Promise<string>((res) => process.stdin.once("data", (b) => res(String(b).trim())));
      if (!/^y(es)?$/i.test(answer)) throw new Exit(EXIT.usage, "not confirmed; nothing was changed");
    }
    // Exclusive: it waits for no running command. Serve, or any command still running on the home, holds the lock
    // shared for its whole run, so the rollback says so (exit 7) instead of moving databases under it.
    const done = withReleaseLock(home, () => {
      // Read again under the lock: what was asked about may have changed while the question waited. It must be the
      // same step (and so the same backup) that was confirmed.
      const r = readRelease(home);
      const same = (a?: Release) => a && JSON.stringify([a.version, a.previous, a.since, a.backup]);
      if (same(r) !== same(asked)) throw new Exit(EXIT.failed, "this home's release record changed while the rollback waited; nothing was changed, run it again");
      const resuming = r?.state === "restoring";
      if (!r || (r.state !== "current" && !resuming) || !r.previous || r.via === "takeover" || (resuming && !restore)) {
        throw new Exit(EXIT.failed, "this home's release record changed while the rollback waited; run it again");
      }
      const p = plan(home, r, restore);
      if (restore && !p.manifest?.files) throw new Exit(EXIT.failed, `there is no backup to restore (${r.backup ?? "none was taken"})`);
      if (!restore && p.moved.length) {
        throw new Exit(EXIT.failed, `${r.previous} can't open ${p.moved.map((d) => d.rel).join(", ")} as it is now (a schema number moved since the backup). Run with --restore: it exports every note changed since, then puts the backup back.`);
      }
      if (restore) {
        // The export keys vaults by name: two databases for one name (a leftover older layout) would export one.
        const names = new Map<string, string>();
        for (const d of p.now) {
          if (d.rel === "hub.db") continue;
          const name = basename(dirname(d.rel));
          if (names.has(name)) throw new Exit(EXIT.failed, `two databases for the vault '${name}' (${names.get(name)}, ${d.rel}); move the one not in use out of the home first`);
          names.set(name, d.rel);
        }
      }
      const stopIfHeld = () => notHeld(home, "the rollback is ready");
      stopIfHeld();
      const out: Record<string, unknown> = { rolled_back: true, from: r.version, to: r.previous, mode: p.mode, backup: r.backup };
      if (p.mode === "code-only") {
        say(`Every database here is at a schema number ${r.previous} opens, so nothing on disk changes and every ${r.version} write is kept.`);
      } else {
        const files = p.manifest!.files;
        // 1. Stage the backup's databases beside the home and check each against the manifest, before anything moves.
        const staged = join(r.backup!, `staged-${stamp()}`);
        for (const [rel, hash] of Object.entries(files)) {
          const to = join(staged, rel);
          mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
          writeFileSync(to, readFileSync(join(r.backup!, "home", rel)), { mode: 0o600 });
          if (sha256(to) !== hash) throw new Exit(EXIT.failed, `the backup's ${rel} doesn't match its manifest; nothing was changed`);
        }
        // Checked, then given every revocation made since the backup. Every attempt stages afresh and applies them
        // again, from the live hub.db and from what an interrupted attempt moved aside (its live hub.db may be there).
        const asidesBefore = [...(r.moved_aside ? [r.moved_aside] : []), ...(r.moved_aside_retries ?? [])];
        const notCarried: NotCarried = { accounts_back: [], access_changed: [] };
        let kept: KeptRevocations | undefined;
        if ("hub.db" in files && forget) {
          out.revocations_kept = null;
          say("--forget-revocations: the backup's hub.db goes back as it was. Whatever was revoked since the backup works again; revoke it again once the previous release runs.");
        } else if ("hub.db" in files) {
          try {
            kept = keepRevocations(join(staged, "hub.db"), [home, ...asidesBefore].map((d) => join(d, "hub.db")).filter((p) => existsSync(p)), dirname(home), notCarried);
          } catch (err) {
            if (!(err instanceof SourceUnusable)) throw err;
            rmSync(staged, { recursive: true, force: true });
            // Nothing has moved. Putting the backup back now would make everything revoked since work again.
            throw new Exit(EXIT.failed, `${err.source.replace(`${home}/`, "")} ${err.why}, so what was revoked since the backup can't be carried over. Nothing was changed. To restore anyway, knowing that keys, sessions and apps revoked since the backup will work again, add --forget-revocations.`);
          }
          const total = Object.values(kept).reduce((a, b) => a + b, 0);
          out.revocations_kept = total;
          out.revocations_kept_by_kind = kept;
          const kinds = Object.entries(kept).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k.replace("_", " ")}`);
          say(`Kept ${total} revocations made since the backup${kinds.length ? ` (${kinds.join(", ")})` : ""}: no key, session or app revoked since works again`);
          out.not_carried = notCarried;
          if (notCarried.accounts_back.length) say(`Back, though deleted since the backup (delete again once the previous release runs): account${notCarried.accounts_back.length > 1 ? "s" : ""} ${notCarried.accounts_back.join(", ")}`);
          if (notCarried.access_changed.length) say(`With the backup's role and vaults again, though changed since (set again): ${notCarried.access_changed.join(", ")}`);
        }
        // 2. Export every note that differs from the backup, then check again that nothing has started since.
        const dir = join(r.backup!, `changed-since-${stamp()}`);
        // Always, a resumed restore too: what an interrupted one left (or an older release wrote since) is compared
        // with the backup like the rest, and a database already put back shows no change.
        const left = p.manifest!.skipped ?? [];
        out.exported_notes = exportChanged(home, join(r.backup!, "home"), dir, left);
        out.exported_to = dir;
        say(`Exported ${out.exported_notes} notes changed since the backup to ${dir}`);
        stopIfHeld();
        // 3. Swap: what is live moves aside, the staged copies take its place (renames on one filesystem). The record
        //    says "restoring" throughout, so an interrupted swap is refused by every command until it is finished.
        // Each attempt moves aside into its own folder, so a retry never overwrites what the first attempt kept.
        const aside = join(r.backup!, `after-${r.version}-${stamp()}`);
        const asides = [...(r.moved_aside ? [r.moved_aside] : []), ...(r.moved_aside_retries ?? [])];
        writeRelease(home, { ...r, state: "restoring", moved_aside: asides[0] ?? aside, ...(asides.length ? { moved_aside_retries: [...asides.slice(1), aside] } : {}) });
        for (const rel of new Set([...p.now.map((d) => d.rel).filter((rel) => !left.includes(rel)), ...Object.keys(files)])) {
          for (const suffix of ["", "-wal", "-shm"]) {
            const live = join(home, rel + suffix);
            if (!existsSync(live)) continue;
            mkdirSync(dirname(join(aside, rel)), { recursive: true, mode: 0o700 });
            renameSync(live, join(aside, rel + suffix));
          }
        }
        for (const rel of Object.keys(files)) {
          mkdirSync(dirname(join(home, rel)), { recursive: true, mode: 0o700 });
          renameSync(join(staged, rel), join(home, rel));
        }
        out.moved_aside = aside;
        say(`Put the backup's databases back; what ${r.version} left is in ${aside}`);
      }
      const at = new Date().toISOString();
      writeRelease(home, { ...r, state: "rolled-back", rolled_back_at: at, ...(p.mode === "restore" ? { restored_at: at, moved_aside: readRelease(home)?.moved_aside ?? (out.moved_aside as string), moved_aside_retries: readRelease(home)?.moved_aside_retries } : {}) });
      // The record is written first: from here this release refuses the home, whatever the links say.
      const links = linksBack(r.previous);
      out.links = links;
      say(`Rolled back: ${home} is ${r.previous}'s again, and ${r.version} now leaves it alone.`);
      if (links.moved) say(`${links.bin} runs ${links.to} again: start it (its unit, or \`parachute serve\`).`);
      else say(`${links.why} ${links.next}`);
      const unitNote = fixedUnitsNote(links);
      if (unitNote) say(unitNote);
      say(`To move this home to ${r.version} again later, run \`parachute upgrade\` with ${r.version}${links.moved ? ` (${join(links.prefix!, r.version, "bin", "parachute")})` : ""}: it backs up first.`);
      if (json) console.log(JSON.stringify(out));
      return EXIT.ok;
    }, 3_000, "a parachute command is running on this home (serve, or another); stop it (parachute stop, or its unit), then run this again");
    return done;
  } catch (caught) {
    // A database that can't be read (or any other fault) is said plainly, never as a stack trace.
    const err = caught instanceof Exit ? caught : new Exit(EXIT.failed, `${(caught as Error)?.message ?? caught}; nothing more was changed`);
    console.error(`parachute upgrade --rollback: ${err.message}`);
    if (json) console.log(JSON.stringify({ rolled_back: false, error: err.message, exit: err.code }));
    return err.code;
  }
}
