/**
 * Sharing a vault with a friend (T-476; app docs/design/SHARING.md, core docs/SPEC-1.0-grants.md §5.1).
 *
 * The owner invites someone to one vault by name; the friend accepts with their own Nostr key and becomes a `member`
 * there (read and write, never admin). The owner's side is the account MCP's tools (`invite-to-vault`,
 * `take-back-invite`, and `list-access`, which names people and lists open invites), under the same gate as
 * `grant-access` (`callerCanAdminVault`): the owner's key (NIP-98), or a credential with admin on that vault. A
 * vault token or a named key never has admin, so it can't invite. The friend's side is two plain routes
 * (api-share-invites.ts): `look` reads an invite without using it, `accept` (NIP-98 by the friend's key) uses it.
 *
 * An invite is a row of `share_invites` (hub-db.ts `ensureSharing`): single use, 7 days, its code shown once and kept
 * as a hash. It is not a row of `invites`, so the password page and `/api/invites` (and an older hub's) never see one.
 *
 * Names are shown, never checked: the invite's `invitee_name` is the friend's name on that vault, and the owner's
 * `users.display_name` is theirs. Authority comes only from the key and the `user_vaults` role.
 *
 * At 1.0 accept records the friend's key and the owner's shell signs a `by self` grant (spec §5.1); the role row this
 * files today is what spec §10 converts to a door grant at the upgrade.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  type GrantCaller,
  GrantError,
  callerCanAdminVault,
  ensureUserForPubkey,
  parseGrantVault,
} from "./grant-access.ts";
import { DEFAULT_INVITE_TTL_SECONDS, hashInviteToken } from "./invites.ts";
import { levelSatisfies, personLevelOnVault } from "./key-level.ts";
import { deleteUser, isHubAdmin, upsertUserVault } from "./users.ts";

/** The role a share invite gives: read and write, no admin (users.ts `vaultVerbsForRole`). */
export const SHARE_ROLE = "member";
const CODE_BYTES = 32;
/** A name as people read it: 1 to 40 characters once trimmed. */
export const NAME_MAX = 40;
/** The most stamps one `names` read answers. */
export const NAMES_MAX = 100;
/** Controls, and the formatting characters that make one name look like another (bidi, zero-width, line breaks); the
 *  joiners (U+200C, U+200D) stay, since Persian names and emoji sequences need them. */
const UNSEEN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A person's name, checked: trimmed, 1 to 40 code points, no control or invisible formatting characters. */
export function parseName(raw: unknown, field: string): string {
  if (typeof raw !== "string") throw new GrantError("invalid_name", `${field} must be a name.`);
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  const len = [...name].length;
  if (len < 1 || len > NAME_MAX || UNSEEN.test(name)) {
    throw new GrantError(
      "invalid_name",
      `${field} must be 1 to ${NAME_MAX} characters, with no control characters.`,
    );
  }
  if (/^you$/i.test(name)) throw new GrantError("invalid_name", `${field} can't be "You".`);
  return name;
}

interface ShareRow {
  id: string;
  vault_name: string;
  invitee_name: string;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
  redeemed_user_id: string | null;
  revoked_at: string | null;
}

/** A person's name on this hub, or null. */
export function displayName(db: Database, userId: string | null): string | null {
  if (!userId) return null;
  const row = db
    .query<{ display_name: string | null }, [string]>("SELECT display_name FROM users WHERE id = ?")
    .get(userId);
  return row?.display_name ?? null;
}

export interface InviteResult {
  /** The invite's id (the code's hash): what `take-back-invite` names. */
  id: string;
  vault: string;
  name: string;
  /** The code, shown this once. The link is `<hub>/invite#<code>`. */
  code: string;
  url: string;
  expires_at: string;
}

/** `invite-to-vault`: a single-use share invite for `name` to `vault`; `from` (optional) sets the caller's own name. */
export function inviteToVault(
  db: Database,
  caller: GrantCaller,
  args: Record<string, unknown>,
  installed: ReadonlySet<string>,
  issuer: string,
  now: () => Date = () => new Date(),
): InviteResult {
  const vault = parseGrantVault(args.vault);
  if (!installed.has(vault)) {
    throw new GrantError("vault_not_installed", `Vault "${vault}" is not installed on this hub.`);
  }
  if (!callerCanAdminVault(db, caller, vault)) {
    throw new GrantError("grant_not_permitted", `You cannot invite people to vault "${vault}".`);
  }
  const name = parseName(args.name, "name");
  const from =
    args.from === undefined || args.from === null || args.from === ""
      ? null
      : parseName(args.from, "from");
  const code = randomBytes(CODE_BYTES).toString("base64url");
  const id = hashInviteToken(code);
  const at = now();
  const expiresAt = new Date(at.getTime() + DEFAULT_INVITE_TTL_SECONDS * 1000).toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO share_invites (id, vault_name, invitee_name, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, vault, name, caller.userId, expiresAt, at.toISOString());
    if (from !== null)
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(from, caller.userId);
  })();
  console.log(
    `vault invite made: vault=${vault} id=${id.slice(0, 12)} actor_user_id=${caller.userId} actor_pubkey=${caller.pubkey ?? ""}`,
  );
  return {
    id,
    vault,
    name,
    code,
    url: `${issuer.replace(/\/+$/, "")}/invite#${code}`,
    expires_at: expiresAt,
  };
}

