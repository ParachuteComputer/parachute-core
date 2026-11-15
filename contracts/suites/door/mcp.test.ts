// Surface D: the vault over MCP. An AI app sees a tool list, each tool's description and input schema, and results.
// Those are the product for an AI client, so they are compared exactly: same tools, same words, same schemas.
import { describe, expect, test } from "bun:test";
import { door, fp, fpEach, mcp, mcpUrl, neutral, runId, safeFetch, sha, shape, token } from "./_door.ts";

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
    fpEach("mcp/protected-resource", doc);
    // RFC 9728 allows the document at either address; a client may build either. Both must answer, the same.
    const d = door();
    for (const [form, url] of [
      ["well-known-first", `${d.vaultOrigin}/.well-known/oauth-protected-resource/vault/${d.vault}/mcp`],
      ["vault-first", `${d.vaultOrigin}/vault/${d.vault}/.well-known/oauth-protected-resource`],
    ] as const) {
      const r = await safeFetch(url);
      fp(`mcp/protected-resource.at.${form}`, { status: r.status, same: r.status === 200 ? JSON.stringify(await r.json()) === JSON.stringify(doc) : false });
    }
  });

  for (const level of ["read", "write", "admin"] as const) {
    test(`a ${level} credential sees the same tools, words and schemas at every door`, async () => {
      const c = await mcp(level);
      try {
        const tools = await c.tools();
        // One fact per tool, so a door that lacks one tool is exactly one named difference.
        fp(`mcp/${level}.tool-count`, tools.length);
        for (const t of tools) {
          fp(`mcp/${level}.tool.${t.name}.present`, true);
          fp(`mcp/${level}.tool.${t.name}.schema`, sha(t.inputSchema));
          fp(`mcp/${level}.tool.${t.name}.words`, sha(String(neutral(t.description ?? ""))));
          fp(`mcp/${level}.tool.${t.name}.hints`, t.annotations ?? null);
        }
        const init: any = (c.client as any).getServerVersion?.() ?? null;
        fp(`mcp/${level}.server.name`, init?.name ?? null);
        // The instructions orient a model the moment it connects. They hold the vault's own counts and names, so
        // they are compared by what they cover (their section headings), not byte for byte.
        const instructions: string = (c.client as any).getInstructions?.() ?? "";
        fp(`mcp/${level}.instructions.sections`, instructions.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim()));
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
      // A refused call: the JSON-RPC code and the structured `data` are what an app branches on; the message is
      // for the model. The message's lead-in is recorded apart, since doors may word it differently.
      const blind: any = await c.client.callTool({ name: "update-note", arguments: { id: `${r}/one`, content: "blind" } }).then(() => null, (e) => e);
      expect(blind).toBeTruthy();
      fp("mcp/refusal.blind-update", { code: blind.code ?? null, type: blind.data?.error_type ?? null, keys: Object.keys(blind.data ?? {}).sort(), hint: blind.data?.hint ? sha(blind.data.hint) : null });
      fp("mcp/refusal.message-names-its-type", /\[precondition_required\]/.test(String(blind.message)));
      const dup: any = await c.client.callTool({ name: "create-note", arguments: { path: `${r}/one`, content: "dup" } }).then(() => null, (e) => e);
      fp("mcp/refusal.path-taken", { code: dup?.code ?? null, type: dup?.data?.error_type ?? null, keys: Object.keys(dup?.data ?? {}).sort() });
      const none: any = await c.client.callTool({ name: "query-notes", arguments: { id: `${r}/nope` } });
      fp("mcp/query-notes.no-such-note", { isError: none.isError ?? false, shape: shape(JSON.parse(none.content?.[0]?.text ?? "null")) });
      const info = await c.call("vault-info", {});
      fp("mcp/vault-info.result.keys", Object.keys(info).sort());
      const tags = await c.call("list-tags", {});
      // This run's own tag, so the shape doesn't depend on which other tags the vault holds by now.
      const mine = (Array.isArray(tags) ? tags : (tags.tags ?? [])).find((t: any) => t.name === "mcp-made");
      expect(mine).toBeTruthy();
      fp("mcp/list-tags.result.envelope", Array.isArray(tags) ? "array" : Object.keys(tags).sort());
      fp("mcp/list-tags.item.shape", shape(mine));
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
      fp("mcp/root.same-tools-as-the-vault", JSON.stringify((await c.tools()).map((t) => t.name)) === JSON.stringify(await (async () => { const v = await mcp("read"); try { return (await v.tools()).map((t) => t.name); } finally { await v.close(); } })()));
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
