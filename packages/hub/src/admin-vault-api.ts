/**
 * The vault's admin routes under the hub's one admin API (0.9.3, T-463):
 *
 *   /admin/api/vaults/<n>/<config|usage|embeddings|transcription|mirror[/...]|triggers[/...]>
 *
 * forwarded to the vault's own handler for the old `/vault/<n>/.parachute/<...>` and `/vault/<n>/api/triggers`.
 * Two ways in:
 *
 *   - The hub session (`parachute_hub_session`, the sign-in of the hub's admin page). Safe methods need the session
 *     alone; a write needs the double-submit CSRF token (`X-CSRF-Token`, matching the `parachute_hub_csrf` cookie)
 *     and the same-origin belt, as the hub's other cookie-gated writes do. The session must be a hub admin's, and
 *     not behind the admin screen lock.
 *   - `Authorization: Bearer` with a vault key, for scripts. The key goes to the vault as it is, so the vault's own
 *     checks answer: 401 for a bad key, 403 without admin, 403 for a tag-scoped key (T-419).
 *
 * How the vault learns it is an admin: for a session the hub mints a hub JWT of 60 seconds (aud `vault.<n>`, scope
 * `vault:<n>:admin`, `vault_scope [<n>]`, signed with the hub's key) and sends it as the Bearer on the loopback hop.
 * No header says "trust me": an outside request cannot forge a signature, and the vault verifies the token as it
 * does any other. The outside request's own cookie, CSRF header and Authorization never reach the vault in that
 * case. (An internal header would be one more thing for every proxy hop and the vault to agree not to believe.)
 * A session is an untagged admin, so the vault's tag-scope wall (T-419) has nothing to refuse.
 */
import type { Database } from "bun:sqlite";
import { lockedResponse, requireUnlocked } from "./admin-lock.ts";
import { verifyCsrfToken } from "./csrf.ts";
import { signAccessToken } from "./jwt-sign.ts";
import { assertSameOriginForCookieMutation } from "./origin-check.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isHubAdmin } from "./users.ts";

export const ADMIN_API_PREFIX = "/admin/api/vaults/";
export const CSRF_HEADER_NAME = "x-csrf-token";
const SESSION_TOKEN_TTL_SECONDS = 60;
const CLIENT_ID = "parachute-hub-admin-api";

// What the vault's admin routes are. `config/schema` is public and stays where it is.
const FAMILY = /^(config|usage|embeddings|transcription|mirror(\/.*)?|triggers(\/.*)?)$/;

/** `/admin/api/vaults/<n>/<rest>` → the vault name and the rest, or null. */
export function parseAdminVaultPath(pathname: string): { vault: string; rest: string } | null {
  if (!pathname.startsWith(ADMIN_API_PREFIX)) return null;
  const tail = pathname.slice(ADMIN_API_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return null;
  let vault: string;
  try {
    vault = decodeURIComponent(tail.slice(0, slash));
  } catch {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(vault)) return null;
  return { vault, rest: tail.slice(slash + 1) };
}

/** Where the vault answers this admin route today. */
export function vaultPathFor(vault: string, rest: string): string | null {
  if (!FAMILY.test(rest)) return null;
  if (rest === "triggers" || rest.startsWith("triggers/")) return `/vault/${vault}/api/${rest}`;
  return `/vault/${vault}/.parachute/${rest}`;
}

/** The new address for an old vault admin path (`Link: rel="successor-version"`), or null when the path isn't one. */
export function successorFor(pathname: string): string | null {
  const dot = pathname.match(/^\/vault\/([^/]+)\/\.parachute\/((?:config|usage|embeddings|transcription|mirror)(?:\/.*)?)$/);
  if (dot && FAMILY.test(dot[2]!)) return `${ADMIN_API_PREFIX}${dot[1]}/${dot[2]}`;
  const trig = pathname.match(/^\/vault\/([^/]+)\/api\/(triggers(?:\/.*)?)$/);
  if (trig) return `${ADMIN_API_PREFIX}${trig[1]}/${trig[2]}`;
  return null;
}

/** The same response, saying the old address is going. */
export function markDeprecated(res: Response, successor: string): Response {
  const headers = new Headers(res.headers);
  headers.set("deprecation", "true");
  headers.append("link", `<${successor}>; rel="successor-version"`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export interface AdminVaultApiDeps {
  db: Database;
  /** Hub origin: `iss` of the short token. */
  issuer: string;
  boundOrigins: readonly string[];
  vaultExists: (name: string) => boolean;
  /**
   * Send a request on to the vault (the hub's own vault proxy, so a loopback-only vault stays hidden from outside
   * and the key door still applies). Its URL path is already the vault's.
   */
  forward: (req: Request) => Promise<Response | undefined>;
}

export async function handleAdminVaultApi(req: Request, deps: AdminVaultApiDeps): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseAdminVaultPath(url.pathname);
  const target = parsed ? vaultPathFor(parsed.vault, parsed.rest) : null;
  if (!parsed || !target) return jsonError(404, "not_found", "no such admin route");

  const bearer = /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");
  let outgoing: Headers;
  if (bearer) {
    // A script's own vault key; the vault decides. The cookie, if any, is not looked at.
    if (!deps.vaultExists(parsed.vault)) return jsonError(404, "not_found", "no such vault");
    outgoing = new Headers(req.headers);
    outgoing.delete("cookie");
    outgoing.delete(CSRF_HEADER_NAME);
  } else {
    const sid = parseSessionCookie(req.headers.get("cookie"));
    const session = sid ? findSession(deps.db, sid) : null;
    if (!sid || !session) {
      return jsonError(401, "unauthenticated", "sign in at /login, or send a vault admin key as a Bearer");
    }
    if (!isHubAdmin(deps.db, session.userId)) {
      return jsonError(403, "not_admin", "the vault admin API is for the hub admin");
    }
    if (!requireUnlocked(deps.db, sid).ok) return lockedResponse();
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const belt = assertSameOriginForCookieMutation(req, deps.boundOrigins);
      if (belt) return belt;
      if (!verifyCsrfToken(req, req.headers.get(CSRF_HEADER_NAME))) {
        return jsonError(403, "csrf_failed", `send the CSRF token as ${CSRF_HEADER_NAME} (it matches the parachute_hub_csrf cookie)`);
      }
    }
    if (!deps.vaultExists(parsed.vault)) return jsonError(404, "not_found", "no such vault");
    const minted = await signAccessToken(deps.db, {
      sub: session.userId,
      scopes: [`vault:${parsed.vault}:admin`],
      audience: `vault.${parsed.vault}`,
      clientId: CLIENT_ID,
      issuer: deps.issuer,
      ttlSeconds: SESSION_TOKEN_TTL_SECONDS,
      vaultScope: [parsed.vault],
    });
    outgoing = new Headers(req.headers);
    outgoing.delete("cookie");
    outgoing.delete(CSRF_HEADER_NAME);
    outgoing.delete("x-api-key");
    outgoing.set("authorization", `Bearer ${minted.token}`);
  }

  const next = new URL(req.url);
  next.pathname = target;
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const forwarded = new Request(next.toString(), {
    method: req.method,
    headers: outgoing,
    body: hasBody ? req.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual",
    signal: req.signal,
  } as RequestInit);
  const res = await deps.forward(forwarded);
  return res ?? jsonError(404, "not_found", "no such vault");
}
