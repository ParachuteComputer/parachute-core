// One way to refuse (T-476, approved by Aaron 11-24): every refusal of a tool call, on the vault door and on the
// account door, is a normal result with `isError: true` and `structuredContent {error_type, message, ...}`, its one text
// block that object as JSON. Never a JSON-RPC error (a host that turns those into its own generic error loses the
// vault's words), and never a reply that looks like data (`{error, error_type}` could be taken for a record).
// Only the protocol's own errors (bad JSON, an unknown method) stay JSON-RPC errors.
import { describe, expect, test } from "bun:test";
import { accountToken, door, fp, lacks, mcp, runId, safeFetch, token } from "./_door.ts";

/** A raw tools/call, so a JSON-RPC error can't hide behind the SDK's throw. */
async function call(url: string, bearer: string, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await safeFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  const data = text.trim().startsWith("{") ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? "null");
  return JSON.parse(data);
}

/** The one shape, checked whole; what the refusal said, for the fingerprint (unless `print` is false). */
function oneShape(label: string, body: any, type: string, print = true) {
  expect({ label, rpcError: body?.error ?? null }).toEqual({ label, rpcError: null });
  const r = body.result;
  expect({ label, isError: r?.isError }).toEqual({ label, isError: true });
  const sc = r.structuredContent;
  expect({ label, type: sc?.error_type }).toEqual({ label, type });
  expect(typeof sc.message).toBe("string");
  expect(sc.message.length).toBeGreaterThan(0);
  expect(sc.message).not.toMatch(/^(MCP error|\[)/); // the words alone: the type is beside them
  expect(r.content).toHaveLength(1);
  expect(r.content[0].type).toBe("text");
  expect(JSON.parse(r.content[0].text)).toEqual(sc);
  // T-476: every refusal names the page with its fix, for the version this door runs
  expect({ label, docs: typeof sc.docs === "string" && /^https?:\/\/\S+\/docs\/(v\/\d+\.\d+\/)?fix\/[a-z-]+\/(#[a-z0-9_-]+)?$/.test(sc.docs) }).toEqual({ label, docs: true });
  if (print) fp(`refusals/${label}`, { type: sc.error_type, keys: Object.keys(sc).sort() });
  return sc;
}

/** A raw tools/call on a 2026-07-28 connection (per-request `_meta` envelope): core's second door, mcp-modern.ts. */
const MODERN = "2026-07-28";
async function modernCall(url: string, bearer: string, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await safeFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "parachute-door-contracts", version: "0" },
        },
      },
    }),
  });
  const text = await r.text();
  return JSON.parse(text.trim().startsWith("{") ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? "null"));
}

