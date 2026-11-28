// mcp/app: a vault's approved applets as an MCP App (T-476, approved by Aaron 11-24). Black box: the candidate's vault
// door over MCP, a throwaway Nostr key linked to the box's owner by the real CLI, approvals signed as the app signs them
// (kind 30479, one `d` tag; the app's docs/design/APP-RECORD.md) and written to the vault as the app writes them.
//
//   1. One tile per applet: each applet the person approved by code hash is its own tool `open-<id>`, with its own
//      `ui://parachute/applet/<id>` view and a global entry point; the view is text/html;profile=mcp-app with the
//      applet's record and code in it. Opening it answers one line for the model and the applet for the view.
//   2. Not offered: an applet nobody approved; one approved by a key the hub never linked to the person (anyone who
//      can write the vault can sign an event); one whose code changed after it was approved; one the person took back.
//   3. GET /api/approval-keys answers the caller's own linked keys, and nothing without a valid token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { hubCli } from "../../harness/services.ts";
import { nostrKey, signEvent } from "../compat/_lib.ts";
import { mcp, must, operator, pass, safeFetch, services } from "../lib.ts";

const s = services();
const person = nostrKey();
const stranger = nostrKey();
const tag = randomBytes(3).toString("hex");
const sha = (x: string) => createHash("sha256").update(x, "utf8").digest("hex");

/** An applet record as the app installs one (REST: the code's kind is its extension). */
async function putApplet(id: string, code: string) {
  const r = await operator().post("/notes", { path: `Applets/${id}`, content: code, extension: "tsx", tags: ["applet"], metadata: { applet: { contract: 2, id, name: `App ${id}`, glyph: "◇", access: [{ vault: "here", allow: [{ path: "Notes/", verbs: ["read"] }] }], screens: [{ id: "home", name: id }] } } });
  must(r.status === 201, `setup: applet ${id}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  made.push((r.body as { id: string }).id);
  return r.body as { id: string };
}
/** The approval the app's native signer writes (approve.rs), into `Parachute/Approvals/<host>/<vault>/<record>`. */
async function approve(key: { secret: string; pubkey: string }, record: string, applet: string, code: string, o: { approved?: boolean; n?: number } = {}) {
  const n = o.n ?? Math.floor(Date.now() / 1000) - 60;
  const subject = { hub: s.hub, vault: s.vaultName, record, applet };
  const content = { v: 1, subject, n, approved: o.approved ?? true, code: (o.approved ?? true) ? `tsx:${sha(code)}` : "", scope: "contract", at: new Date(n * 1000).toISOString(), expires: new Date(n * 1000 + 365 * 86_400_000).toISOString() };
  const ev = signEvent(key, { kind: 30479, created_at: n, tags: [["d", `${subject.hub}|${subject.vault}|${record}`]], content: JSON.stringify(content) });
  const r = await operator().post("/notes", { path: `Parachute/Approvals/${new URL(s.hub).host}/${s.vaultName}/${record}-${ev.id.slice(0, 8)}`, content: "", tags: ["parachute-approval"], metadata: { approval: ev } });
  must(r.status === 201, `setup: approval: ${r.status}`);
  made.push((r.body as { id: string }).id);
}

const ids = { ok: `ok${tag}`, none: `none${tag}`, strange: `strange${tag}`, changed: `changed${tag}`, back: `back${tag}` };
let reader: Awaited<ReturnType<typeof mcp>>;
/** What this file wrote: removed after, so the vault the other suites share lists no applet tools of ours. */
const made: string[] = [];
afterAll(async () => {
  await reader?.close();
  for (const id of made) await operator().del(`/notes/${id}`).catch(() => {});
});

beforeAll(async () => {
  await hubCli(s, ["auth", "link-pubkey", "--user", s.admin.username, person.pubkey]);
  const code = (id: string) => `export default function A() { return <p>${id}</p>; }`;
  const ok = await putApplet(ids.ok, code(ids.ok));
  await approve(person, ok.id, ids.ok, code(ids.ok));
  await putApplet(ids.none, code(ids.none));
  const strange = await putApplet(ids.strange, code(ids.strange));
  await approve(stranger, strange.id, ids.strange, code(ids.strange));
  const changed = await putApplet(ids.changed, code(ids.changed));
  await approve(person, changed.id, ids.changed, code(ids.changed));
  const c = await operator().patch(`/notes/${changed.id}`, { content: `${code(ids.changed)}\n// planted after the approval`, force: true });
  must(c.status === 200, `setup: change: ${c.status}`);
  const back = await putApplet(ids.back, code(ids.back));
  await approve(person, back.id, ids.back, code(ids.back), { n: Math.floor(Date.now() / 1000) - 120 });
  await approve(person, back.id, ids.back, code(ids.back), { approved: false });
  reader = await mcp(`${s.vaultViaHub}/mcp`, await pass({ level: "read" }));
});

