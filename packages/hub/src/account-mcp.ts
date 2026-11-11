/**
 * Account-level MCP tools for the self-host hub — the payload behind
 * `/account/mcp`.
 *
 * Hub-native tools live here (list-vaults, create-vault, grant/revoke/
 * list-access). The admin-shaped trio needs the `admin` verb on the vault,
 * which only `user_vaults.role = 'write'` carries — a `member`-role principal
 * reads and writes the vault but never sees these tools in `tools/list`.
 * Vault-shaped tools are a live `tools/list` + JSON-RPC proxy
 * (`account-mcp-backend.ts`) onto `/vault/<name>/mcp` — not REST clones. Cloud's twin in the identity worker is still a REST facade and
 * is out of this cut. Coverage is hub-shaped:
 *
 *   - Bearer is the cloud-shaped connection grant: `account:self:vaults`
 *     (legacy blanket / narrowed) or composed `account:self:vaults:*:<verb>`,
 *     plus `parachute:host:admin` as the operator bypass. REST `account:self:read`
 *     does NOT open this door — that scope lists vaults and usage, not notes.
 *   - NIP-98 is the Buzz path. First-admin → every vault + create. Anyone
 *     else → `user_vaults` ∩ services.json (fail-closed; read verb required).
 *     Auto-provisioned key-only users have no rows → empty list, no create.
 *
 * query-notes (the one account overlay) fans out through a 60s
 * `vault:<name>:read` mint to each vault's MCP `query-notes`. A failed
 * vault becomes that vault's `{ vault, error }` — never a whole-call
 * failure. Opt-in reuse: `PARACHUTE_ACCOUNT_MCP_HOP_TTL_SECONDS` (1..599)
 * mints once per (user, vault, verb) and reuses until TTL; unset keeps
 * the per-call 60s hop. See `account-mcp-hop.ts` (hub#918). Default off.
 */
import type { Database } from "bun:sqlite";
import {
  ACCOUNT_VAULTS_UNNARROWED,
  COMPOSED_VERB_RANK,
  type ComposedVaultVerb,
  accountVaultsGrant,
  composedAccountGrant,
  composedVerbSatisfies,
} from "@openparachute/door-contract";
import { type AccountVaultMeta, listVaultsWithMeta } from "./account-api.ts";
import { HOST_ADMIN_SCOPE, provisionVault } from "./admin-vaults.ts";
import {
  GrantError,
  callerCanAdminVault,
  grantAccess,
  listAccess,
  revokeAccess,
} from "./grant-access.ts";
import type { SignAccessTokenOpts } from "./jwt-sign.ts";
import { keyLevelOnVault, levelSatisfies } from "./key-level.ts";
import type { KeyClaim } from "./keys.ts";
import { getUserById, isHubAdmin, vaultVerbsForUserVault } from "./users.ts";

/** Hub account sentinel — account ≡ box. */
export const HUB_ACCOUNT_ID = "self";

/** Per-vault timeout for MCP JSON-RPC forwards and query-notes fan-out. */
export const FANOUT_TIMEOUT_MS = 10_000;

export const ACCOUNT_MCP_CLIENT_ID = "parachute-account";
export const FANOUT_TOKEN_TTL_SECONDS = 60;

export type AccountMcpAuthKind = "bearer" | "nostr";

export interface AccountConnectionGrant {
  wildcard: ComposedVaultVerb | null;
  /**
   * True when the wildcard is a 0.9.0 coverage scope with no level (`account:vaults`, `account:self:vaults`):
   * the person's role applies there. A verb-carrying `account:self:vaults:*:<verb>` caps at its verb (key-level.ts).
   */
  levelless: boolean;
  vaults: Map<string, ComposedVaultVerb>;
  create: boolean;
}