describe("one way to refuse", () => {
  test("the vault door: a conflict, a blind write, a missing record, a taken path, a wrong parameter, an unknown tool", async () => {
    const url = `${door().vaultOrigin}/vault/${door().vault}/mcp`;
    const w = await token("write");
    const c = await mcp("write");
    try {
      const path = `${runId("refuse")}/one`;
      const made = await c.call("create-record", { path, body: "first" });
      await c.call("update-record", { id: made.id, body: "second", if_updated_at: made.updatedAt });
      const stale = await call(url, w, "update-record", { id: made.id, body: "third", if_updated_at: made.updatedAt });
      oneShape("conflict", stale, "conflict");
      // the record door speaks of records, and hands back what a writer needs to try again
      expect(stale.result.structuredContent.record_id).toBe(made.id);
      expect(stale.result.structuredContent.current_updated_at).toBeString();
      oneShape("blind-write", await call(url, w, "update-note", { id: path, content: "blind" }), "precondition_required");
      oneShape("missing-record", await call(url, w, "query-records", { id: `${path}-nope` }), "not_found");
      oneShape("missing-note", await call(url, w, "query-notes", { id: `${path}-nope` }), "not_found");
      oneShape("path-taken", await call(url, w, "create-record", { path, body: "again" }), "path_conflict");
      oneShape("unknown-parameter", await call(url, w, "query-records", { typo_param: 1 }), "unknown_parameter");
      oneShape("unknown-tool", await call(url, w, "no-such-tool", {}), "unknown_tool");
      // a tool above the caller's level is refused the same way as one that doesn't exist: nothing leaks
      const r = await call(url, await token("read"), "create-record", { path: `${path}-r`, body: "x" });
      const above = oneShape("above-level", r, "unknown_tool");
      // T-476: it says the caller's own level, in the same words for a tool that doesn't exist at all
      const none = oneShape("unknown-tool.reader", await call(url, await token("read"), "no-such-tool", {}), "unknown_tool", false);
      expect(above.message.replace("create-record", "<tool>")).toBe(none.message.replace("no-such-tool", "<tool>"));
      expect(above.message).toMatch(/can read; tools that write or need admin aren't listed/);
      expect(above.docs).toBe(none.docs);
      expect(above.docs).toMatch(/\/fix\/needs-admin\/#a-tool-it-cant-see$/);
      // the protocol's own errors stay JSON-RPC errors
      const bad = await safeFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${w}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "no/such-method" }),
      });
      const badText = await bad.text();
      const badBody = JSON.parse(badText.trim().startsWith("{") ? badText : ([...badText.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? "null"));
      expect(badBody.error?.code).toBe(-32601);
    } finally {
      await c.close();
    }
  });

  // The box's 2026-07-28 door is its own code (mcp-modern.ts, SDK v2) beside the 2025 one, and it is the door Claude
  // Code reaches for skills. It refuses as the 2025 door does, word for word. It comes with the Skills extension, so a
  // door without that (cloud's own 2026-07-28 handler, deliberate.json skills-extension) isn't asked here; the 2025
  // test above holds every door. No fingerprints: the 2025 door's are the record, and this one must equal them.
  test.skipIf(lacks("skills-extension"))("the vault door on a 2026-07-28 connection: the same refusals, the same words", async () => {
    const url = `${door().vaultOrigin}/vault/${door().vault}/mcp`;
    const w = await token("write");
    const c = await mcp("write");
    try {
      const path = `${runId("refuse-modern")}/one`;
      const made = await c.call("create-record", { path, body: "first" });
      await c.call("update-record", { id: made.id, body: "second", if_updated_at: made.updatedAt });
      const cases: [string, string, string, Record<string, unknown>, string][] = [
        ["conflict", w, "update-record", { id: made.id, body: "third", if_updated_at: made.updatedAt }, "conflict"],
        ["blind-write", w, "update-note", { id: path, content: "blind" }, "precondition_required"],
        ["missing-record", w, "query-records", { id: `${path}-nope` }, "not_found"],
        ["path-taken", w, "create-record", { path, body: "again" }, "path_conflict"],
        ["unknown-parameter", w, "query-records", { typo_param: 1 }, "unknown_parameter"],
        ["unknown-tool", w, "no-such-tool", {}, "unknown_tool"],
        ["above-level", await token("read"), "create-record", { path: `${path}-r`, body: "x" }, "unknown_tool"],
      ];
      for (const [label, bearer, name, args, type] of cases) {
        const body = await modernCall(url, bearer, name, args);
        // the 2026-07-28 codec stamps `resultType` on a result; the 2025 door never does, so this one was reached
        expect({ label, resultType: body?.result?.resultType }).toEqual({ label, resultType: "complete" });
        const modern = oneShape(`modern.${label}`, body, type, false);
        // the same refusal the 2025 door says, field for field (the conflict's tokens are the same record's)
        const old = (await call(url, bearer, name, args)).result?.structuredContent;
        expect({ label, modern }).toEqual({ label, modern: old });
      }
    } finally {
      await c.close();
    }
  });

  // The account door with the account credential: a cloud-style door's account door doesn't take it for tools yet
  // (deliberate.json multi-vault-door, as annotations.test.ts); its own refusals are held by its own tests there.
  test.skipIf(lacks("multi-vault-door"))("the account door: an unknown tool and a vault's refusal through it", async () => {
    const url = `${door().issuer}/account/mcp`;
    const bearer = await accountToken();
    oneShape("account.unknown-tool", await call(url, bearer, "no-such-tool", {}), "unknown_tool");
    // a vault's refusal comes through the account door as the vault said it
    const missing = await call(url, bearer, "query-records", { vault: door().vault, id: `${runId("refuse")}/nope` });
    const rows = missing.result?.isError ? null : JSON.parse(missing.result?.content?.[0]?.text ?? "null");
    if (rows?.results) {
      // the fan-out (query-records across vaults): each vault's refusal is its row, with the vault's own type
      const row = rows.results.find((x: any) => x.vault === door().vault);
      expect(row?.error_type).toBe("not_found");
      expect(typeof row?.error).toBe("string");
      fp("refusals/account.fan-out-row", Object.keys(row).sort());
    } else {
      oneShape("account.vault-refusal", missing, "not_found");
    }
  });
});
