import { enterSandbox } from "../sandbox.ts";
await enterSandbox();
const { startWorkersDoor, signUp } = await import("./workers.ts");
const { startBoxDoor } = await import("./box.ts");
const { loadCandidate, prepareInfo } = await import("../candidate.ts");
const { safeFetch } = await import("../guard.ts");
const { writeFileSync } = await import("node:fs");
const out: Record<string, any> = {};
async function probe(label: string, issuer: string, vaultOrigin: string, vault: string, s: { cookie: string; csrf: string }) {
  const at = (await (await safeFetch(`${issuer}/account/token`, { method: "POST", headers: { "content-type": "application/json", origin: issuer, cookie: s.cookie }, body: JSON.stringify({ __csrf: s.csrf }) })).json()).token;
  const H = { authorization: `Bearer ${at}`, "content-type": "application/json" };
  await safeFetch(`${issuer}/account/vaults`, { method: "POST", headers: H, body: JSON.stringify({ name: vault }) });
  const tok = (await (await safeFetch(`${issuer}/account/vaults/${vault}/token`, { method: "POST", headers: H, body: JSON.stringify({ scopes: [`vault:${vault}:read`, `vault:${vault}:write`, `vault:${vault}:admin`] }) })).json()).vault_token;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "dbg", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${vaultOrigin}/vault/${vault}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } }, fetch: safeFetch }));
  const made: any = await client.callTool({ name: "create-note", arguments: { path: "dbg/one", content: "x" } });
  const blind: any = await client.callTool({ name: "update-note", arguments: { id: "dbg/one", content: "y" } }).catch((e) => ({ thrown: String(e.message), code: e.code, data: e.data }));
  const missing: any = await client.callTool({ name: "query-notes", arguments: { id: "dbg/nope" } }).catch((e) => ({ thrown: String(e.message), code: e.code, data: e.data }));
  const badtag: any = await client.callTool({ name: "create-note", arguments: { path: "dbg/one", content: "dup" } }).catch((e) => ({ thrown: String(e.message), code: e.code, data: e.data }));
  out[label] = { instructions: client.getInstructions(), server: client.getServerVersion(), blind, missing, badtag, made: made.content?.[0]?.text?.slice(0, 200) };
  await client.close();
}
const dir = process.env.CANDIDATE_DIR!;
const { manifest, sha256 } = await loadCandidate(dir);
const box = await startBoxDoor(prepareInfo(dir, manifest, sha256));
const w = await startWorkersDoor({ repo: process.env.CLOUD_REPO!, scratch: "/tmp/dbg", label: "dbg" });
try {
  await probe("cloud", w.issuer, w.vaultOrigin, "dbgv", await signUp(w.issuer));
  await probe("box", box.issuer, box.vaultOrigin, "dbgv", box.session);
} finally { await w.stop(); await box.running.stop(); }
writeFileSync(`${process.env.OUT}/mcp-probe.json`, JSON.stringify(out, null, 1));
process.exit(0);
