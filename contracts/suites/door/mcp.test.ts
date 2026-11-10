// Surface D: the vault over MCP. An AI app sees a tool list, each tool's description and input schema, and results.
// Those are the product for an AI client, so they are compared exactly: same tools, same words, same schemas.
import { describe, expect, test } from "bun:test";
import { door, fp, mcp, mcpUrl, runId, safeFetch, sha, shape, token } from "./_door.ts";

describe("the vault over MCP", () => {
  test("no credential: 401 that tells an app where to sign in", async () => {
    const cold = await safeFetch(mcpUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(cold.status).toBe(401);
    const www = cold.headers.get("www-authenticate") ?? "";
    const prm = www.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(prm).toBeString();
    fp("mcp/cold.challenge", www);
    const doc = await (await safeFetch(prm!)).json();
    expect(doc.resource).toBe(mcpUrl());
    fp("mcp/protected-resource", doc);
  });

  for (const level of ["read", "write", "admin"] as const) {
    test(`a ${level} credential sees the same tools, words and schemas at every door`, async () => {
      const c = await mcp(level);
      try {
        const tools = await c.tools();
        fp(`mcp/${level}.tools`, tools.map((t) => t.name));
        for (const t of tools) {
          fp(`mcp/${level}.tool.${t.name}.schema`, sha(t.inputSchema));
          fp(`mcp/${level}.tool.${t.name}.words`, sha(t.description ?? ""));
          fp(`mcp/${level}.tool.${t.name}.hints`, t.annotations ?? null);
        }
        const init: any = (c.client as any).getServerVersion?.() ?? null;
        fp(`mcp/${level}.server`, { name: init?.name ?? null, instructions: sha((c.client as any).getInstructions?.() ?? "") });
        fp(`mcp/${level}.capabilities`, Object.keys((c.client as any).getServerCapabilities?.() ?? {}).sort());
      } finally {
        await c.close();
      }
    });
  }

  test("an app writes, finds, reads and updates a note with tools", async () => {
    const c = await mcp("write");
    try {
      const r = runId("mcp");
      const made = await c.call("create-note", { path: `${r}/one`, content: `hello ${r}`, tags: ["mcp-made"], metadata: { n: 1 } });
      expect(made.id ?? made.note?.id).toBeString();
      fp("mcp/create-note.result.shape", shape(made));
      const found = await c.call("query-notes", { search: r });
      fp("mcp/query-notes.result.shape", shape(found));
      expect(JSON.stringify(found)).toContain(`${r}/one`);
      const one = await c.call("query-notes", { id: `${r}/one` });
      expect(JSON.stringify(one)).toContain(`hello ${r}`);
      const seen = one.updatedAt ?? one.note?.updatedAt ?? one.notes?.[0]?.updatedAt;
      const up = await c.call("update-note", { id: `${r}/one`, content: `again ${r}`, if_updated_at: seen });
      fp("mcp/update-note.result.shape", shape(up));
      const blind = await c.call("update-note", { id: `${r}/one`, content: "blind" }).then(() => "accepted", (e) => String(e.message).replace(new RegExp(r, "g"), "<r>").slice(0, 60));
      fp("mcp/update-note.blind", blind);
      const info = await c.call("vault-info", {});
      fp("mcp/vault-info.result.keys", Object.keys(info).sort());
      const tags = await c.call("list-tags", {});
      fp("mcp/list-tags.result.shape", shape(Array.isArray(tags) ? tags.slice(0, 1) : tags));
    } finally {
      await c.close();
    }
  });

  test("a read credential is refused a write tool the same way", async () => {
    const c = await mcp("read");
    try {
      const out = await c.call("create-note", { path: `${runId("mcp")}/no`, content: "no" }).then(
        () => "accepted",
        (e) => (/not found|unknown tool/i.test(e.message) ? "no such tool" : /scope|permission|forbidden|not allowed|requires/i.test(e.message) ? "refused" : `other: ${e.message.slice(0, 80)}`),
      );
      expect(out).not.toBe("accepted");
      fp("mcp/read-calls-write-tool", out);
    } finally {
      await c.close();
    }
  });

  test("the root /mcp finds the vault from the credential", async () => {
    const d = door();
    const url = `${d.vaultOrigin}/mcp`;
    const cold = await safeFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    fp("mcp/root.cold", { status: cold.status, challenge: (cold.headers.get("www-authenticate") ?? "").replace(/"[^"]*"/g, '"…"') });
    const c = await mcp("read", { url, bearer: await token("read") }).catch((e) => e as Error);
    if (c instanceof Error) {
      fp("mcp/root.connect", `refused: ${c.message.slice(0, 60)}`);
      return;
    }
    try {
      fp("mcp/root.connect", "connected");
      fp("mcp/root.tools", (await c.tools()).map((t) => t.name));
    } finally {
      await c.close();
    }
  });

  test("a credential for one vault is refused at another vault's MCP", async () => {
    const d = door();
    const r = await safeFetch(mcpUrl(d.otherVault), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await token("read")}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect([401, 403]).toContain(r.status);
    fp("mcp/other-vault", { status: r.status });
  });
});
