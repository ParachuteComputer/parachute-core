/**
 * The level a key has on one vault, through the account door (0.9.1 "one multi-vault door", T-446).
 *
 * This is the one place that answers "what may this connection do on vault X". Every account-door decision reads
 * it: the verb of the hop token minted for that vault (`account-mcp-backend.ts` via `verbForVault`), whether a write
 * goes through (`canWriteVault`), and whether the hub-native admin tools (grant/revoke/list access) are open
 * (`callerCanAdminVault`). **1.0 grants replace this function's body** (the draft grants spec, core #69): a grant
 * names what a key may touch more finely than a level per vault, and slots in here without moving any caller.
 *
 * The rule: the key's level on that vault, never more than the person's own role there.
 *
 * - A key names its level per vault (`account:self:vaults:<v>:<verb>`) or for every vault
 *   (`account:self:vaults:*:<verb>`). A named vault wins over the wildcard (the narrower word; the rule since #21).
 * - The person's role caps it: a write key held by a person with read on that vault is read. The hub owner (first
 *   admin) and the operator credential (`parachute:host:admin`) are admin everywhere.
 * - A 0.9.0 coverage scope with no level (`account:vaults`, `account:self:vaults`, what OAuth consent to the account
 *   door grants today) carries no level of its own, so the person's role is its level, as before. Whether such a
 *   connection should be capped (its consent line reads as list, search, create and grant access) is open, for Aaron.
 * - A NIP-98 request is the person, so the person's role.
 */
import type { Database } from "bun:sqlite";
import { COMPOSED_VERB_RANK, type ComposedVaultVerb } from "@openparachute/door-contract";
import { isHubAdmin, vaultVerbsForUserVault } from "./users.ts";

/** What the seam reads from a connection. `AccountMcpPrincipal` and `GrantCaller` both fit. */
export interface KeyLevelCaller {
  userId: string;
  isHubAdmin: boolean;
  authKind: "bearer" | "nostr";
  grant: {
    wildcard: string | null;
    /** True when the wildcard came from a 0.9.0 scope with no level: coverage only, the person's role applies. */
    levelless?: boolean;
    vaults: { get(name: string): string | undefined };
  } | null;
}

function asVerb(v: string | undefined | null): ComposedVaultVerb | null {
  return v === "read" || v === "write" || v === "admin" ? v : null;
}

const lower = (a: ComposedVaultVerb, b: ComposedVaultVerb): ComposedVaultVerb =>
  COMPOSED_VERB_RANK[a] <= COMPOSED_VERB_RANK[b] ? a : b;

/** The person's own level on a vault: admin for the hub owner / operator, else their `user_vaults` role. */
export function personLevelOnVault(
  db: Database,
  caller: KeyLevelCaller,
  vaultName: string,
): ComposedVaultVerb | null {
  if (caller.isHubAdmin || isHubAdmin(db, caller.userId)) return "admin";
  const verbs = vaultVerbsForUserVault(db, caller.userId, vaultName);
  if (!verbs) return null;
  if (verbs.includes("admin")) return "admin";
  if (verbs.includes("write")) return "write";
  if (verbs.includes("read")) return "read";
  return null;
}

/**
 * The level this connection has on `vaultName`, or null when it has none there. The seam 1.0 grants replace.
 */
export function keyLevelOnVault(
  db: Database,
  caller: KeyLevelCaller,
  vaultName: string,
): ComposedVaultVerb | null {
  const role = personLevelOnVault(db, caller, vaultName);
  if (role === null) return null;
  if (caller.authKind !== "bearer") return role;
  const grant = caller.grant;
  if (!grant) return null;
  const named = grant.vaults.get(vaultName);
  let cap: ComposedVaultVerb | null;
  if (named !== undefined) cap = asVerb(named);
  else if (grant.wildcard === null) cap = null;
  else if (grant.levelless === true) cap = "admin";
  else cap = asVerb(grant.wildcard);
  return cap === null ? null : lower(cap, role);
}

/** True when `level` is at least `need`. */
export function levelSatisfies(level: ComposedVaultVerb | null, need: ComposedVaultVerb): boolean {
  return level !== null && COMPOSED_VERB_RANK[level] >= COMPOSED_VERB_RANK[need];
}
