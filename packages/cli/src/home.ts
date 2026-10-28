// What every command of parachute-core checks or repairs in the home before it runs (PLAN §3, §5 fixes 3 and 4).
//
//   newerData(home)   the databases a newer Parachute wrote. A command refuses them with exit 6 before it opens
//                     anything, so the home stays byte-identical (fix 4, Benjamin's E7).
//   repairModes(home) folders 0700 and files 0600, put back after a careless copy or restore (fix 3, his E8).
//                     New files get those modes from the umask dispatch sets.
import { Database, constants } from "bun:sqlite";
import { chmodSync, closeSync, constants as fs, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The home a command works on: `PARACHUTE_HOME`, else `~/.parachute` (as the hub and the vault resolve it). */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PARACHUTE_HOME || join(homedir(), ".parachute");
}

/** The databases under a home, with the newest schema this program knows for each. */
export function databases(home: string, known: { hub: number; vault: number }): { rel: string; known: number }[] {
  const out = [{ rel: "hub.db", known: known.hub }];
  const data = join(home, "vault", "data");
  let names: string[] = [];
  try {
    names = readdirSync(data).sort();
  } catch {}
  for (const name of names) out.push({ rel: join("vault", "data", name, "vault.db"), known: known.vault });
  return out.filter((d) => existsSync(join(home, d.rel)));
}

/**
 * The highest `schema_version` a database records, read without changing a byte of the home, or undefined when it
 * has no such table (not ours, or empty). With no WAL beside it the file is opened `immutable`, so SQLite creates
 * no -wal or -shm. A non-empty WAL holds commits the file doesn't, so then it is read through SQLite read-only:
 * the database and WAL are untouched, though SQLite may update the -shm index it keeps beside them.
 */
export function schemaOf(path: string): number | undefined {
  const wal = `${path}-wal`;
  const hasWal = existsSync(wal) && statSync(wal).size > 0;
  const db = hasWal
    ? new Database(path, { readonly: true })
    : new Database(`file:${encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  try {
    const t = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    if (!t) return undefined;
    const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | null;
    return row?.v ?? undefined;
  } finally {
    db.close();
  }
}

/** Every database under the home stamped with a schema newer than this program knows, as plain lines. */
export function newerData(home: string, known: { hub: number; vault: number }): string[] {
  const out: string[] = [];
  for (const d of databases(home, known)) {
    let v: number | undefined;
    try {
      v = schemaOf(join(home, d.rel));
    } catch {
      continue; // not a database we can read: the command that opens it reports that
    }
    if (v !== undefined && v > d.known) out.push(`${d.rel} is at schema ${v}; this program knows up to ${d.known}`);
  }
  return out;
}

/**
 * Put every folder under the home (and the home itself) at 0700 and every file at 0600; returns what it changed.
 * Symlinks are never followed, so a link in the home can't loosen or tighten anything outside it: each entry is
 * opened with O_NOFOLLOW and changed through its descriptor. One we can't open (mode 0000, say) is checked with
 * lstat and changed by path.
 */
export function repairModes(home: string): string[] {
  const changed: string[] = [];
  const set = (rel: string, mode: number, want: number, chmod: () => void) => {
    if ((mode & 0o777) === want) return;
    chmod();
    changed.push(`${rel || "."} ${(mode & 0o777).toString(8)} -> ${want.toString(8)}`);
  };
  /** Fix one entry; true when it is a folder to walk into. */
  const fix = (rel: string): boolean => {
    const path = join(home, rel);
    let fd: number | undefined;
    try {
      fd = openSync(path, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EACCES") return false; // a symlink (ELOOP), or gone
    }
    try {
      const st = fd === undefined ? lstatSync(path) : fstatSync(fd);
      if (!st.isDirectory() && !st.isFile()) return false;
      const want = st.isDirectory() ? 0o700 : 0o600;
      set(rel, st.mode, want, () => (fd === undefined ? chmodSync(path, want) : fchmodSync(fd, want)));
      return st.isDirectory();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const walk = (rel: string) => {
    if (!fix(rel)) return;
    let names: string[] = [];
    try {
      names = readdirSync(join(home, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) walk(rel ? join(rel, name) : name);
  };
  walk("");
  return changed;
}
