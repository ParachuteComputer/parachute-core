// Managed by the host (v0.8 PLAN §3): while `serve --embedded` holds a home, the host application manages
// Parachute there, so nothing else may start, install, upgrade, expose, migrate or (re)start parts of it. A second
// vault on the same vault.db is the failure Benjamin's suite would otherwise cause (prism run.mjs:402-405).
//
// The hold is an exclusive SQLite lock on `$PARACHUTE_HOME/run/serve.hold`, kept for as long as the embedded
// serve runs. The operating system releases it when that process ends, however it ends (a SIGKILL included), so
// there is no stale hold to recover and no window in which two serves both hold the home. `run/serve.lock` names
// the holder's pid, for messages and for the vault child's pass; it never decides who holds.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HOLD_FILE = join("run", "serve.hold");
export const LOCK_FILE = join("run", "serve.lock");

/** The hub commands refused while a home is held: they install, upgrade, expose, migrate or drive modules. */
export const REFUSED_HUB = new Set(["init", "install", "uninstall", "upgrade", "expose", "migrate", "start", "stop", "restart", "serve"]);
/** The vault commands refused: a second vault server, or the ones that stop, restart or (un)register it. */
export const REFUSED_VAULT = new Set(["init", "serve", "stop", "restart", "uninstall"]);

/** The home a command acts on: PARACHUTE_HOME, else ~/.parachute (as the hub's and vault's config do). */
export function commandHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PARACHUTE_HOME || join(homedir(), ".parachute"));
}

const busy = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "SQLITE_BUSY" || e?.code === "SQLITE_LOCKED" || /database is locked/i.test(e?.message ?? "");
};

function lockPid(home: string): number | undefined {
  try {
    const pid = JSON.parse(readFileSync(join(home, LOCK_FILE), "utf8"))?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who holds `home`: undefined when nobody does; else the holder's pid, or "unknown" in the instant between taking
 * the hold and naming itself.
 */
export function embeddedHolder(home: string): number | "unknown" | undefined {
  const path = join(home, HOLD_FILE);
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 0");
    db.query("SELECT count(*) FROM sqlite_master").get();
    return undefined; // we could read it, so nobody holds it
  } catch (err) {
    return busy(err) ? (lockPid(home) ?? "unknown") : undefined;
  } finally {
    db?.close();
  }
}

/** A live process that is a `serve --embedded` (where the process table says what a pid runs, i.e. Linux). */
function liveEmbedded(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const cmdline = `/proc/${pid}/cmdline`;
  if (!existsSync(cmdline)) return true;
  try {
    return readFileSync(cmdline, "utf8").split("\0").includes("--embedded");
  } catch {
    return true;
  }
}

/**
 * Take the hold on `home` for this process, exclusively: of several serves starting at once, one gets it and the
 * others learn who has it. SQLite may answer "busy" at once when several connections race for the lock (its
 * deadlock avoidance skips the wait), so "busy" only means "held" once a live embedded serve names itself in
 * run/serve.lock; until then, and for up to 10 s, it tries again. Throws on a filesystem error (an unusable home).
 */
export function acquireHold(home: string): { release(): void } | { holder: number | "unknown" } {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const path = join(home, HOLD_FILE);
  const deadline = Date.now() + 10_000;
  let db: Database;
  for (;;) {
    db = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout = 250");
      // In exclusive locking mode the connection keeps its lock until it closes; the write takes it.
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS hold (pid INTEGER)");
      db.exec("DELETE FROM hold");
      db.query("INSERT INTO hold (pid) VALUES (?)").run(process.pid);
      db.exec("COMMIT");
      break;
    } catch (err) {
      db.close();
      if (!busy(err)) throw err;
      const pid = lockPid(home);
      if (pid !== undefined && pid !== process.pid && liveEmbedded(pid)) return { holder: pid };
      if (Date.now() > deadline) return { holder: pid ?? "unknown" };
      Bun.sleepSync(50 + Math.floor(Math.random() * 100));
    }
  }
  const lock = join(home, LOCK_FILE);
  const tmp = `${lock}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(tmp, lock);
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    release() {
      try {
        if (lockPid(home) === process.pid) rmSync(lock, { force: true });
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Whether `parachute <args>` (role hub) or `parachute-vault <args>` (role vault) must be refused because a host
 * holds the home. The embedded serve's own vault child is let through: it names its parent in
 * PARACHUTE_EMBEDDED_PARENT, and that parent is the holder.
 */
export function managedRefusal(role: "hub" | "vault", args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cmd = args[0];
  if (!cmd) return undefined;
  const refused = role === "vault" ? REFUSED_VAULT : REFUSED_HUB;
  if (!refused.has(cmd)) return undefined;
  if (role === "hub" && cmd === "serve" && args.includes("--embedded")) return undefined; // embedded.ts decides
  const home = commandHome(env);
  const holder = embeddedHolder(home);
  if (holder === undefined) return undefined;
  if (role === "vault" && cmd === "serve" && env.PARACHUTE_EMBEDDED_PARENT === String(holder) && process.ppid === holder) return undefined;
  const name = role === "vault" ? "parachute-vault" : "parachute";
  return `${name} ${cmd}: managed_by_host: ${home} is managed by its host application (serve --embedded, pid ${holder}); this command is refused`;
}
