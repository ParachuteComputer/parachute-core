/**
 * `GET /api/approval-keys`: the keys whose signed approvals count for the caller (T-476, Parachute applets inside
 * Claude). The vault's MCP App surface (packages/vault/src/mcp-app.ts) lists an applet only when the person approved
 * its exact code: an approval is a Nostr event in their vault, signed on their device (the app's
 * docs/design/APP-RECORD.md "Running needs a signed approval"). Anyone who can write the vault can write an event, so
 * what makes one count is who signed it, and that has to come from somewhere a vault writer can't reach: the keys this
 * hub linked to the person (`user_pubkeys`: the linkage ceremony, a NIP-98 sign-in, or the operator), never a record.
 *
 * Bearer: any access token this hub signed and hasn't revoked, with a `sub` (the vault forwards the caller's own, as
 * manage-token does). Answers that subject's own keys, nothing else: `{keys: ["<64-hex>", …]}`, `no-store`. A token
 * without a subject, or one that doesn't validate: 401. Read-only; no scope is needed beyond being the person, since
 * the answer is their own public keys.
 */
import type { Database } from "bun:sqlite";
import { AdminAuthError, extractBearerToken } from "./admin-auth.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import { listUserPubkeys } from "./pubkey-links.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleApprovalKeys(req: Request, deps: { db: Database; knownIssuers: readonly string[] }): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed", error_type: "method_not_allowed", message: "GET only" });
  let sub: string | null;
  try {
    const validated = await validateAccessToken(deps.db, extractBearerToken(req), deps.knownIssuers);
    sub = typeof validated.payload.sub === "string" && validated.payload.sub ? validated.payload.sub : null;
  } catch (err) {
    const message = err instanceof AdminAuthError || err instanceof Error ? err.message : "invalid token";
    return json(401, { error: "unauthorized", error_type: "unauthorized", message });
  }
  if (!sub) return json(401, { error: "unauthorized", error_type: "unauthorized", message: "the token names no person" });
  return json(200, { keys: listUserPubkeys(deps.db, sub).map((k) => k.pubkey) });
}