/** `take-back-invite`: ends an open share invite to `vault`. False when it was already used, taken back or gone. */
export function takeBackInvite(
  db: Database,
  caller: GrantCaller,
  args: Record<string, unknown>,
  installed: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): { id: string; vault: string; taken_back: boolean } {
  const vault = parseGrantVault(args.vault);
  if (!installed.has(vault)) {
    throw new GrantError("vault_not_installed", `Vault "${vault}" is not installed on this hub.`);
  }
  if (!callerCanAdminVault(db, caller, vault)) {
    throw new GrantError(
      "grant_not_permitted",
      `You cannot take back invites to vault "${vault}".`,
    );
  }
  const id = typeof args.id === "string" && /^[0-9a-f]{64}$/.test(args.id) ? args.id : null;
  if (!id) throw new GrantError("invalid_id", "id must be an invite's id.");
  const res = db
    .prepare(
      `UPDATE share_invites SET revoked_at = ?
       WHERE id = ? AND vault_name = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(now().toISOString(), id, vault);
  return { id, vault, taken_back: res.changes > 0 };
}

/** The open share invites to one vault, for its owner's list. */
export function openInvites(
  db: Database,
  vault: string,
  now: Date = new Date(),
): { id: string; name: string; expires_at: string }[] {
  return db
    .query<ShareRow, [string, string]>(
      `SELECT * FROM share_invites
       WHERE vault_name = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(vault, now.toISOString())
    .map((r) => ({ id: r.id, name: r.invitee_name, expires_at: r.expires_at }));
}

/** A person's name on one vault: the name the invite they accepted gave them there, else their name on this hub. */
export function nameOnVault(db: Database, userId: string, vault: string): string | null {
  const invited = db
    .query<{ invitee_name: string }, [string, string]>(
      `SELECT invitee_name FROM share_invites
       WHERE redeemed_user_id = ? AND vault_name = ?
       ORDER BY used_at DESC LIMIT 1`,
    )
    .get(userId, vault);
  return invited?.invitee_name ?? displayName(db, userId);
}

/** Can this hub user still run `vault` (admin there: the hub's owner, or a `write` role)? */
function runsVault(db: Database, userId: string | null, vault: string): boolean {
  if (!userId) return false;
  const person = {
    userId,
    isHubAdmin: isHubAdmin(db, userId),
    authKind: "nostr" as const,
    grant: null,
  };
  return levelSatisfies(personLevelOnVault(db, person, vault), "admin");
}

/** An open share invite by its code, or null (every failure the same, so a stranger learns nothing). An invite holds
 *  only while the person who made it can still run the vault: taking their role away takes their invites with it. */
function openShareInvite(db: Database, code: unknown, now: Date): ShareRow | null {
  if (
    typeof code !== "string" ||
    code.length < 16 ||
    code.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(code)
  )
    return null;
  const row = db
    .query<ShareRow, [string]>("SELECT * FROM share_invites WHERE id = ?")
    .get(hashInviteToken(code));
  if (!row || row.revoked_at || row.used_at) return null;
  if (now.getTime() > new Date(row.expires_at).getTime()) return null;
  if (!runsVault(db, row.created_by, row.vault_name)) return null;
  return row;
}

export interface InviteView {
  vault: string;
  /** Who invited you, as they named themselves; null when they gave no name. */
  from: string | null;
  /** The name the invite gives you there. */
  name: string;
  /** What you may do there: read and change everything (a `member`). */
  can: "read and write";
  expires_at: string;
}

/** `look`: what an invite is, without using it. Null for every failure. */
export function lookInvite(db: Database, code: unknown, now: Date = new Date()): InviteView | null {
  const row = openShareInvite(db, code, now);
  if (!row) return null;
  return {
    vault: row.vault_name,
    from: displayName(db, row.created_by),
    name: row.invitee_name,
    can: "read and write",
    expires_at: row.expires_at,
  };
}

export type AcceptOutcome = { ok: true; view: InviteView; user_id: string } | { ok: false };

/**
 * `accept`, by the key that signed the request (verified by the caller): the code is checked first; then the key's
 * hub user is found or made (`ensureUserForPubkey`, as `grant-access` does); then, in one transaction, the role is
 * filed and the invite used, guarded so two accepts can't both win. A key that is a hub admin, or already reaches the
 * vault, is refused and the invite stays open. Every refusal is `{ok: false}`.
 */
export async function acceptInvite(
  db: Database,
  pubkey: string,
  code: unknown,
  installed: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): Promise<AcceptOutcome> {
  const row = openShareInvite(db, code, now());
  // a vault taken away or renamed since: the invite opens nothing
  if (!row || !installed.has(row.vault_name)) return { ok: false };
  let userId: string;
  let created: boolean;
  try {
    ({ userId, created } = await ensureUserForPubkey(db, pubkey, now, { label: "invite" }));
  } catch {
    return { ok: false };
  }
  // a key-only user made for this accept and then refused (another accept won meanwhile) isn't left behind
  const refused = (): AcceptOutcome => {
    if (created) deleteUser(db, userId);
    return { ok: false };
  };
  if (isHubAdmin(db, userId)) return refused();
  // checked again after the await: another accept may have used it meanwhile
  const view = lookInvite(db, code, now());
  if (!view) return refused();
  const filed = db.transaction((): boolean => {
    const already = db
      .query<{ role: string }, [string, string]>(
        "SELECT role FROM user_vaults WHERE user_id = ? AND vault_name = ?",
      )
      .get(userId, row.vault_name);
    if (already) return false;
    const used = db
      .prepare(
        `UPDATE share_invites SET used_at = ?, redeemed_user_id = ?
         WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now().toISOString(), userId, row.id);
    if (used.changes === 0) return false;
    const attribution = {
      grantedByUserId: row.created_by,
      grantedByPubkey: null,
      grantedVia: "invite" as const,
    };
    if (!upsertUserVault(db, userId, row.vault_name, SHARE_ROLE, now, attribution)) {
      throw new Error("the role wasn't filed");
    }
    return true;
  })();
  if (!filed) return refused();
  console.log(
    `vault invite accepted: vault=${row.vault_name} id=${row.id.slice(0, 12)} subject_user_id=${userId} subject_pubkey=${pubkey}`,
  );
  return { ok: true, view, user_id: userId };
}

/** A vault renamed: its invites, open and used, follow it (so names and Take back keep working). */
export function renameShareInvitesForVault(db: Database, oldName: string, newName: string): number {
  return db
    .prepare("UPDATE share_invites SET vault_name = ? WHERE vault_name = ?")
    .run(newName, oldName).changes;
}

/** A vault deleted: its invites go, open and used, so a new vault of the same name inherits no invite and no names. */
export function removeShareInvitesForVault(db: Database, vault: string): number {
  return db.prepare("DELETE FROM share_invites WHERE vault_name = ?").run(vault).changes;
}

/** Every person of `vault`: its hub owners, everyone with a role there, everyone who ever accepted an invite to it. */
function peopleOf(db: Database, vault: string): string[] {
  const rows = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM users WHERE hub_role = 'admin'
       UNION SELECT user_id AS id FROM user_vaults WHERE vault_name = ?
       UNION SELECT redeemed_user_id AS id FROM share_invites WHERE vault_name = ? AND redeemed_user_id IS NOT NULL`,
    )
    .all(vault, vault);
  return rows.map((r) => r.id).slice(0, NAMES_MAX);
}

/** Does this hub user reach `vault` (owner, or any role there)? */
export function reachesVault(db: Database, userId: string, vault: string): boolean {
  const caller = {
    userId,
    isHubAdmin: isHubAdmin(db, userId),
    authKind: "nostr" as const,
    grant: null,
  };
  return personLevelOnVault(db, caller, vault) !== null;
}

/**
 * `names`: the name for each `by` stamp asked about (none asked: every person), among the people of `vault` (its owners and members, and anyone
 * who ever accepted an invite to it, so an ended member's old writes keep their name), with `you` on the caller's own.
 * A stamp that isn't such a person is left out. Keys, roles and invites are never here: they are the owner's.
 */
export function namesFor(
  db: Database,
  vault: string,
  callerUserId: string,
  stamps: readonly string[],
): Record<string, { name: string | null; you: boolean }> {
  const out: Record<string, { name: string | null; you: boolean }> = {};
  for (const by of [...new Set(stamps.length ? stamps : peopleOf(db, vault))].slice(0, NAMES_MAX)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(by)) continue;
    const exists = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(by);
    if (!exists) continue;
    const accepted = db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM share_invites WHERE redeemed_user_id = ? AND vault_name = ? LIMIT 1",
      )
      .get(by, vault);
    if (!reachesVault(db, by, vault) && accepted === null) continue;
    out[by] = { name: nameOnVault(db, by, vault), you: by === callerUserId };
  }
  return out;
}
