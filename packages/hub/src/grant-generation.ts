/**
 * The grant generation (T-446, PR #72 round 7): one counter per (user, client) for the account door's per-vault
 * choice. It is what makes "a narrower choice ends everything minted under the wider one" hold for mints that are
 * in flight, not only for what exists at the instant of the choice.
 *
 *   - Bump: a choice that narrows (a vault dropped, write → read, the level-less grant replaced) or all-none
 *     increments the generation in the same synchronous step as the grant write (oauth-handlers
 *     `applyAccountDoorChoice`).
 *   - Stamp: every auth code and refresh row carries the generation it was minted under (`grant_generation`). A code
 *     takes the current one; a refresh row takes its code's, a rotated row its predecessor's. A narrowing moves the
 *     rows it still covers to the new generation, so they keep working.
 *   - Check: every mint of a refresh row re-reads its artifact's generation from the DB in the same synchronous
 *     transaction as the insert, after any await, and refuses on a mismatch (`assertMintedUnderCurrentGrant`, called
 *     by `signRefreshToken`, which requires the reader). So a code redeem or a refresh that was signing while the
 *     person narrowed inserts nothing and returns nothing signed.
 *
 * Only rows whose scopes carry an account-door choice scope are checked: a bump must not end the same client's
 * unrelated vault-scoped families. The counter lives in its own table (`grant_generations`, hub-db
 * `ensureGrantGenerations`) and is never deleted with the grant row, so revoke-then-reconsent can't reset it.
 */
import type { Database } from "bun:sqlite";
import { ACCOUNT_VAULTS_UNNARROWED, accountVaultsScope } from "@openparachute/door-contract";

export function isAccountVaultsConnectionScope(scope: string): boolean {
  return scope === ACCOUNT_VAULTS_UNNARROWED || scope === accountVaultsScope("self");
}

/**
 * Consent per vault (0.9.1 "one multi-vault door", T-446): the account-door grant the consent screen mints when the
 * person chooses a level for each vault, `account:self:vaults:<vault>:<read|write>`. The account door holds each hop
 * to that level (key-level.ts `keyLevelOnVault`). Dropped from any client ask (isNarrowedAccountVaultsScope); minted
 * only from the consent form, and capped again at the choke-point (`capScopesToUserAuthority`).
 */
export const PER_VAULT_LEVELS = ["read", "write"] as const;
export type PerVaultLevel = (typeof PER_VAULT_LEVELS)[number];
const PER_VAULT_SCOPE_RE = /^account:self:vaults:([a-z0-9_-]+):(read|write)$/;

export function parsePerVaultScope(scope: string): { vault: string; level: PerVaultLevel } | null {
  const m = PER_VAULT_SCOPE_RE.exec(scope);
  return m ? { vault: m[1]!, level: m[2] as PerVaultLevel } : null;
}

/** The account-door scopes a per-vault choice supersedes: the level-less connection scope and every per-vault level. */
export function isAccountDoorChoiceScope(scope: string): boolean {
  return parsePerVaultScope(scope) !== null || isAccountVaultsConnectionScope(scope);
}

/** The current generation for (user, client); no row means 0 (every row from before the counter is 0). */
export function currentGrantGeneration(db: Database, userId: string, clientId: string): number {
  const row = db
    .query<{ generation: number }, [string, string]>(
      "SELECT generation FROM grant_generations WHERE user_id = ? AND client_id = ?",
    )
    .get(userId, clientId);
  return row?.generation ?? 0;
}

/** Increment and return the generation for (user, client). Call inside the transaction that writes the grant. */
export function bumpGrantGeneration(db: Database, userId: string, clientId: string): number {
  const row = db
    .query<{ generation: number }, [string, string]>(
      `INSERT INTO grant_generations (user_id, client_id, generation) VALUES (?, ?, 1)
       ON CONFLICT (user_id, client_id) DO UPDATE SET generation = generation + 1
       RETURNING generation`,
    )
    .get(userId, clientId);
  return row!.generation;
}

/** The person changed this app's account-door choice while the token was being issued: nothing was kept. */
export class GrantChangedError extends Error {
  override name = "GrantChangedError";
  constructor() {
    super("the grant changed while this token was being issued; authorize again");
  }
}

/**
 * The one check every refresh-row mint runs, inside the transaction that inserts the row and after any await:
 * a mint whose scopes carry an account-door choice scope must come from an artifact (code, refresh row) whose
 * generation, read from the DB now, is the current one. Throws `GrantChangedError` otherwise.
 */
export function assertMintedUnderCurrentGrant(
  db: Database,
  opts: { userId: string; clientId: string; scopes: readonly string[]; artifactGeneration: number },
): void {
  if (!opts.scopes.some(isAccountDoorChoiceScope)) return;
  if (opts.artifactGeneration !== currentGrantGeneration(db, opts.userId, opts.clientId)) throw new GrantChangedError();
}
