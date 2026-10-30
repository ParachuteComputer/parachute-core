// A refresh carrying the resource the app saved under an earlier setup still renews, and grants no more.
//
// A consumer app replays the RFC 8707 `resource` it was authorized with on every refresh, perhaps months and several
// hub versions later. Before the fix (hub 53d327b, and v0.8 at ccc7729) a refresh checked `resource` like a code
// exchange (packages/hub/src/oauth-handlers.ts resolveTokenResourceAudience) and answered 400 invalid_target for any
// other scheme, host or vault; 0.7.6 and older never read it. On a friend's box taken over from 0.7.6 to v0.8 (10-29)
// two connectors authorized months earlier could not renew and signed out. Fixed in packages/hub
// (resolveRefreshAudience, resolveRefreshResource): an unmatched resource is ignored and logged, the grant's own
// audience kept. Mutants "refresh-refuses-unmatched-resource" and "refresh-resource-outside-grant" put the bug back,
// or widen the fix.
//
// Candidate only (safety/): today's pinned hub has the strict check.
import { test, expect } from "bun:test";
import { mcp, runId, safeFetch, services } from "../lib.ts";
import { connect, MCP_URL } from "../oauth.ts";

const s = services();

test("a refresh carrying the resource the app saved under an earlier setup still renews, and grants no more", async () => {
  // A consumer app replays the `resource` it was authorized with on every refresh, perhaps months and several hub
  // versions later. Vaults of mid-2026 built that value from the request (`x-forwarded-proto || "https"` +
  // `x-forwarded-host`, else the request's own origin), so behind a tunnel an app may hold the http:// twin of the
  // MCP URL, or the vault's own loopback origin. 0.7.x never read `resource` on refresh; a hub that refuses it
  // leaves the app unable to renew, and the app signs the person out (a friend's box, 10-29: two connectors).
  const own = await connect({ appName: `Saved-resource app ${runId("app")}` });
  const mcpPath = new URL(MCP_URL).pathname;
  const twin = new URL(MCP_URL);
  twin.protocol = twin.protocol === "https:" ? "http:" : "https:";
  const shapes = [
    twin.toString(),
    `${new URL(s.vaultDirect).origin}${mcpPath}`,
    `http://localhost:${new URL(s.hub).port || "80"}${mcpPath}`,
    `https://an-old-name.example${mcpPath}`,
    `${new URL(s.hub).origin}/vault/${s.vaultName}-not-granted/mcp`,
  ];
  let refresh = own.refresh!;
  for (const resource of shapes) {
    const r = await safeFetch(own.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: own.clientId, resource }),
    });
    const body = await r.json();
    expect({ resource, status: r.status, error: body.error }).toEqual({ resource, status: 200, error: undefined });
    // The renewed grant is the one the person approved: same scopes, this vault only.
    expect(body.scope).toBe(own.scope);
    refresh = body.refresh_token;
    const c = await mcp(MCP_URL, body.access_token);
    try {
      expect(await c.tools()).toContain("query-notes");
    } finally {
      await c.close();
    }
  }
});
