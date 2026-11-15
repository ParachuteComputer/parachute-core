// An exclusive lock on a small SQLite file, held until the returned connection closes (or the process ends, however
// it ends). The release lock (release.ts) and the keys lock (keys.ts) both use it.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";

/** One `keys new` at a time per home (keys.ts holdKeysLock). */
export const KEYS_LOCK = join("run", "keys.lock");

/**
 * Take the lock on `path`, waiting up to `waitMs` for whoever holds it; throws SQLite's SQLITE_BUSY ("database is
 * locked") when the wait runs out (isLockBusy). The lock is a transaction left open: BEGIN EXCLUSIVE takes it, closing the
 * connection lets it go. Not `locking_mode = EXCLUSIVE`: in that mode a BEGIN that is waiting keeps the read lock it
 * took on the way, so two takers at once each wait for the other until both time out (file-lock.test.ts).
 */
export function takeFileLock(path: string, waitMs: number): Database {
  const db = new Database(path, { create: true });
  try {
    chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout = ${waitMs}`);
    db.exec("BEGIN EXCLUSIVE"); // locks an empty file too: the lock is the file's, not a table's
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** The lock is held by someone else (the wait ran out), as opposed to any other failure to open or lock the file. */
export function isLockBusy(err: unknown): boolean {
  return String((err as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY");
}
