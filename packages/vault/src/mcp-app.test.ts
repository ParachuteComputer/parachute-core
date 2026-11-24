/**
 * T-476 spike: the door serves a vault's applets as an MCP App (mcp-app.ts) when it has a view to serve, and answers
 * exactly as before when it hasn't. Real tools on a real (in-memory) vault; only the view's HTML is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcp } from "./mcp-http.ts";
import { generateMcpTools } from "../core/src/mcp.ts";
import { shapeRecordSurface } from "../core/src/mcp-surface.ts";
import { SqliteStore } from "../core/src/store.ts";
import { APPLET_HOST_URI, MCP_APP_MIME } from "./mcp-app.ts";
import type { AuthResult } from "./auth.ts";

const auth = (verbs: string[]): AuthResult => ({
  permission: verbs.includes("write") ? "full" : "read",
  scopes: verbs.map((v) => `vault:v:${v}`),
  legacyDerived: false,
  scoped_tags: null,
  vault_name: null,
  caller_jti: null,
  actor: "test-user",
  via: "api",
} as AuthResult);

const store = new SqliteStore(new Database(":memory:"));
const tools = () => shapeRecordSurface(generateMcpTools(store), { db: store.db, vaultName: "v" });
let dir = "";
const VIEW = "<!doctype html><title>stand-in view</title>";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "inclaude-t476-mcp-app-"));
  writeFileSync(join(dir, "applet-host.html"), VIEW);
  const create = tools().find((t) => t.name === "create-record")!;
  await create.execute({ records: [
    { path: "Applets/People", body: "export default () => null", tags: ["applet"], fields: { applet: { id: "people", name: "People", glyph: "☺" } } },
    { path: "Applets/Library", body: "export default () => null", tags: ["applet"], fields: { applet: { id: "library", name: "Library" } } },
    { path: "Notes/Not an applet", body: "", tags: ["applet"] },
  ] });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PARACHUTE_APPLET_HOST_HTML; });

async function rpc(method: string, params: Record<string, unknown> = {}, verbs = ["read", "write"]) {
  const req = new Request("http://localhost/vault/v/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await handleMcp(req, tools, "parachute-vault/v", "v", auth(verbs), "")).json() as Promise<any>;
}

describe("with a view to serve", () => {
  beforeAll(() => { process.env.PARACHUTE_APPLET_HOST_HTML = join(dir, "applet-host.html"); });

  test("tools/list offers open-applet with its view and a global entry point", async () => {
    const t = (await rpc("tools/list")).result.tools.find((x: any) => x.name === "open-applet");
    expect(t._meta.ui.resourceUri).toBe(APPLET_HOST_URI);
    expect(t._meta["openai/ui"].entrypoints).toEqual([{ type: "global" }]);
    expect(t.title).toBe("Parachute");
    expect(t.annotations.readOnlyHint).toBe(true);
    // Claude refuses to open a tool whose name has __, .., ._ or _.
    expect(t.name).not.toMatch(/__|\.\.|\._|_\./);
  });

  test("a read-only key sees it too: opening reads, and the view's writes stay at the key's level", async () => {
    const names = (await rpc("tools/list", {}, ["read"])).result.tools.map((x: any) => x.name);
    expect(names).toContain("open-applet");
    expect(names).not.toContain("update-record");
  });

  test("resources/read gives the view as an MCP App", async () => {
    const r = (await rpc("resources/read", { uri: APPLET_HOST_URI })).result.contents[0];
    expect(r).toMatchObject({ uri: APPLET_HOST_URI, mimeType: MCP_APP_MIME, text: VIEW });
    expect((await rpc("resources/list")).result.resources.map((x: any) => x.uri)).toEqual([APPLET_HOST_URI]);
    expect((await rpc("resources/read", { uri: "ui://parachute/other" })).error).toBeDefined();
  });

  test("open-applet with nothing (an entry point sends {}) lists the applets; the model gets one line", async () => {
    const r = (await rpc("tools/call", { name: "open-applet", arguments: {} })).result;
    expect(r.structuredContent.applets.map((a: any) => a.name)).toEqual(["Library", "People"]);
    expect(r.structuredContent.open).toBeNull();
    expect(r.content).toEqual([{ type: "text", text: "Showing v's applets: Library, People." }]);
  });

  test("open-applet by name opens that one", async () => {
    const r = (await rpc("tools/call", { name: "open-applet", arguments: { applet: "people" } })).result;
    expect(r.structuredContent.open).toBe("Applets/People");
    expect(r.content[0].text).toBe("Opened People from the v vault.");
  });
});

describe("without a view", () => {
  beforeAll(() => { delete process.env.PARACHUTE_APPLET_HOST_HTML; });

  test("the door answers as before: no open-applet, no resources", async () => {
    const names = (await rpc("tools/list")).result.tools.map((x: any) => x.name);
    expect(names).not.toContain("open-applet");
    expect((await rpc("resources/list")).error.code).toBe(-32601);
  });
});
