/**
 * Keys with scopes (T-318 design §2, revision 5): the groundwork.
 *
 * A key belongs to someone (a person, an agent or an app) and carries scopes:
 * what it may do (read, write, admin) on which vault, optionally narrowed to
 * types, plus explicit denies. Every way a token is made today becomes a key
 * with the same scopes, and nothing about how a token verifies changes: a key
 * row only names, owns and describes a row of the `tokens` registry, which
 * stays the one source of truth for signature, expiry and revocation.
 *
 * What this lands (0.9.1 groundwork): the `keys` table (hub.db v25), the
 * migration that adopts every live token as a key, a key for every new mint
 * (`recordTokenMint`), and one key per OAuth refresh family that follows it
 * through rotation (`signRefreshToken`). Scopes and tag scope are read live
 * from the token row, never copied. Not yet: minting by key name
 * (`parachute keys new`), type scopes and denies being enforced (the columns
 * exist, empty), and faces.
 */
import type { Database } from "bun:sqlite";

export type KeyOwnerKind = "person" | "agent" | "app" | "service";

export interface KeyRow {
  name: string;
  jti: string;
  owner: string | null;
  owner_kind: KeyOwnerKind;
  /** Type scope (§8a). Empty until 0.9.1 mints scope by type; the vault knows which tags are types. */
  types: string | null;
  denies: string | null;
  created_via: string | null;
  created_at: string;
}

export interface KeyView {
  name: string;
  owner: string | null;
  owner_kind: KeyOwnerKind;
  /** The token's scopes, read live from the registry. */
  scopes: string[];
  /** Per vault, the highest level the scopes grant: `{uni: "write"}`. */
  levels: Record<string, "read" | "write" | "admin">;
  /** Today's tag scope (`permissions.scoped_tags`) as an explicit allow list, read live: it behaves exactly as today. */
  allow_tags: string[] | null;
  types: string[] | null;
  denies: string[] | null;
  status: "active" | "revoked" | "expired";
  created_via: string | null;
  created_at: string;
  expires_at: string | null;
}

interface TokenRow {
  jti: string;
  family_id: string | null;
  user_id: string | null;
  client_id: string | null;
  scopes: string;
  permissions: string | null;
  created_via: string | null;
  subject: string | null;
  created_at: string;
  username: string | null;
}

const AGENT_VIA = new Set(["agent_grant", "connection_provision", "connection_credential"]);
const LEVEL_RANK = { read: 0, write: 1, admin: 2 } as const;

/** Who a token's key belongs to, by how the token was made. */
export function ownerOf(t: Pick<TokenRow, "user_id" | "client_id" | "created_via" | "subject">): { owner: string | null; owner_kind: KeyOwnerKind } {
  if (t.created_via && AGENT_VIA.has(t.created_via)) return { owner: t.user_id ?? null, owner_kind: "agent" };
  if (t.created_via === "oauth_refresh" || (t.client_id && t.client_id !== "api-mint-token" && !t.subject)) {
    return { owner: t.user_id ?? null, owner_kind: "app" };
  }
  if (t.user_id) return { owner: t.user_id, owner_kind: "person" };
  return { owner: t.subject ?? null, owner_kind: "service" };
}

/** A key's name: its label (the token's subject when that is not a user id), its app, or its owner, made unique. */
function baseName(t: TokenRow): string {
  const label = t.subject && t.subject !== t.user_id ? t.subject : null;
  // An app is named for itself; anything else for its label, else its person.
  const raw = (t.created_via === "oauth_refresh" ? t.client_id : null) ?? label ?? t.username ?? t.client_id ?? t.created_via ?? "key";
  const slug = raw.trim().replace(/\s+/g, "-").slice(0, 80);
  return slug || "key";
}

function uniqueName(db: Database, base: string): string {
  const taken = db.prepare("SELECT 1 FROM keys WHERE name = ?");
  if (!taken.get(base)) return base;
  for (let i = 2; ; i++) if (!taken.get(`${base}-${i}`)) return `${base}-${i}`;
}

function allowTags(permissions: string | null): string | null {
  if (!permissions) return null;
  try {
    const tags = (JSON.parse(permissions) as { scoped_tags?: unknown }).scoped_tags;
    return Array.isArray(tags) && tags.length ? JSON.stringify(tags.map(String)) : null;
  } catch {
    return null;
  }
}

const TOKEN_SELECT = `SELECT t.jti, t.family_id, t.user_id, t.client_id, t.scopes, t.permissions, t.created_via, t.subject, t.created_at, u.username
  FROM tokens t LEFT JOIN users u ON u.id = t.user_id`;

