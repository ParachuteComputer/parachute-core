/**
 * The write stamp (ROADMAP 0.9.1 "Keys by name; the write stamp"): every write records two facts.
 *
 *   - **via**: the key that made it, `key:<name>`, read from the signed token (its top-level `key` claim,
 *     `{name, kind}`), never from the request. Top-level on purpose: an older vault ignores it and stamps as before,
 *     so a rollback keeps every named key working; inside `permissions` an older vault would refuse the key. A credential with no named key keeps the channel (`api`, `mcp`) or its own class (`operator`,
 *     `nostr:<pubkey>`).
 *   - **by**: the person it was for. The token's subject (the key's owner), unless the key holds the on-behalf-of
 *     permission (`permissions.acts_for: "<prefix>"`, given only by the vault's owner at mint). Then a request may
 *     name an id and "by" is `<prefix>:<id>`: the prefix from the token, only the id from the request. Neither part
 *     can hold a colon or an `@`, so a "by" a key sets can never be a real account id, a `nostr:` value, an email or
 *     another key's people. In 0.9.1 the prefix is always the key's own name; the claim is the seam for a prefix
 *     that outlives its keys.
 *
 * A "by" is a label, not an account id: nothing may look it up as one. When link statements arrive ("client-42 is
 * this Nostr key"), they attach beside the stamp, keyed by the whole "by" string; the stamp itself never changes.
 *
 * Pure: no store, no request. The box (packages/vault/src) and the cloud vault worker call the same rule.
 */

/** The REST header that names who a write is for. */
export const ON_BEHALF_HEADER = "Parachute-On-Behalf-Of";
/** The MCP parameter that does the same. */
export const ON_BEHALF_PARAM = "on_behalf_of";

/** An id from the request: letters, digits, `.`, `_`, `-`; 1 to 64. */
export const ON_BEHALF_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A prefix (from the token): lowercase letters, digits, `.`, `-`; 1 to 64. */
export const ON_BEHALF_PREFIX_RE = /^[a-z0-9.-]{1,64}$/;
/** Names a prefix may never be: each is already a class of writer, or a label the vault writes itself. */
export const RESERVED_PREFIXES: readonly string[] = [
  "nostr", "key", "grant", "agent", "applet", "token", "operator", "migrate", "surface", "mcp", "api",
];

/** What a key belongs to (the hub's keys table, `owner_kind`). */
export const KEY_KINDS: readonly string[] = ["person", "agent", "app", "service"];
/** A key's name: the hub's KEY_NAME_RE. */
export const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface StampKey {
  name: string;
  kind: string;
}

/** Why `prefix` can't be an on-behalf-of prefix, or null when it can. */
export function prefixProblem(prefix: unknown): string | null {
  if (typeof prefix !== "string" || !ON_BEHALF_PREFIX_RE.test(prefix)) {
    return "a prefix is 1 to 64 lowercase letters, digits, '.' and '-'";
  }
  if (RESERVED_PREFIXES.includes(prefix)) return `"${prefix}" is reserved (${RESERVED_PREFIXES.join(", ")})`;
  return null;
}

/** Why a key called `name` can't be given the on-behalf-of permission, or null when it can (its name is the prefix). */
export function grantNameProblem(name: string): string | null {
  const p = prefixProblem(name);
  return p
    ? `a key that writes on behalf of others is named for the prefix its writes carry, and ${p.replace(/^a prefix is/, "that is")}: name it e.g. "fernhill-portal"`
    : null;
}

/** `via` for a named key. */
export function keyVia(name: string): string {
  return `key:${name}`;
}

/**
 * Read the `key` claim from a validated token's payload. Absent → null. Present but not `{name, kind}` with a key name
 * and a known kind → throws (the caller refuses the token: a stamp it can't read must not become a generic one).
 */