export interface AccountMcpPrincipal {
  userId: string;
  scopes: string[];
  authKind: AccountMcpAuthKind;
  clientId: string | undefined;
  /**
   * The Nostr pubkey that SIGNED this request (64 lowercase hex, NIP-01 form).
   *
   * Set only on the NIP-98 path (hub#937). Bearer / password / OAuth
   * connections leave it `undefined` — there is no key to name, and inventing
   * one would fabricate attribution.
   *
   * Several agents, each with their own key, routinely link to ONE hub user.
   * `userId` therefore cannot tell them apart; this can. It is carried
   * separately from `clientId` (which the NIP-98 door also formats as
   * `nostr:<pubkey>`) so downstream code never has to string-parse an
   * identifier whose format is a display choice.
   */
  pubkey?: string;
  /**
   * The named key this Bearer is (its signed top-level `key` claim, `{name, kind}`; keys.ts `KeyClaim`). The hop to
   * each vault carries it unchanged, so a write through the account door is stamped `via key:<name>`, exactly as the
   * same key writing at a vault door (vault core write-stamp.ts). Read only from the token the hub signed, never
   * from the request. Absent for NIP-98 and for credentials that are not named keys.
   */
  key?: KeyClaim;
  /**
   * The `jti` of the Bearer this request came with. The hop cache is keyed by it (account-mcp-backend.ts), so a hop
   * minted for one key is never handed to another, and a revoked key, refused at the door on every request, can
   * never reach its cached hop again.
   */
  tokenId?: string;
  /** First-admin, or a Bearer that already carries host:admin. */
  isHubAdmin: boolean;
  /** Present on Bearer (null only for NIP-98). host:admin is a synthetic wildcard. */
  grant: AccountConnectionGrant | null;
}

export class AccountToolError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AccountToolError";
  }
}

export interface Coverage {
  covered: "all" | "listed";
  vaults: AccountVaultMeta[];
  names: string[];
  create: boolean;
}

export interface AccountToolContext {
  db: Database;
  issuer: string;
  manifestPath: string;
  principal: AccountMcpPrincipal;
  now?: () => Date;
  runCommand?: (cmd: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  signToken?: (db: Database, opts: SignAccessTokenOpts) => Promise<{ token: string }>;
}

export interface AccountMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: AccountToolContext): Promise<unknown>;
}

function raiseVaultVerb(
  map: Map<string, ComposedVaultVerb>,
  name: string,
  verb: ComposedVaultVerb,
): void {
  const cur = map.get(name);
  if (!cur || COMPOSED_VERB_RANK[verb] > COMPOSED_VERB_RANK[cur]) map.set(name, verb);
}

/**
 * Unify legacy Wave A `account:<id>:vaults` with the composed grammar.
 * Returns null when the set confers nothing that opens this door.
 */
export function buildAccountConnectionGrant(
  scopes: readonly string[],
  accountId: string = HUB_ACCOUNT_ID,
): AccountConnectionGrant | null {
  const composed = composedAccountGrant(scopes, accountId);
  let wildcard = composed.wildcard;
  const vaults = new Map(composed.vaults);
  let create = composed.create;
  let levelless = false;
  if (scopes.includes(ACCOUNT_VAULTS_UNNARROWED)) {
    create = true;
    levelless = true;
    if (wildcard === null) wildcard = "read";
  }
  const legacy = accountVaultsGrant(scopes, accountId);
  if (legacy !== null) {
    create = true;
    if ("blanket" in legacy) {
      levelless = true;
      if (wildcard === null) wildcard = "read";
    } else {
      for (const name of legacy.vaults) raiseVaultVerb(vaults, name, "read");
    }
  }
  if (scopes.includes(HOST_ADMIN_SCOPE)) {
    return { wildcard: "admin", levelless: false, vaults, create: true };
  }
  const opensDoor = wildcard !== null || vaults.size > 0 || create;
  return opensDoor ? { wildcard, levelless, vaults, create } : null;
}

function canCreate(principal: AccountMcpPrincipal): boolean {
  if (principal.authKind === "nostr") return principal.isHubAdmin;
  return principal.grant?.create === true;
}

function assignedReadable(
  db: Database,
  userId: string,
  installed: AccountVaultMeta[],
): AccountVaultMeta[] {
  const user = getUserById(db, userId);
  const assigned = new Set(user?.assignedVaults ?? []);
  return installed.filter((v) => {
    if (!assigned.has(v.name)) return false;
    const verbs = vaultVerbsForUserVault(db, userId, v.name);
    return verbs?.includes("read");
  });
}

/**
 * Live coverage. NIP-98 is assignment. Bearer is the connection grant ∩
 * currently installed vaults (and ∩ assignment when the subject is not
 * first-admin). host:admin is unrestricted.
 */
