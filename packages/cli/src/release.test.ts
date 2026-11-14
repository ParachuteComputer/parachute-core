// What `upgrade --rollback --restore` carries from the hub.db that came after the backup into the backup's copy
// (release.ts keepRevocations): putting a backup back must never make something revoked since work again. The
// databases here are made up, with only the columns the rule reads; the tokens' part runs through the real hub and
// the real 0.8 in the contract (lifecycle/upgrade "rollback --restore").
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepRevocations, SourceUnusable, type NotCarried } from "./release.ts";

const dir = mkdtempSync(join(tmpdir(), "keep-revocations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const FAR = "2999-01-01T00:00:00.000Z";

/** A made-up hub.db as it was at the backup: one signing key, two accounts, a sign-in key each, a session, a token. */
function hub(name: string, kid = "kid-1"): { path: string; db: Database } {
  const path = join(dir, `${name}.db`);
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE signing_keys (kid TEXT PRIMARY KEY, retired_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT);
    CREATE TABLE user_vaults (user_id TEXT, vault_name TEXT, role TEXT);
    CREATE TABLE user_pubkeys (pubkey TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT);
    CREATE TABLE tokens (jti TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, revoked_at TEXT);
  `);
  db.run("INSERT INTO signing_keys VALUES (?, NULL)", [kid]);
  db.run("INSERT INTO users VALUES ('u1', 'owner', 'admin', 'hash-1'), ('u2', 'helper', 'admin', 'hash-2')");
  db.run("INSERT INTO user_vaults VALUES ('u2', 'garden', 'write')");
  db.run("INSERT INTO user_pubkeys VALUES ('pk-owner', 'u1'), ('pk-helper', 'u2')");
  db.run("INSERT INTO sessions VALUES ('s-owner', 'u1', ?), ('s-helper', 'u2', ?)", [FAR, FAR]);
  db.run("INSERT INTO tokens VALUES ('t-old', 'u1', ?, NULL)", [FAR]);
  return { path, db };
}

describe("restore: what was revoked since the backup stays revoked", () => {
  test("a sign-in key unlinked, a session ended and a password changed since are carried; what comes back is named", () => {
    const staged = hub("staged");
    staged.db.close();
    const live = hub("live");
    live.db.run("DELETE FROM user_pubkeys WHERE pubkey = 'pk-helper'"); // unlinked since
    live.db.run("DELETE FROM sessions WHERE id = 's-helper'"); // signed out since
    live.db.run("UPDATE users SET password_hash = 'hash-1b' WHERE id = 'u1'"); // password changed since
    live.db.run("UPDATE users SET role = 'member' WHERE id = 'u2'"); // demoted since: not undone, but said
    live.db.run("INSERT INTO tokens VALUES ('t-new', 'u1', ?, NULL)", [FAR]); // minted since, still live
    live.db.close();
    const notCarried: NotCarried = { accounts_back: [], access_changed: [] };
    const kept = keepRevocations(staged.path, [live.path], dir, notCarried);
    expect(kept).toMatchObject({ pubkeys: 1, sessions: 1, sign_ins: 1, made_since: 1 });
    const db = new Database(staged.path, { readonly: true });
    expect(db.query("SELECT pubkey FROM user_pubkeys").all()).toEqual([{ pubkey: "pk-owner" }]);
    expect(db.query("SELECT id FROM sessions").all()).toEqual([{ id: "s-owner" }]);
    expect(db.query("SELECT password_hash FROM users WHERE id = 'u1'").get()).toEqual({ password_hash: "hash-1b" });
    expect((db.query("SELECT revoked_at FROM tokens WHERE jti = 't-new'").get() as any).revoked_at).toBeTruthy();
    expect((db.query("SELECT revoked_at FROM tokens WHERE jti = 't-old'").get() as any).revoked_at).toBeNull();
    db.close();
    expect(notCarried).toEqual({ accounts_back: [], access_changed: ["helper"] });
  });

  test("an account deleted since comes back, and is named", () => {
    const staged = hub("staged2");
    staged.db.close();
    const live = hub("live2");
    live.db.run("DELETE FROM users WHERE id = 'u2'");
    live.db.close();
    const notCarried: NotCarried = { accounts_back: [], access_changed: [] };
    keepRevocations(staged.path, [live.path], dir, notCarried);
    expect(notCarried.accounts_back).toEqual(["helper"]);
  });

  test("a later hub.db that can't be read, or isn't this hub, stops the restore: it can't say what was revoked", () => {
    const staged = hub("staged3");
    staged.db.close();
    const broken = join(dir, "broken.db");
    writeFileSync(broken, "Made-up bytes that are not a database.\n".repeat(200));
    expect(() => keepRevocations(staged.path, [broken], dir)).toThrow(SourceUnusable);
    const other = hub("other", "kid-of-another-hub");
    other.db.close();
    expect(() => keepRevocations(staged.path, [other.path], dir)).toThrow(SourceUnusable);
    // And nothing was written to the staged copy on the way.
    const db = new Database(staged.path, { readonly: true });
    expect((db.query("SELECT count(*) AS n FROM user_pubkeys").get() as any).n).toBe(2);
    db.close();
  });
});