function insertKey(db: Database, t: TokenRow): string {
  const name = uniqueName(db, baseName(t));
  const { owner, owner_kind } = ownerOf(t);
  db.prepare(
    `INSERT INTO keys (name, jti, owner, owner_kind, types, denies, created_via, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(name, t.jti, owner, owner_kind, t.created_via, t.created_at);
  return name;
}

/**
 * An app's refresh token: one key per refresh family. A rotation moves the
 * family's key onto the new token row instead of making a key per rotation.
 */
export function adoptRefreshToken(db: Database, jti: string, familyId: string): string | null {
  const key = db
    .prepare(`SELECT k.name FROM keys k JOIN tokens t ON t.jti = k.jti WHERE t.family_id = ? AND k.jti != ?`)
    .get(familyId, jti) as { name: string } | null;
  if (!key) return adoptToken(db, jti);
  db.prepare("UPDATE keys SET jti = ? WHERE name = ?").run(jti, key.name);
  return key.name;
}

/** Give the token `jti` its key, if it hasn't one. Returns the key's name. */
export function adoptToken(db: Database, jti: string): string | null {
  const existing = db.prepare("SELECT name FROM keys WHERE jti = ?").get(jti) as { name: string } | null;
  if (existing) return existing.name;
  const t = db.prepare(`${TOKEN_SELECT} WHERE t.jti = ?`).get(jti) as TokenRow | null;
  return t ? insertKey(db, t) : null;
}

/**
 * The migration (§2 "every existing token becomes a key with the same
 * scopes"): each unrevoked, unexpired, current registry row gets a key. A
 * refresh token already rotated away is history, not a key. Idempotent.
 */
/** Whether any live token has no key yet: what adoptLiveTokens would adopt (a read only). */
export function hasTokensToAdopt(db: Database, now: Date = new Date()): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM tokens t
       WHERE t.revoked_at IS NULL AND t.rotated_to IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)
         AND NOT EXISTS (SELECT 1 FROM keys k WHERE k.jti = t.jti) LIMIT 1`,
    )
    .get(now.toISOString());
}

export function adoptLiveTokens(db: Database, now: Date = new Date()): number {
  const rows = db
    .prepare(
      `${TOKEN_SELECT}
       WHERE t.revoked_at IS NULL AND t.rotated_to IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)
         AND NOT EXISTS (SELECT 1 FROM keys k WHERE k.jti = t.jti)
       ORDER BY t.created_at, t.jti`,
    )
    .all(now.toISOString()) as TokenRow[];
  // A refresh family keeps its one key: if an older hub rotated it, the key moves onto the new row.
  for (const t of rows) {
    if (t.family_id) adoptRefreshToken(db, t.jti, t.family_id);
    else insertKey(db, t);
  }
  return rows.length;
}

/** Every key, with its token's status. */
export function listKeys(db: Database, now: Date = new Date()): KeyView[] {
  const rows = db
    .prepare(
      `SELECT k.*, t.scopes, t.permissions, t.revoked_at, t.expires_at FROM keys k JOIN tokens t ON t.jti = k.jti ORDER BY k.created_at, k.name`,
    )
    .all() as (KeyRow & { scopes: string | null; permissions: string | null; revoked_at: string | null; expires_at: string | null })[];
  const list = (v: string | null) => (v ? (JSON.parse(v) as string[]) : null);
  return rows.map((r) => {
    const scopes = (r.scopes ?? "").split(/\s+/).filter(Boolean);
    const levels: Record<string, "read" | "write" | "admin"> = {};
    for (const s of scopes) {
      const m = s.match(/^vault:([^:]+):(read|write|admin)$/);
      if (!m) continue;
      const [, vault, level] = m as unknown as [string, string, "read" | "write" | "admin"];
      if (!levels[vault] || LEVEL_RANK[level] > LEVEL_RANK[levels[vault]!]) levels[vault] = level;
    }
    return {
      name: r.name,
      owner: r.owner,
      owner_kind: r.owner_kind,
      scopes,
      levels,
      allow_tags: list(allowTags(r.permissions)),
      types: list(r.types),
      denies: list(r.denies),
      status: r.revoked_at ? "revoked" : r.expires_at && r.expires_at <= now.toISOString() ? "expired" : "active",
      created_via: r.created_via,
      created_at: r.created_at,
      expires_at: r.expires_at,
    };
  });
}
