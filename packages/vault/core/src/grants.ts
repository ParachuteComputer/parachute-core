/**
 * The grants a vault keeps (docs/SPEC-1.0-grants.md), first slice: **door grants** (§7.3), the door's word that the
 * signed-in owner agreed: "this key may do these things to these types in this vault, until this date". A key's
 * token carries only the grant's id (`permissions.grant`, open decision I); the vault reads the row here on every
 * request, so ending a grant works on the next request and nothing waits for a token to run out.
 *
 * What this slice holds: rows for door grants, filed and ended by the door (the hub) with the vault's admin
 * credential; types with `read`, or `read create update delete` (every type of one grant alike); an end date; an end
 * by revoke. Not yet: signed grants (kind 37440), revokes as events, members, applet grants, `*`, `:own`, denies, and
 * different verbs on different types. Those are refused when filed, never read around.
 *
 * The table is made the first time a grant is filed, not by `initSchema`: a vault with no grant never has it, an
 * older engine ignores it, and a token naming a grant on a vault without the table finds no grant (refused).
 */
import type { Database } from "bun:sqlite";

export const GRANT_VERBS = ["read", "create", "update", "delete"] as const;
export type GrantVerb = (typeof GRANT_VERBS)[number];
export type GrantState = "in_force" | "expired" | "revoked";

/** A grant's id: the door gives it (a key's name), 1 to 80 of `[A-Za-z0-9._-]`, never reused. */
export const GRANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** A type a grant may name: printable ASCII with no space, not `*` (every record is a later slice). */
const TYPE_NAME_RE = /^[!-~]{1,128}$/;
/** At most this many types on one grant (spec §2.1: 1 to 64 rows). */
export const GRANT_MAX_TYPES = 64;

