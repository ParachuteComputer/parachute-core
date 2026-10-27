// The consumer connector: someone whose only AI is a consumer app (the Claude app, ChatGPT, a Dots-like app) adds
// their vault as a connector, and the app reads and writes it over MCP. This is a first-class path, so it is
// tested end to end through the same doors the app uses, starting from nothing but the vault's MCP URL:
//
//   MCP 401 → protected-resource metadata → authorization-server metadata → dynamic client registration →
//   the person signs in and approves → code + PKCE → token → MCP: list tools, write, read, search, update →
//   refresh the token → keep working.
//
// The hub's own e2e/mcp-probe.ts walks the same flow; this contract adds discovery from a cold start, an outside
// redirect URI (the app's, not the hub's), the official MCP SDK client, and the checks a person relies on.
import { describe, expect, test } from "bun:test";
import { mcp, operator, runId, services } from "../lib.ts";
import { connect, MCP_URL, type Connected } from "../oauth.ts";

const s = services();

describe("consumer connector: a consumer AI app connects to a person's vault over MCP", () => {
  let app: Connected;

  // The other tests in this file use the connection this one makes (bun runs a file's tests in order).
  test("the app connects from nothing but the MCP URL and the person's approval", async () => {
    app = await connect({ appName: `Consumer app ${runId("app")}` });
    expect(app.access.split(".").length).toBe(3);
    expect(app.scope).toContain(`vault:${s.vaultName}:write`);
  });

  test("the app sees the tools it needs: read, write, search", async () => {
    const c = await mcp(MCP_URL, app.access);
    try {
      const tools = await c.tools();
      for (const t of ["create-note", "query-notes", "update-note", "list-tags"]) expect(tools).toContain(t);
      // Approving an app for read and write doesn't hand it the vault's admin tools.
      expect(tools).not.toContain("delete-tag");
    } finally {
      await c.close();
    }
  });

  test("the app writes a note, finds it by search, reads it, and updates it", async () => {
    const word = `zq${runId("w").replace(/[^a-z0-9]/g, "")}`;
    const c = await mcp(MCP_URL, app.access);
    try {
      const made = await c.call("create-note", {
        content: `Groceries for ${word}: oats, lemons`,
        path: `${runId("consumer")}/groceries`,
        tags: ["list"],
        metadata: { store: "corner shop" },
      });
      const id = made.id ?? made.note?.id ?? made.notes?.[0]?.id;
      expect(id).toBeString();

      const found = await c.call("query-notes", { search: word });
      const list = Array.isArray(found) ? found : (found.notes ?? found.results ?? []);
      expect(list.map((n: any) => n.id)).toEqual([id]);

      const one = await c.call("query-notes", { id });
      const note = Array.isArray(one) ? one[0] : (one.note ?? one.notes?.[0] ?? one);
      expect(note.content).toContain("oats, lemons");
      expect(note.metadata.store).toBe("corner shop");

      await c.call("update-note", { id, append: "\n- bread", if_updated_at: note.updatedAt });
      const after = await operator().get(`/notes/${id}`);
      expect(after.body.content).toEndWith("- bread");
    } finally {
      await c.close();
    }
  });

  test("what the app writes is the person's vault: other clients see it at once", async () => {
    const path = `${runId("consumer")}/shared`;
    const c = await mcp(MCP_URL, app.access);
    try {
      await c.call("create-note", { content: "written by the app", path });
    } finally {
      await c.close();
    }
    const seen = await operator().get(`/notes/${encodeURIComponent(path)}`);
    expect(seen.status).toBe(200);
    expect(seen.body.content).toBe("written by the app");
  });

  test("the app keeps working after its access token is refreshed", async () => {
    expect(app.refresh).toBeString();
    const r = await fetch(app.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.refresh!, client_id: app.clientId }),
    });
    expect(r.status).toBe(200);
    const fresh = await r.json();
    expect(fresh.access_token).not.toBe(app.access);
    const c = await mcp(MCP_URL, fresh.access_token);
    try {
      expect(await c.tools()).toContain("query-notes");
    } finally {
      await c.close();
    }
  });

  test(
    "a used refresh token is dead once the 30-second retry window has passed, and replaying it ends the session",
    async () => {
      // Today's door keeps a one-generation grace window for retried refreshes (hub#685, REFRESH_GRACE_MS = 30 s
      // in hub packages/door-contract/src/tokens.ts). Outside it, a replay is treated as theft (RFC 6819 §5.2.2.3).
      const own = await connect({ appName: `Refresh app ${runId("app")}` });
      const refresh = (token: string) =>
        fetch(own.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: own.clientId }),
        });
      const first = await refresh(own.refresh!);
      expect(first.status).toBe(200);
      const next = await first.json();
      await Bun.sleep(31_000);
      const replay = await refresh(own.refresh!);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
      // The whole family is revoked: the refresh token handed out after the old one no longer works either.
      expect((await refresh(next.refresh_token)).status).toBe(400);
    },
    60_000,
  );

  test("an app approved to read only cannot write", async () => {
    const reader = await connect({ appName: `Reader app ${runId("app")}`, scope: (v) => `vault:${v}:read` });
    expect(reader.scope).not.toContain(":write");
    const c = await mcp(MCP_URL, reader.access);
    try {
      expect(await c.tools()).not.toContain("create-note");
      await expect(c.call("create-note", { content: "x", path: `${runId("consumer")}/nope` })).rejects.toThrow();
    } finally {
      await c.close();
    }
  });

  test("a made-up or tampered token gets nothing", async () => {
    const [h, p, sig] = app.access.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, scope: `${claims.scope} vault:${s.vaultName}:admin` })).toString("base64url")}.${sig}`;
    for (const bad of [forged, "not-a-token"]) {
      const r = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bad}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(r.status).toBe(401);
    }
  });
});