export function resolveCoverage(
  db: Database,
  principal: AccountMcpPrincipal,
  installed: AccountVaultMeta[],
): Coverage {
  if (principal.authKind === "nostr") {
    if (principal.isHubAdmin || isHubAdmin(db, principal.userId)) {
      return {
        covered: "all",
        vaults: installed,
        names: installed.map((v) => v.name),
        create: true,
      };
    }
    const vaults = assignedReadable(db, principal.userId, installed);
    return { covered: "listed", vaults, names: vaults.map((v) => v.name), create: false };
  }

  const grant = principal.grant;
  const create = grant?.create === true;
  const owned =
    principal.isHubAdmin || isHubAdmin(db, principal.userId)
      ? installed
      : assignedReadable(db, principal.userId, installed);

  if (!grant || grant.wildcard !== null) {
    const covered = grant?.wildcard !== null || principal.isHubAdmin ? "all" : "listed";
    return { covered, vaults: owned, names: owned.map((v) => v.name), create };
  }
  const vaults = owned.filter((v) => grant.vaults.has(v.name));
  return { covered: "listed", vaults, names: vaults.map((v) => v.name), create };
}

export function installedVaults(ctx: AccountToolContext): AccountVaultMeta[] {
  return listVaultsWithMeta(ctx.manifestPath, ctx.issuer);
}

function isUnrestricted(db: Database, principal: AccountMcpPrincipal): boolean {
  return principal.isHubAdmin || isHubAdmin(db, principal.userId);
}

/**
 * Per-call write check: the key's level on that vault is at least write (`keyLevelOnVault`, the 1.0 grants seam).
 * Opening the account door (list/query) is not write.
 */
export function canWriteVault(
  db: Database,
  principal: AccountMcpPrincipal,
  vaultName: string,
): boolean {
  return levelSatisfies(keyLevelOnVault(db, principal, vaultName), "write");
}

/** The verb of the hop token for `vaultName`: the key's level there (`keyLevelOnVault`), never the person's role. */
export function verbForVault(ctx: AccountToolContext, vaultName: string): ComposedVaultVerb {
  return keyLevelOnVault(ctx.db, ctx.principal, vaultName) ?? "read";
}

const listVaultsTool: AccountMcpTool = {
  name: "list-vaults",
  description:
    "List the vaults this connection can reach. Returns each vault's name, URL, and version, " +
    "plus whether the grant covers ALL of the hub's vaults or a specific listed subset. " +
    "Catalog caveat: the other tools are listed from your highest-level vault; a vault where you hold less may refuse one.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
    return {
      covered: coverage.covered,
      vaults: coverage.vaults.map((v) => ({ name: v.name, url: v.url, version: v.version })),
    };
  },
};

const createVaultTool: AccountMcpTool = {
  name: "create-vault",
  description:
    "Create a new vault on this hub. Returns the new vault's name and URL. " +
    "Does not return a vault token — mint one out of band if you need a credential.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The vault name (lowercase letters, numbers, hyphens, and underscores).",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!canCreate(ctx.principal)) {
      throw new AccountToolError(
        "create_not_granted",
        "This connection was not granted permission to create vaults.",
      );
    }
    const rawName = typeof args.name === "string" ? args.name : "";
    const provisioned = await provisionVault(rawName, {
      db: ctx.db,
      issuer: ctx.issuer,
      manifestPath: ctx.manifestPath,
      ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
    });
    if (!provisioned.ok) {
      const message = provisioned.message;
      if (provisioned.status === 400 && /reserved/i.test(message)) {
        throw new AccountToolError("reserved", "That name is reserved. Please choose another.");
      }
      if (provisioned.status === 400) {
        throw new AccountToolError(
          "invalid_name",
          "Use lowercase letters, numbers, hyphens, and underscores.",
        );
      }
      throw new AccountToolError("server_error", message);
    }
    if (!provisioned.created) {
      throw new AccountToolError("vault_taken", "That vault name is already taken.");
    }
    return { name: provisioned.entry.name, url: provisioned.entry.url };
  },
};

function installedNameSet(ctx: AccountToolContext): Set<string> {
  return new Set(installedVaults(ctx).map((v) => v.name));
}

function throwGrant(err: unknown): never {
  if (err instanceof GrantError) throw new AccountToolError(err.errorType, err.message);
  throw err;
}

