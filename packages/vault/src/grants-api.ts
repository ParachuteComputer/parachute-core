/**
 * `/api/grants`: the door files and ends the grants this vault keeps (docs/SPEC-1.0-grants.md §7.3, first slice).
 * Admin on every method, and never for a narrowed credential: statements are no grantee's to read or change (§4.4).
 *
 *   GET    /api/grants          → 200 {grants: [{id, origin, state, grantee, by, types, deny, expires_at, revoked_at, created_at}]}
 *   PUT    /api/grants/<id>     {grantee, types, expires_at} → 201 filed | 200 the same grant again | 409 id_taken | 400
 *   DELETE /api/grants/<id>     → 200 {id, state: "revoked", revoked_at}; final; 404 when never filed
 *
 * The hub files a key's grant here when it mints the key, and ends it when the key is ended (hub account-keys.ts).
 */
import { checkDoorGrant, endGrant, fileDoorGrant, getGrant, grantState, listGrants, type DoorGrant } from "../core/src/grants.ts";
import type { AuthResult } from "./auth.ts";
import { hasScopeForVault, SCOPE_ADMIN } from "./scopes.ts";
import type { SqliteStore } from "../core/src/store.ts";

const view = (g: DoorGrant, now = new Date()) => ({ ...g, state: grantState(g, now) });

export async function handleGrants(req: Request, store: SqliteStore, sub: string, vaultName: string, auth: AuthResult): Promise<Response> {
  if (!hasScopeForVault(auth.scopes, vaultName, "admin") || auth.scoped_tags !== null || (auth.grant ?? null) !== null) {
    return Response.json(
      { error: "Forbidden", error_type: "insufficient_scope", message: `The grants a vault keeps are its owner's: this needs '${SCOPE_ADMIN.replace("vault:", `vault:${vaultName}:`)}' on the whole vault.`, required_scope: SCOPE_ADMIN },
      { status: 403 },
    );
  }
  const db = store.db;
  if (sub === "" || sub === "/") {
    if (req.method !== "GET") return Response.json({ error: "method_not_allowed", message: "use GET" }, { status: 405, headers: { allow: "GET" } });
    return Response.json({ grants: listGrants(db).map((g) => view(g)) });
  }
  let id: string;
  try {
    id = decodeURIComponent(sub.slice(1));
  } catch {
    return Response.json({ error: "invalid_request", message: "the grant id in the path is not valid percent-encoding" }, { status: 400 });
  }
  if (req.method === "GET") {
    const g = getGrant(db, id);
    return g ? Response.json(view(g)) : Response.json({ error: "not_found", message: `no grant ${id} here` }, { status: 404 });
  }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => undefined);
    const checked = checkDoorGrant(id, body);
    if ("problem" in checked) return Response.json({ error: "invalid_statement", message: checked.problem }, { status: 400 });
    const r = fileDoorGrant(db, id, checked.grant);
    if (r === "taken") return Response.json({ error: "id_taken", message: `grant ${id} was filed before with other content, or has ended; an id is never reused` }, { status: 409 });
    return Response.json(view(getGrant(db, id)!), { status: r === "filed" ? 201 : 200 });
  }
  if (req.method === "DELETE") {
    const g = endGrant(db, id);
    if (!g) return Response.json({ error: "not_found", message: `no grant ${id} here` }, { status: 404 });
    return Response.json({ id, state: "revoked", revoked_at: g.revoked_at });
  }
  return Response.json({ error: "method_not_allowed", message: "use GET, PUT or DELETE" }, { status: 405, headers: { allow: "GET, PUT, DELETE" } });
}