describe("mcp/app: the person's approved applets as an MCP App", () => {
  test("one tile per approved applet: its own tool, its own ui:// view, a global entry point", async () => {
    const tools = (await reader.client.listTools()).tools as any[];
    const mine = tools.filter((t) => t.name.startsWith("open-") && t.name.endsWith(tag)).map((t) => t.name);
    expect(mine).toEqual([`open-${ids.ok}`]);
    const t = tools.find((x) => x.name === `open-${ids.ok}`);
    expect(t.title).toBe(`App ${ids.ok}`);
    expect(t._meta).toEqual({ ui: { resourceUri: `ui://parachute/applet/${ids.ok}` }, "ui/resourceUri": `ui://parachute/applet/${ids.ok}`, "openai/ui": { entrypoints: [{ type: "global" }] } });
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(t.inputSchema).toEqual({ type: "object", properties: {} });
  });

  // claude.ai connects on 2026-07-28 and declares MCP Apps in every request's `_meta` (claudereal, 11-25): that door
  // serves the same applets, beside the Skills extension's files.
  test("a 2026-07-28 connection, as claude.ai makes one: the same tiles, the same views, the same refusals", async () => {
    const bearer = await pass({ level: "read" });
    let id = 0;
    const modern = async (method: string, params: Record<string, unknown> = {}, name?: string) => {
      const r = await safeFetch(`${s.vaultViaHub}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
          "io.modelcontextprotocol/clientInfo": { name: "Anthropic/ClaudeAI", version: "1.0.0" },
        } } }),
      });
      return (await r.json()) as any;
    };
    const list = await modern("tools/list");
    expect(list.result.resultType).toBe("complete"); // the 2026-07-28 door answered, not the 2025 one
    const tools = list.result.tools as any[];
    expect(tools.filter((t) => t.name.startsWith("open-") && t.name.endsWith(tag)).map((t) => t.name)).toEqual([`open-${ids.ok}`]);
    expect(tools.find((t) => t.name === `open-${ids.ok}`)._meta.ui).toEqual({ resourceUri: `ui://parachute/applet/${ids.ok}` });
    const res = await modern("resources/list");
    expect((res.result.resources as any[]).filter((r) => r.uri.endsWith(tag)).map((r) => r.uri)).toEqual([`ui://parachute/applet/${ids.ok}`]);
    const read = await modern("resources/read", { uri: `ui://parachute/applet/${ids.ok}` }, `ui://parachute/applet/${ids.ok}`);
    expect(read.result.resultType).toBe("complete");
    const c = read.result.contents[0];
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(JSON.parse(/<script type="application\/json" id="parachute-applet">(.*?)<\/script>/s.exec(c.text)![1]!).code).toContain(ids.ok);
    for (const other of [ids.none, ids.strange, ids.changed, ids.back]) {
      const no = await modern("resources/read", { uri: `ui://parachute/applet/${other}` }, `ui://parachute/applet/${other}`);
      expect(no.error?.message ?? "").toMatch(/No resource/);
    }
    const opened = await modern("tools/call", { name: `open-${ids.ok}`, arguments: {} }, `open-${ids.ok}`);
    expect(opened.result.content).toEqual([{ type: "text", text: `Opened the applet "${ids.ok}" from the ${s.vaultName} vault.` }]);
    const refused = await modern("tools/call", { name: `open-${ids.none}`, arguments: {} }, `open-${ids.none}`);
    expect(refused.result.structuredContent?.error_type).toBe("unknown_tool");
  });

  test("its view is the applet host with this applet's record and code in it", async () => {
    const list = await reader.client.listResources();
    expect(list.resources.filter((r) => r.uri.endsWith(tag)).map((r) => r.uri)).toEqual([`ui://parachute/applet/${ids.ok}`]);
    const read = await reader.client.readResource({ uri: `ui://parachute/applet/${ids.ok}` });
    const c = read.contents[0] as any;
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    const payload = JSON.parse(/<script type="application\/json" id="parachute-applet">(.*?)<\/script>/s.exec(c.text)![1]!);
    expect(payload).toMatchObject({ v: 1, vault: s.vaultName, record: { extension: "tsx" }, approval: { code: `tsx:${sha(payload.code)}` } });
    expect(payload.code).toContain(ids.ok);
    for (const id of [ids.none, ids.strange, ids.changed, ids.back]) await expect(reader.client.readResource({ uri: `ui://parachute/applet/${id}` })).rejects.toThrow(/No resource/);
  });

  test("opening it: one line for the model, the applet for the view; the others are unknown tools", async () => {
    const r: any = await reader.client.callTool({ name: `open-${ids.ok}`, arguments: {} });
    expect(r.content).toEqual([{ type: "text", text: `Opened the applet "${ids.ok}" from the ${s.vaultName} vault.` }]);
    expect(r.structuredContent).toEqual({ vault: s.vaultName, applet: { id: ids.ok } });
    for (const id of [ids.none, ids.strange, ids.changed, ids.back]) {
      const no: any = await reader.client.callTool({ name: `open-${id}`, arguments: {} });
      expect(no.structuredContent?.error_type).toBe("unknown_tool");
    }
  });

  test("GET /api/approval-keys: the caller's own linked keys, nothing without a valid token", async () => {
    const r = await safeFetch(`${s.hub}/api/approval-keys`, { headers: { authorization: `Bearer ${await pass({ level: "read" })}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const keys = ((await r.json()) as { keys: string[] }).keys;
    expect(keys).toContain(person.pubkey);
    expect(keys).not.toContain(stranger.pubkey);
    expect((await safeFetch(`${s.hub}/api/approval-keys`)).status).toBe(401);
    expect((await safeFetch(`${s.hub}/api/approval-keys`, { headers: { authorization: "Bearer not-a-token" } })).status).toBe(401);
  });
});