export interface DoorGrant {
  id: string;
  origin: "door";
  /** Who holds it: `key:<name>` for a named key. */
  grantee: string;
  /** Whose name its writes carry (§5): this slice files only `signer` (the owner's own agent or app). */
  by: "signer";
  /** `{<type>: [verbs]}`, verbs in GRANT_VERBS order. */
  types: Record<string, GrantVerb[]>;
  deny: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** What the door sends to file one. */
export interface DoorGrantInput {
  grantee: string;
  types: Record<string, string[]>;
  expires_at: string;
}

const READ_ONLY: GrantVerb[] = ["read"];
const READ_WRITE: GrantVerb[] = ["read", "create", "update", "delete"];

/** Check a grant the door wants to file; the reason in words when it can't be held. */
export function checkDoorGrant(id: string, input: unknown, now: Date = new Date()): { grant: DoorGrantInput } | { problem: string } {
  if (!GRANT_ID_RE.test(id)) return { problem: "id: 1 to 80 of letters, digits, '.', '_' and '-', starting with a letter or digit" };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { problem: "send {grantee, types, expires_at}" };
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !["grantee", "types", "expires_at"].includes(k));
  // An unknown field may be a limit the door meant: refused, never read around (§2.2 line 4).
  if (extra.length) return { problem: `unknown field(s): ${extra.join(", ")}` };
  if (typeof body.grantee !== "string" || !/^key:[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(body.grantee)) return { problem: "grantee: key:<name>" };
  const types = body.types;
  if (!types || typeof types !== "object" || Array.isArray(types)) return { problem: "types: {<type>: [verbs]}" };
  const names = Object.keys(types);
  if (names.length === 0 || names.length > GRANT_MAX_TYPES) return { problem: `types: 1 to ${GRANT_MAX_TYPES} types` };
  let shape: string | null = null;
  for (const name of names) {
    if (!TYPE_NAME_RE.test(name) || name === "*") return { problem: `types: "${name}" can't be granted by name (printable ASCII, no spaces, not *)` };
    const verbs = (types as Record<string, unknown>)[name];
    if (!Array.isArray(verbs) || verbs.some((v) => typeof v !== "string")) return { problem: `types.${name}: a list of verbs` };
    const sorted = GRANT_VERBS.filter((v) => (verbs as string[]).includes(v));
    if (sorted.length !== verbs.length || new Set(verbs).size !== verbs.length) return { problem: `types.${name}: verbs are read, create, update, delete, each once` };
    const s = sorted.join(" ");
    if (s !== READ_ONLY.join(" ") && s !== READ_WRITE.join(" ")) return { problem: `types.${name}: this vault holds read, or read with create, update and delete` };
    if (shape !== null && s !== shape) return { problem: "types: every type of one grant has the same verbs in this vault" };
    shape = s;
  }
  if (typeof body.expires_at !== "string" || Number.isNaN(Date.parse(body.expires_at))) return { problem: "expires_at: an ISO date" };
  const until = Date.parse(body.expires_at);
  if (until <= now.getTime()) return { problem: "expires_at: in the future" };
  // A grant lasts at most a year and a day (decision D's 366 days).
  if (until > now.getTime() + 366 * 86_400_000) return { problem: "expires_at: at most 366 days ahead" };
  return { grant: { grantee: body.grantee, types: types as Record<string, string[]>, expires_at: new Date(until).toISOString() } };
}

// a vault's grants table, once seen, stays (it is never dropped): asked of the catalog until then, not on every request
const hasTable = new WeakSet<Database>();
function hasGrantsTable(db: Database): boolean {
  if (hasTable.has(db)) return true;
  const yes = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grants'").get();
  if (yes) hasTable.add(db);
  return yes;
}

function ensureGrantsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK (origin IN ('door')),
    grantee TEXT NOT NULL,
    by_kind TEXT NOT NULL CHECK (by_kind IN ('signer')),
    types TEXT NOT NULL,
    deny TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`);
}

interface Row {
  id: string;
  origin: "door";
  grantee: string;
  by_kind: "signer";
  types: string;
  deny: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

const fromRow = (r: Row): DoorGrant => ({
  id: r.id,
  origin: r.origin,
  grantee: r.grantee,
  by: r.by_kind,
  types: JSON.parse(r.types),
  deny: JSON.parse(r.deny),
  expires_at: r.expires_at,
  revoked_at: r.revoked_at,
  created_at: r.created_at,
});

/** One grant by id, in whatever state; null when the vault never had it. */
export function getGrant(db: Database, id: string): DoorGrant | null {
  if (!hasGrantsTable(db)) return null;
  const r = db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as Row | null;
  return r ? fromRow(r) : null;
}

/** Every grant the vault keeps, oldest first. Nothing is deleted: an ended grant stays, marked (§3). */
export function listGrants(db: Database): DoorGrant[] {
  if (!hasGrantsTable(db)) return [];
  return (db.prepare("SELECT * FROM grants ORDER BY created_at, id").all() as Row[]).map(fromRow);
}

export function grantState(g: DoorGrant, now: Date = new Date()): GrantState {
  if (g.revoked_at) return "revoked";
  if (Date.parse(g.expires_at) <= now.getTime()) return "expired";
  return "in_force";
}

/**
 * File a door grant. An id is one grant for good: filing the same id again with the same content is a no-op
 * (`same`), with anything else it is refused (`taken`), ended or not, because `key:<name>` stays on what it wrote.
 */
export function fileDoorGrant(db: Database, id: string, g: DoorGrantInput, now: Date = new Date()): "filed" | "same" | "taken" {
  ensureGrantsTable(db);
  const types: Record<string, GrantVerb[]> = {};
  for (const name of Object.keys(g.types).sort()) types[name] = GRANT_VERBS.filter((v) => g.types[name]!.includes(v));
  const was = getGrant(db, id);
  if (was) {
    const same = was.grantee === g.grantee && JSON.stringify(was.types) === JSON.stringify(types) && was.expires_at === g.expires_at;
    return same && !was.revoked_at ? "same" : "taken";
  }
  db.prepare("INSERT INTO grants (id, origin, grantee, by_kind, types, deny, expires_at, revoked_at, created_at) VALUES (?, 'door', ?, 'signer', ?, '[]', ?, NULL, ?)")
    .run(id, g.grantee, JSON.stringify(types), g.expires_at, now.toISOString());
  return "filed";
}

/** End a grant now. Final: an ended grant never comes back (§3). False when the vault never had it. */
export function endGrant(db: Database, id: string, now: Date = new Date()): DoorGrant | null {
  if (!getGrant(db, id)) return null;
  db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id);
  return getGrant(db, id);
}

/**
 * What a grant in force lets a request do, in the vault's existing checkpoint's terms: the types it may see and
 * change (read through the same narrowing a tag-scoped key has, so search, links, counts, history, files and MCP
 * all pass one place), and whether it may write at all.
 */
export function grantReach(g: DoorGrant): { types: string[]; write: boolean } {
  const types = Object.keys(g.types);
  const write = types.some((t) => g.types[t]!.some((v) => v !== "read"));
  return { types, write };
}
