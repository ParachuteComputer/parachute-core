/**
 * The friend's side of sharing a vault, and the names every sharer reads (share-invites.ts; app docs/design/SHARING.md).
 *
 *   POST /account/invites/look    {code}   anyone holding the code → {vault, from, name, can, expires_at}; nothing used
 *   POST /account/invites/accept  {code}   NIP-98 by the friend's key → the same, and the friend is a member of the vault
 *   GET  /account/vaults/<v>/names?by=…    a token for <v> (aud `vault.<v>`) → {names: {<by>: {name, you}}}
 *
 * `look` and `accept` answer every failure with one 404 `no_invite` (a bad, used, taken-back or expired code; a key
 * that is a hub admin or already reaches the vault), so a stranger learns nothing. Both are rate limited per address;
 * the code is 256 bits, so the limit is a floor, not the defense.
 */
import type { Database } from "bun:sqlite";
import { extractBearerToken } from "./admin-auth.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import {
  type NostrReplayCache,
  extractNostrEvent,
  verifyNostrHttpEvent,
} from "./nostr-http-auth.ts";
import { RateLimiter, clientIpFromRequest } from "./rate-limit.ts";
import { acceptInvite, lookInvite, namesFor, reachesVault } from "./share-invites.ts";
import { listVaultNamesFromPath } from "./vault-names.ts";

export interface ApiShareInvitesDeps {
  db: Database;
  /** The hub's origins a token's `iss` may name. */
  knownIssuers: readonly string[];
  manifestPath: string;
  now?: () => Date;
  replay?: NostrReplayCache;
}

/** 30 looks or accepts per address per 10 minutes. */
export const shareInviteRateLimiter = new RateLimiter(30, 10 * 60 * 1000);

/** Bearer or NIP-98, never a cookie, so any origin may call (as the account MCP: account-mcp-http.ts). */
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
const preflight = (methods: string) =>
  new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": methods,
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-max-age": "86400",
    },
  });
const noInvite = () =>
  json(404, {
    error: "no_invite",
    message: "That invite isn't open: it may be used, taken back or past its date.",
  });

async function readCode(bytes: Uint8Array): Promise<unknown> {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown };
    return body && typeof body === "object" ? body.code : null;
  } catch {
    return null;
  }
}

/** Routes `/account/invites/look` and `/account/invites/accept`; null for any other path. */
export async function routeShareInvites(
  req: Request,
  pathname: string,
  deps: ApiShareInvitesDeps,
): Promise<Response | null> {
  if (pathname !== "/account/invites/look" && pathname !== "/account/invites/accept") return null;
  if (req.method === "OPTIONS") return preflight("POST, OPTIONS");
  if (req.method !== "POST") return json(405, { error: "method_not_allowed", message: "use POST" });
  const now = deps.now ?? (() => new Date());
  const limited = shareInviteRateLimiter.checkAndRecord(clientIpFromRequest(req), now());
  if (!limited.allowed) {
    return new Response(
      JSON.stringify({ error: "rate_limited", message: "Too many tries. Wait a few minutes." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(limited.retryAfterSeconds ?? 60),
          ...CORS,
        },
      },
    );
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > 4096) return noInvite();
  const code = await readCode(bytes);
  if (pathname === "/account/invites/look") {
    const view = lookInvite(deps.db, code, now());
    return view ? json(200, view) : noInvite();
  }
  // accept: the friend's key signs this request (NIP-98: this URL, POST, the body's hash, fresh, once)
  let pubkey: string;
  try {
    const event = extractNostrEvent(req);
    verifyNostrHttpEvent(req, event, { now, replay: deps.replay, body: bytes });
    pubkey = event.pubkey;
  } catch {
    return json(401, {
      error: "unauthorized",
      message: "Accepting an invite is signed with your key.",
    });
  }
  const outcome = await acceptInvite(
    deps.db,
    pubkey,
    code,
    new Set(listVaultNamesFromPath(deps.manifestPath)),
    now,
  );
  return outcome.ok ? json(200, outcome.view) : noInvite();
}

/** `GET /account/vaults/<v>/names?by=<stamp>&by=…`, with a token minted for that vault. */
export async function handleVaultNames(
  req: Request,
  vault: string,
  deps: ApiShareInvitesDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return preflight("GET, OPTIONS");
  if (req.method !== "GET") return json(405, { error: "method_not_allowed", message: "use GET" });
  let sub: string;
  try {
    const { payload } = await validateAccessToken(
      deps.db,
      extractBearerToken(req),
      deps.knownIssuers,
    );
    if (payload.aud !== `vault.${vault}` || typeof payload.sub !== "string")
      throw new Error("not for this vault");
    sub = payload.sub;
  } catch {
    return json(401, { error: "unauthorized", message: "A token for this vault is needed." });
  }
  // the token's person still reaches the vault (an ended member's tokens are revoked too; this is the second lock)
  if (!reachesVault(deps.db, sub, vault))
    return json(401, { error: "unauthorized", message: "A token for this vault is needed." });
  const stamps = new URL(req.url).searchParams.getAll("by");
  return json(200, { names: namesFor(deps.db, vault, sub, stamps) });
}