const grantAccessTool: AccountMcpTool = {
  name: "grant-access",
  description:
    "Give a Nostr pubkey access to one vault. Creates a key-only hub user if the " +
    "pubkey is not yet linked. Writes one user_vaults row — does not replace the " +
    "target's other vaults. Role is read, member, or write, and cannot be granted " +
    "unless you can admin that vault. Prefer `member` unless the target genuinely " +
    "needs to re-grant: `write` carries vault admin.",
  inputSchema: {
    type: "object",
    properties: {
      pubkey: {
        type: "string",
        description:
          "Nostr public key, hex or npub: either a 64-character lowercase-hex x-only " +
          "key or an npub1… (NIP-19 bech32) key. The npub is decoded to hex.",
      },
      vault: { type: "string", description: "Installed vault name." },
      role: {
        type: "string",
        enum: ["read", "member", "write"],
        description:
          'Access role. "read" is read-only; "member" is read+write with NO admin ' +
          '(cannot grant/revoke/list access); "write" is full vault authority ' +
          "(read/write/admin, and therefore may re-grant to anyone).",
      },
    },
    required: ["pubkey", "vault", "role"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return await grantAccess(
        ctx.db,
        // `via` is stamped at the door, not carried on the principal: the
        // principal describes WHO, this describes WHICH ENTRANCE.
        { ...ctx.principal, via: "mcp" },
        args,
        installedNameSet(ctx),
        ctx.now ?? (() => new Date()),
      );
    } catch (err) {
      throwGrant(err);
    }
  },
};

const revokeAccessTool: AccountMcpTool = {
  name: "revoke-access",
  description:
    "Remove one vault grant from a Nostr pubkey. Leaves the hub user and any other " +
    "vaults in place. Refuses the hub owner (unrestricted by construction).",
  inputSchema: {
    type: "object",
    properties: {
      pubkey: {
        type: "string",
        description:
          "Nostr public key, hex or npub: either a 64-character lowercase-hex x-only " +
          "key or an npub1… (NIP-19 bech32) key. The npub is decoded to hex.",
      },
      vault: { type: "string", description: "Installed vault name." },
    },
    required: ["pubkey", "vault"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return revokeAccess(ctx.db, { ...ctx.principal, via: "mcp" }, args, installedNameSet(ctx));
    } catch (err) {
      throwGrant(err);
    }
  },
};

const listAccessTool: AccountMcpTool = {
  name: "list-access",
  description:
    "List pubkey → vault grants this connection can admin. Omit `vault` for every " +
    "such grant; pass it to filter to one vault. Password-only users without a " +
    "linked key are not included. Each row carries granted_by_pubkey and " +
    "granted_via (both null for grants made before the hub recorded a grantor).",
  inputSchema: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        description: "Restrict to one installed vault. Omit to list every vault you can admin.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return listAccess(ctx.db, ctx.principal, args, installedNameSet(ctx));
    } catch (err) {
      throwGrant(err);
    }
  },
};

/** Hub-native catalog. Vault-shaped tools come from a live module `tools/list`. */
export const ACCOUNT_MCP_TOOLS: readonly AccountMcpTool[] = [
  listVaultsTool,
  createVaultTool,
  grantAccessTool,
  revokeAccessTool,
  listAccessTool,
];

/** Hub-native names win on collision with a module backend. */
export const HUB_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(
  ACCOUNT_MCP_TOOLS.map((t) => t.name),
);

/**
 * Hub-native catalog filtered by what this principal can actually call.
 * Admin-shaped tools are invisible below the verb, not just refused.
 * Vault-shaped tools are merged in by `account-mcp-http.ts` from a live list.
 */
export function toolsForPrincipal(ctx: AccountToolContext): readonly AccountMcpTool[] {
  const installed = installedVaults(ctx);
  const coverage = resolveCoverage(ctx.db, ctx.principal, installed);
  const canAdmin = coverage.vaults.some((v) => callerCanAdminVault(ctx.db, ctx.principal, v.name));
  const create = canCreate(ctx.principal);
  return ACCOUNT_MCP_TOOLS.filter((t) => {
    if (t.name === "create-vault") return create;
    if (t.name === "grant-access" || t.name === "revoke-access" || t.name === "list-access") {
      return canAdmin;
    }
    return true;
  });
}
