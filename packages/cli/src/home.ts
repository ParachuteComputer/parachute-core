// What every command of parachute-core checks or repairs in the home before it runs (PLAN §3, §5 fixes 3 and 4).
//
//   newerData(home)   the databases a newer Parachute wrote. A command refuses them with exit 6 before it opens
//                     anything, so the home stays byte-identical (fix 4, Benjamin's E7).
//   repairModes(home) folders 0700 and files 0600, put back after a careless copy or restore (fix 3, his E8).
//                     New files get those modes from the umask dispatch sets.
import { Database, constants } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fs,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The home a command works on: `PARACHUTE_HOME`, else `~/.parachute` (as the hub and the vault resolve it). */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PARACHUTE_HOME || join(homedir(), ".parachute");
}

/**
 * Where vaults live: today's `vault/data/<name>/`, and the two older layouts the vault moves on open
 * (vault src/config.ts migrateFromLegacyLayout: `vaults/<name>/`; migrateVaultInternalLayout: `vault/vaults/<name>/`).
 * A newer database in an old layout must be refused before that move.
 */
const VAULT_FOLDERS = [join("vault", "data"), "vaults", join("vault", "vaults")];

/** The databases under a home, with the newest schema this program knows for each. */
export function databases(home: string, known: { hub: number; vault: number }): { rel: string; known: number }[] {
  const out = [{ rel: "hub.db", known: known.hub }];
  for (const folder of VAULT_FOLDERS) {
    let names: string[] = [];
    try {
      names = readdirSync(join(home, folder)).sort();
    } catch {}
    for (const name of names) out.push({ rel: join(folder, name, "vault.db"), known: known.vault });
  }
  return out.filter((d) => existsSync(join(home, d.rel)));
}

/** A database opened `immutable`: read-only, and SQLite makes no -wal or -shm beside it. */
function openImmutable(path: string): Database {
  const uri = encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23");
  return new Database(`file:${uri}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

function topVersion(db: Database): number | undefined {
  try {
    const t = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    if (!t) return undefined;
    const row = db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | null;
    return row?.v ?? undefined;
  } finally {
    db.close();
  }
}

/** Above this, a database on another filesystem from every scratch folder is not copied (and not checked). */
const COPY_LIMIT = 256 * 1024 * 1024;

/** A database with a WAL that can't be read without changing the home: no scratch folder would take it. */
export class UncheckedError extends Error {}

/**
 * The highest `schema_version` a database records, or undefined when it has no such table (not ours, or empty).
 * It never changes a byte under the home:
 *   - with no WAL beside it, the file is opened `immutable`;
 *   - a non-empty WAL (a crash, a running server, or a CLI that exited without closing) holds commits the file
 *     doesn't, and SQLite reading a WAL rewrites its -shm index, creating it if need be. So the database is read in
 *     a scratch folder outside the home, by hard link (or a copy, up to COPY_LIMIT; on macOS only a copy) with a
 *     copy of the WAL.
 *     `outside` is tried first (the home's parent, usually the same filesystem), then the system's temp folder.
 *     If none works (no writable place, or too big to copy across filesystems), it throws UncheckedError: it never
 *     reads a WAL in place.
 */
export function schemaOf(path: string, outside: string = tmpdir()): number | undefined {
  const wal = `${path}-wal`;
  if (!(existsSync(wal) && statSync(wal).size > 0)) return topVersion(openImmutable(path));
  const places = [...new Set([outside, tmpdir()])];
  // Never a hard link on macOS: a second process opening the live file through a link, while serve has it open,
  // makes serve's SQLite fail with a disk I/O error there (seen on macos-14, lane D's bundle-macos job; Linux is
  // fine). So on macOS the database is copied, up to COPY_LIMIT, and a larger one with a WAL is not checked.
  for (const copy of process.platform === "darwin" ? [true] : [false, true]) {
    if (copy && statSync(path).size > COPY_LIMIT) break;
    for (const place of places) {
      let scratch: string | undefined;
      try {
        scratch = mkdtempSync(join(place, ".parachute-schema-check-"));
        const db = join(scratch, "db");
        if (copy) copyFileSync(path, db);
        else linkSync(path, db);
        copyFileSync(wal, `${db}-wal`);
        return topVersion(new Database(db, { readonly: true }));
      } catch (e) {
        if (e instanceof Error && e.name === "SQLiteError") throw e;
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  throw new UncheckedError(`${path} has a WAL and no scratch folder could take a copy of it`);
}

/**
 * Every database under the home stamped with a schema newer than this program knows (`newer`), and every one that
 * can't be read without changing the home (`unchecked`), as plain lines.
 */
export function newerData(home: string, known: { hub: number; vault: number }): { newer: string[]; unchecked: string[] } {
  const newer: string[] = [];
  const unchecked: string[] = [];
  for (const d of databases(home, known)) {
    let v: number | undefined;
    try {
      v = schemaOf(join(home, d.rel), dirname(home));
    } catch (e) {
      if (e instanceof UncheckedError) unchecked.push(`${d.rel} has a WAL that no scratch folder outside the home could take`);
      continue; // otherwise not a database we can read: the command that opens it reports that
    }
    if (v !== undefined && v > d.known) newer.push(`${d.rel} is at schema ${v}; this program knows up to ${d.known}`);
  }
  return { newer, unchecked };
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
