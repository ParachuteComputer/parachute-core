// The step from one release to the next on a home (DESIGN-0.9 §6 "every step up to 1.0 has a migration path", §7
// "data always migrates automatically, forward, with a backup first"), and its way back.
//
//   run/release.json             which release last served this home, the one before it, and the backup taken
//                                between them. `parachute changes` and the rollback read it.
//   parachute upgrade --rollback [--restore] [--yes] [--json]
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
// The rollback, like the takeover's:
//   - code-only (the default): every database is at a schema number the previous release opens, so nothing changes
//     on disk and every 0.9 write is kept. It checks that, refuses while anything holds the data (exit 7), and
//     records the rollback, so the next 0.9 start backs up again;
//   - --restore: the backup's databases go back in place, after every note changed since is exported beside the
//     backup; what 0.9 left moves aside. Needed once a release moves a schema number (the first is planned for
//     0.9.1's enforced key scopes) or when 0.9 damaged data.
// Exit codes, as the takeover's: 0 done · 1 nothing to roll back, or it can't be done code-only · 2 flags, or no
// --yes where nobody can be asked · 5 no room for the backup · 7 a process holds the data.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import core from "../../../package.json" with { type: "json" };
import { databases, readDatabase, schemaOf } from "./home.ts";
import { exportChanged, holders, RECORD_FILE, serveRefusal } from "./takeover.ts";

export const RELEASE_FILE = join("run", "release.json");
/** One command at a time backs up, catches up or rolls back a home: an exclusive SQLite lock, released on exit. */
export const RELEASE_LOCK = join("run", "release.lock");
export const EXIT = { ok: 0, failed: 1, usage: 2, noRoom: 5, held: 7 } as const;