export function parseKeyClaim(payload: Record<string, unknown> | undefined): StampKey | null {
  if (!payload || !("key" in payload) || payload.key === undefined) return null;
  const raw = payload.key as { name?: unknown; kind?: unknown } | null;
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((k) => k !== "name" && k !== "kind") ||
    typeof raw.name !== "string" || !KEY_NAME_RE.test(raw.name) || typeof raw.kind !== "string" || !KEY_KINDS.includes(raw.kind)
  ) {
    throw new StampClaimError("the key claim is not {name, kind} with a key name and a known kind");
  }
  return { name: raw.name, kind: raw.kind };
}

/**
 * Read `permissions.acts_for` from a validated token. Absent → null. Present → it must be a valid, unreserved prefix
 * on a token that also names its key; otherwise throws. Inside `permissions` on purpose: a vault that doesn't know it
 * refuses the token (fail closed), so an older vault never writes a custodial write unstamped.
 */
export function parseActsForClaim(permissions: Record<string, unknown> | undefined, key: StampKey | null): string | null {
  if (!permissions || !("acts_for" in permissions)) return null;
  const problem = prefixProblem(permissions.acts_for);
  if (problem) throw new StampClaimError(`permissions.acts_for: ${problem}`);
  if (key === null) throw new StampClaimError("permissions.acts_for needs the key claim: only a named key may act for others");
  return permissions.acts_for as string;
}

export class StampClaimError extends Error {}

/** A refusal, shaped for either door. */
export interface OnBehalfRefusal {
  status: 400 | 403;
  error_type: "on_behalf_not_granted" | "invalid_on_behalf_of";
  message: string;
  field: string;
  hint: string;
}

/**
 * The "by" a write carries. `supplied` is the raw value the request gave (header or parameter; undefined when it gave
 * none: a parameter sent as null is a value, and refused like any other), `actsFor` the token's prefix (null without the permission), `actor` the token's own principal.
 * A supplied value without the permission is refused, never ignored; a bad id is refused. Nothing here opens access.
 */
export function resolveBy(
  supplied: unknown,
  actsFor: string | null,
  actor: string | null,
  channel: "rest" | "mcp",
): { by: string | null } | { refusal: OnBehalfRefusal } {
  if (supplied === undefined) return { by: actor };
  const field = channel === "rest" ? ON_BEHALF_HEADER : ON_BEHALF_PARAM;
  if (actsFor === null) {
    return {
      refusal: {
        status: 403,
        error_type: "on_behalf_not_granted",
        field,
        message:
          `${field} names the person a write is for, stamped as "by" <key name>:<id>. This key may not write on behalf ` +
          "of anyone: only the vault's owner can allow it, when minting the key (POST /account/keys {name, vault, can, " +
          "on_behalf_of: true}, or parachute keys new <name> --vault <v> --can write --on-behalf-of). Nothing was " +
          `written. Leave ${field} out to write as yourself.`,
        hint: "mint a key with on_behalf_of: true, or drop the value",
      },
    };
  }
  if (typeof supplied !== "string" || !ON_BEHALF_ID_RE.test(supplied)) {
    return {
      refusal: {
        status: 400,
        error_type: "invalid_on_behalf_of",
        field,
        message:
          `${field} is your own id for the person, 1 to 64 letters, digits, '.', '_' or '-' (no ':' or '@'); the vault ` +
          `stamps it as "${actsFor}:<id>". Nothing was written.`,
        hint: "e.g. client-42",
      },
    };
  }
  return { by: `${actsFor}:${supplied}` };
}

/**
 * A key's kind, by its `via`, for the revisions it writes (`note_versions.via_kind`). A key's name is one key
 * forever at the door that minted it (revoked keys keep their names), so `key:<name>` → kind never changes; the
 * door that authenticates a key's request records it here before the request's writes run.
 */
const KEY_KINDS_BY_VIA = new Map<string, string>();
export function rememberKeyKind(key: StampKey): void {
  KEY_KINDS_BY_VIA.set(keyVia(key.name), key.kind);
}
/** The kind of the key behind `via`, or null when `via` is no named key. */
export function kindOfVia(via: string | null | undefined): string | null {
  return typeof via === "string" ? (KEY_KINDS_BY_VIA.get(via) ?? null) : null;
}