export interface Release {
  /** The release serving this home now. */
  version: string;
  /** The release that served it before, or null for a home this release made. */
  previous: string | null;
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

function writeRelease(home: string, r: Release): void {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const path = join(home, RELEASE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

class Exit extends Error {
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
  const db = new Database(join(home, RELEASE_LOCK), { create: true });
  try {
    chmodSync(join(home, RELEASE_LOCK), 0o600);
    db.exec(`PRAGMA busy_timeout = ${waitMs}`);
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS hold (pid INTEGER)");
      db.exec("COMMIT"); // in exclusive locking mode the lock stays until the connection closes
    } catch (err) {
      if (/locked|busy/i.test(String((err as Error)?.message))) {
        throw new Exit(EXIT.held, busy);
      }
      throw err;
    }
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

export function beforeOpen(home: string, say: (s: string) => void = (s) => console.error(s), recheck: Recheck = () => null): Release | undefined {
  if (process.env.PARACHUTE_TAKEOVER_CHECK === "1") return undefined;
  if (!existsSync(home) || existsSync(join(home, "embedded.json"))) return undefined;
  // A home the old 0.7 programs still own is the takeover's: nothing is written to it, not even the lock.
  if (!readRelease(home) && serveRefusal(home) !== null) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Every command holds the lock shared while it runs, so no rollback can move a database under it. Once held, the
    // newer-data check runs again: a newer release may have moved the home while this one waited.
    holdShared(home);
    recheckOrStop(recheck);
    const r = readRelease(home);
    if (!r || r.version !== core.version || r.state !== "current") {
      // A step to take: let go, take the lock exclusively (it waits for the other commands), then hold it shared again.
      letGoShared();
      const done = withReleaseLock(home, () => (recheckOrStop(recheck), beforeOpenLocked(home, say)));
      if (done === undefined) {
        // Nothing recorded (a home with nothing readable): still run holding the lock shared, checked again.
        holdShared(home);
        recheckOrStop(recheck);
        return undefined;
      }
      continue;
    }
    const recovered = (r.skipped ?? []).filter((rel) => existsSync(join(home, rel)) && readable(join(home, rel), dirname(home)));
    if (!recovered.length) return r; // the usual case: this release serves the home, and nothing waits to be backed up
    // A skipped database can be read now. Back it up if no other command runs; never wait on one (serve holds the
    // lock shared for its whole run, and waiting would block even `parachute stop`): try again at the next command.
    letGoShared();
    try {
      withReleaseLock(home, () => (recheckOrStop(recheck), beforeOpenLocked(home, say)), 1_500);
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

function beforeOpenLocked(home: string, say: (s: string) => void): Release | undefined {
  const was = readRelease(home);
  if (was && was.version === core.version && was.state === "current") return was.skipped?.length ? catchUp(home, was, say) : was;
  if (was?.state === "restoring") {
    throw new Exit(EXIT.failed, `a restore on this home was interrupted; what ${was.version} left is in ${was.moved_aside}. Run \`parachute upgrade --rollback --restore --yes\` again to finish it.`);
  }
  if (serveRefusal(home) !== null) return undefined;
  const since = new Date().toISOString();
  let dbs = databases(home, { hub: 0, vault: 0 });
  // A database that can't be read can't be backed up or judged: it is named, left out of the backup, and left alone
  // by a restore. Every readable one is still backed up first. The command then goes on and fails its own way if it
  // needs the broken one (a vault that can't open stops serve with 75). A home with nothing readable records nothing.
  const unreadable = dbs.filter((d) => !readable(join(home, d.rel), dirname(home))).map((d) => d.rel);
  const all = dbs;
  dbs = dbs.filter((d) => !unreadable.includes(d.rel));
  if (unreadable.length) say(`parachute: can't read ${unreadable.join(", ")}; it is not in any upgrade backup`);
  if (unreadable.length && dbs.length === 0) return undefined;
  if (all.length === 0) {
    const fresh: Release = { version: core.version, previous: was?.version ?? null, since, backup: null, state: "current" };
    writeRelease(home, fresh);
    return fresh;
  }
  // Before 0.9 nothing wrote this record. A home with data and no record was last served by 0.8 (a 0.7 home is the
  // takeover's until it has moved), unless 0.9 made it: a command that created the home found nothing to record
  // before it ran, and left 0.9's own structures (the hub's keys table, the tags' kind column) behind.
  if (!was && madeByThisLine(home, dbs)) {
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current" };
    writeRelease(home, r);
    return r;
  }
  const takeover = readJson(join(home, RECORD_FILE));
  if (!was && takeover?.state === "taken-over" && takeover.version === core.version) {
    // This release's own takeover moved the home from 0.7 minutes ago, with its own whole-home backup: the way
    // back is `parachute takeover --rollback`, not this record's.
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current", via: "takeover" };
    writeRelease(home, r);
    return r;
  }
  const previous = was ? (was.state === "rolled-back" ? (was.previous ?? "0.8") : was.version) : "0.8";
  const backup = join(dirname(home), "parachute-upgrade", `${previous}-to-${core.version}-${stamp()}`);
  say(`parachute: ${previous} → ${core.version} on this home: backing up its databases first, to ${backup}`);
  snapshot(home, backup, previous, unreadable);
  const r: Release = { version: core.version, previous, since, backup, state: "current", ...(unreadable.length ? { skipped: unreadable } : {}) };
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
export function beforeOpenOrExit(home: string, recheck: Recheck = () => null): number | null {
  try {
    beforeOpen(home, undefined, recheck);
    return null;
  } catch (err) {
    if (err instanceof Exit) {
      if (err.message) console.error(`parachute: ${err.message}`);
      return err.code;
    }
    throw err;
  }
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

/** `parachute upgrade --rollback [--restore] [--yes] [--json]`: back to the release before this one. */
export async function rollback(home: string, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const restore = args.includes("--restore");
  const yes = args.includes("--yes") || args.includes("-y");
  const unknown = args.find((a) => !["--rollback", "--restore", "--yes", "-y", "--json"].includes(a));
  const say = (s: string) => (json ? console.error(s) : console.log(s));
  try {
    if (unknown) throw new Exit(EXIT.usage, `unknown argument '${unknown}'\nusage: parachute upgrade --rollback [--restore] [--yes] [--json]`);
    const r = readRelease(home);
    const asked = r ?? undefined;
    if (r?.via === "takeover") throw new Exit(EXIT.failed, "this home came over from 0.7 by the takeover; `parachute takeover --rollback` goes back");
    const resuming = r?.state === "restoring";
    if (resuming && !restore) throw new Exit(EXIT.failed, "a restore on this home was interrupted; finish it with --restore --yes");
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
      const notHeld = () => {
        const held = holders(home);
        if (held.length) {
          throw new Exit(EXIT.held, `something holds the data: ${held.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop Parachute (parachute stop, or its unit), then run this again.`);
        }
      };
      notHeld();
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
        // 2. Export every note that differs from the backup, then check again that nothing has started since.
        const dir = join(r.backup!, `changed-since-${stamp()}`);
        // Always, a resumed restore too: what an interrupted one left (or an older release wrote since) is compared
        // with the backup like the rest, and a database already put back shows no change.
        const left = p.manifest!.skipped ?? [];
        out.exported_notes = exportChanged(home, join(r.backup!, "home"), dir, left);
        out.exported_to = dir;
        say(`Exported ${out.exported_notes} notes changed since the backup to ${dir}`);
        notHeld();
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
      say(`Rolled back. Start ${r.previous} on ${home} now (its own \`parachute serve\`, or its unit). Any ${r.version} command run on it again backs up and moves forward again.`);
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
