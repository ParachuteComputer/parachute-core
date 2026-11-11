// safety/on-behalf: the write stamp (ROADMAP 0.9.1 "Keys by name; the write stamp"; T-446). Every write records
// two facts: **via**, the key that made it, taken from the signed token and never from the request; **by**, the
// person it was for. A key may set "by" only when the vault's owner gave it the on-behalf-of permission at mint
// (`POST /account/keys {..., on_behalf_of: true}`), and then only as `<its own name>:<id>`: the request supplies the
// id, the prefix comes from the token. Without the permission a supplied value is refused, never ignored, so a
// service that believes it is stamping can't write unstamped. On-behalf-of never opens anything.
// Black box: HTTP and MCP to the candidate's hub, with the owner signed in by a throwaway Nostr key.
// Red on the base (uni/t442-records-rest): no `on_behalf_of` at mint, the header and parameter are ignored, and a
// key's writes say `api` / `mcp`.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { hubCli } from "../../harness/services.ts";
import { nip98, nostrKey } from "../compat/_lib.ts";
import { mcp, must, rest, safeFetch, services } from "../lib.ts";
import { resign, resignClaims } from "./_lib.ts";

const s = services();
const owner = nostrKey(); // throwaway; linked to the box's owner below
const id = () => randomBytes(3).toString("hex");
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const HEADER = "Parachute-On-Behalf-Of";

async function call(path: string, init: { method?: string; auth?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const r = await safeFetch(`${s.hub}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.auth ? { authorization: init.auth } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body: parsed, text };
}

let account = "";
const mintKey = (body: Record<string, unknown>) => call("/account/keys", { method: "POST", auth: `Bearer ${account}`, body });
const api = (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  call(`/vault/${s.vaultName}/api${path}`, { method, auth: `Bearer ${token}`, body, headers });
const reader = () => rest(`${s.hub}/vault/${s.vaultName}`, readToken);
const record = async (path: string) => (await reader().get(`/notes/${encodeURIComponent(path)}`));
const mcpUrl = () => `${s.hub}/vault/${s.vaultName}/mcp`;

let readToken = "";
let granted = { name: "", token: "" }; // a write key with the on-behalf-of permission
let plain = { name: "", token: "" }; // a write key without it

beforeAll(async () => {
  await hubCli(s, ["auth", "link-pubkey", "--user", s.admin.username, owner.pubkey]);
  const r = await call("/account/token", { method: "POST", auth: nip98(owner, `${s.hub}/account/token`, "POST") });
  must(r.status === 200 && typeof r.body?.token === "string", `NIP-98 sign-in: ${r.status} ${r.text.slice(0, 200)}`);
  account = r.body.token;
  const g = await mintKey({ name: `fernhill-${id()}`, vault: s.vaultName, can: "write", on_behalf_of: true });
  must(g.status === 201, `minting a key with on_behalf_of: ${g.status} ${g.text.slice(0, 300)}`);
  granted = { name: g.body.name, token: g.body.token };
  const p = await mintKey({ name: `plain-${id()}`, vault: s.vaultName, can: "write" });
  must(p.status === 201, `minting a plain key: ${p.status} ${p.text.slice(0, 200)}`);
  plain = { name: p.body.name, token: p.body.token };
  const rd = await mintKey({ name: `reader-${id()}`, vault: s.vaultName, can: "read" });
  must(rd.status === 201, `minting a read key: ${rd.status}`);
  readToken = rd.body.token;
});

describe("safety/on-behalf: the grant", () => {
  test("the owner grants it at mint; the token carries its name and acts_for = that name, and the list says so", async () => {
    const c = claims(granted.token);
    expect(c.permissions?.acts_for).toBe(granted.name);
    expect(c.key).toEqual({ name: granted.name, kind: "app" });
    expect(claims(plain.token).key).toEqual({ name: plain.name, kind: "app" });
    expect(claims(plain.token).permissions?.acts_for).toBeUndefined();
    const listed = (await call("/account/keys", { auth: `Bearer ${account}` })).body.keys as any[];
    expect(listed.find((k) => k.name === granted.name)?.on_behalf_of).toBe(true);
    expect(listed.find((k) => k.name === plain.name)?.on_behalf_of).toBeUndefined();
  });

  test("a reserved or uppercase key name, or one outside the prefix alphabet, can't get the grant", async () => {
    for (const name of ["surface", `Fernhill-${id()}`, `under_score-${id()}`]) {
      const r = await mintKey({ name, vault: s.vaultName, can: "write", on_behalf_of: true });
      expect(r.status, name).toBe(400);
      expect(r.body.error, name).toBe("invalid_name");
      expect(r.body.message, name).toContain("on behalf");
    }
    expect((await mintKey({ name: `nb-${id()}`, vault: s.vaultName, can: "write", on_behalf_of: "yes" })).status).toBe(400);
  });

  test("an app key can't mint a key, grant itself the permission, or widen what it carries", async () => {
    const self = await call("/account/keys", { method: "POST", auth: `Bearer ${plain.token}`, body: { name: `x-${id()}`, vault: s.vaultName, can: "write", on_behalf_of: true } });
    expect([401, 403]).toContain(self.status);
    for (const permissions of [{ acts_for: plain.name }, { key: { name: granted.name, kind: "app" } }, { acts_for: "unforced.dev" }]) {
      const r = await call("/api/auth/mint-token", { method: "POST", auth: `Bearer ${plain.token}`, body: { scope: `vault:${s.vaultName}:read`, permissions } });
      expect([400, 403], JSON.stringify(permissions)).toContain(r.status);
    }
  });

  test("a named key that may mint passes on its name and prefix: what it mints can't shed, change or ask for them", async () => {
    // A CLI key (`parachute keys new <name> --on-behalf-of` runs this mint) with admin on the vault, so it may mint.
    const name = `portal-${id()}`;
    const out = await hubCli(s, ["auth", "mint-token", "--scope", ["read", "write", "admin"].map((l) => `vault:${s.vaultName}:${l}`).join(" "), "--label", name, "--on-behalf-of", "--user", s.admin.username, "--ephemeral"]);
    const minter = out.trim().split("\n").pop()!.trim();
    expect(claims(minter)).toMatchObject({ key: { name, kind: "person" }, permissions: { acts_for: name } });
    const mint = (body: Record<string, unknown>) => call("/api/auth/mint-token", { method: "POST", auth: `Bearer ${minter}`, body: { scope: `vault:${s.vaultName}:write`, ...body } });
    const child = await mint({});
    expect(child.status, child.text.slice(0, 200)).toBe(200);
    expect(claims(child.body.token)).toMatchObject({ key: { name, kind: "person" }, permissions: { acts_for: name } });
    expect((await mint({ permissions: { acts_for: "unforced.dev" } })).status).toBe(400);
    expect((await mint({ permissions: { key: { name: "other", kind: "app" } } })).status).toBe(400);
    expect((await mint({ name: `renamed-${id()}` })).status).toBe(400);
    // Nor can it name a signer: a signing key's `via` (nostr:<pubkey>) would hide the key's own name.
    expect((await mint({ permissions: { principal_pubkey: "ab".repeat(32) } })).status).toBe(400);
    // Its child stamps the same way: by <name>:<id>, via key:<name>.
    const path = `onbehalf/child/${id()}`;
    expect((await api(child.body.token, "POST", "/notes", { content: "via the child", path }, { [HEADER]: "client-7" })).status).toBe(201);
    expect((await record(path)).body).toMatchObject({ createdBy: `${name}:client-7`, createdVia: `key:${name}` });
  });

  test("a read key with the grant still can't write", async () => {
    const r = await mintKey({ name: `readonly-${id()}`, vault: s.vaultName, can: "read", on_behalf_of: true });
    expect(r.status).toBe(201);
    const path = `onbehalf/read/${id()}`;
    expect((await api(r.body.token, "POST", "/notes", { content: "no", path }, { [HEADER]: "client-42" })).status).toBe(403);
    expect((await record(path)).status).toBe(404);
  });

  test("a token whose permissions hold a key the vault doesn't know is refused", async () => {
    const forged = resign(granted.token, { ...claims(granted.token).permissions, write_as: "anyone" });
    expect((await api(forged, "GET", "/notes?limit=1")).status).toBe(401);
    // A malformed or reserved prefix in a signed token fails closed too.
    const reserved = resign(granted.token, { ...claims(granted.token).permissions, acts_for: "nostr" });
    expect((await api(reserved, "GET", "/notes?limit=1")).status).toBe(401);
    expect((await api(resignClaims(granted.token, { key: { name: granted.name, kind: "robot" } }), "GET", "/notes?limit=1")).status).toBe(401);
    expect((await api(resignClaims(granted.token, { key: undefined }), "GET", "/notes?limit=1")).status).toBe(401); // acts_for with no named key
  });
});

describe("safety/on-behalf: REST", () => {
  test("with the grant, the header `client-42` reads back by <keyname>:client-42, via key:<keyname>, on notes and records", async () => {
    for (const door of ["/notes", "/records"]) {
      const path = `onbehalf/rest/${id()}`;
      const made = await api(granted.token, "POST", door, { [door === "/records" ? "body" : "content"]: "follow-through ticked", path }, { [HEADER]: "client-42" });
      expect(made.status, `${door}: ${made.text.slice(0, 200)}`).toBe(201);
      const n = (await record(path)).body;
      expect(n.createdBy, door).toBe(`${granted.name}:client-42`);
      expect(n.createdVia, door).toBe(`key:${granted.name}`);
      const up = await api(granted.token, "PATCH", `/notes/${encodeURIComponent(path)}`, { content: "again", force: true }, { [HEADER]: "client-43" });
      expect(up.status, up.text.slice(0, 200)).toBe(200);
      const after = (await record(path)).body;
      expect(after.lastUpdatedBy).toBe(`${granted.name}:client-43`);
      expect(after.lastUpdatedVia).toBe(`key:${granted.name}`);
      const versions = (await reader().get(`/notes/${encodeURIComponent(after.id)}/versions`)).body.versions as any[];
      expect(versions[0]).toMatchObject({ actor: `${granted.name}:client-43`, via: `key:${granted.name}`, via_kind: "app" });
    }
  });

  test("without the grant the header is refused, with a reason that teaches, and nothing is written", async () => {
    const path = `onbehalf/plain/${id()}`;
    const r = await api(plain.token, "POST", "/notes", { content: "no", path }, { [HEADER]: "client-42" });
    expect(r.status).toBe(403);
    expect(r.body.error_type).toBe("on_behalf_not_granted");
    expect(r.body.message).toContain(HEADER);
    expect(r.body.message).toContain("on_behalf_of: true");
    expect((await record(path)).status).toBe(404);
    // An existing record isn't changed either.
    const kept = `onbehalf/plain/${id()}`;
    expect((await api(plain.token, "POST", "/notes", { content: "kept", path: kept })).status).toBe(201);
    expect((await api(plain.token, "PATCH", `/notes/${encodeURIComponent(kept)}`, { content: "changed", force: true }, { [HEADER]: "client-42" })).status).toBe(403);
    expect((await api(plain.token, "DELETE", `/notes/${encodeURIComponent(kept)}`, undefined, { [HEADER]: "client-42" })).status).toBe(403);
    expect((await record(kept)).body.content).toBe("kept");
  });

  test("an id with a colon, an @, or 65 characters is refused, and nothing is written", async () => {
    for (const bad of ["nostr:abc", "mara@fernhill.example", "a".repeat(65), "", "client 42"]) {
      const path = `onbehalf/bad/${id()}`;
      const r = await api(granted.token, "POST", "/notes", { content: "no", path }, { [HEADER]: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error_type, bad).toBe("invalid_on_behalf_of");
      expect((await record(path)).status, bad).toBe(404);
    }
  });

  test("every route answers the header: recorded on a record write, refused where nothing records a writer", async () => {
    // A route that records no writer refuses the header rather than dropping it, for any key.
    const path = `onbehalf/routes/${id()}`;
    expect((await api(granted.token, "POST", "/notes", { content: "x", path })).status).toBe(201);
    const noWriter = [
      ["POST", "/triggers", { name: `t${id()}`, url: "http://127.0.0.1:9/hook", events: ["created"] }],
      ["POST", `/notes/${encodeURIComponent(path)}/retry-transcription`, {}],
      ["POST", `/notes/${encodeURIComponent(path)}/attachments`, { path: "x.png", mimeType: "image/png" }],
    ] as const;
    for (const [method, route, body] of noWriter) {
      const r = await api(granted.token, method, route, body, { [HEADER]: "client-42" });
      expect(r.status, `${route}: ${r.text.slice(0, 120)}`).toBe(400);
      expect(r.body.error_type, route).toBe("on_behalf_not_recorded");
      const p = await api(plain.token, method, route, body, { [HEADER]: "client-42" });
      expect(p.body?.error_type, route).toBe("on_behalf_not_granted");
    }
    // The MCP transport never reads the REST header: refused there too.
    const m = await call(`/vault/${s.vaultName}/mcp`, {
      method: "POST",
      auth: `Bearer ${granted.token}`,
      headers: { [HEADER]: "client-42", accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    });
    expect(m.status).toBe(400);
    // A record whose path is a word the routes use is still a record.
    const named = `versions-${id()}`;
    expect((await api(granted.token, "POST", "/notes", { content: "x", path: named }, { [HEADER]: "client-9" })).status).toBe(201);
    expect((await api(granted.token, "PATCH", `/notes/${named}`, { content: "y", force: true }, { [HEADER]: "client-9" })).status).toBe(200);
  });

  test("a via or by in the body or in any other header changes nothing", async () => {
    const forged = { "Parachute-Via": "key:other", "X-Parachute-Via": "key:other", "Parachute-By": "someone", "X-On-Behalf-Of": "client-1", "Parachute-Acts-For": "unforced.dev" };
    const body = (path: string) => ({ content: "forged?", path, createdBy: "someone", createdVia: "key:other", created_by: "someone", created_via: "key:other", actor: "someone", via: "key:other" });
    for (const [token, extra, by] of [
      [plain, {}, null],
      [granted, {}, null],
      [granted, { [HEADER]: "client-1" }, `${granted.name}:client-1`],
    ] as const) {
      const path = `onbehalf/forge/${id()}`;
      const r = await api(token.token, "POST", "/notes", body(path), { ...forged, ...extra });
      if (r.status === 201) {
        const n = (await record(path)).body;
        expect(n.createdVia).toBe(`key:${token.name}`);
        if (by) expect(n.createdBy).toBe(by);
        else {
          expect(n.createdBy).not.toContain("someone");
          expect(n.createdBy).not.toContain(":");
        }
      } else expect(r.status).toBe(400);
    }
  });
});

describe("safety/on-behalf: MCP", () => {
  test("with the grant, on_behalf_of is a parameter of the write tools and reads back as by <keyname>:<id>", async () => {
    const c = await mcp(mcpUrl(), granted.token);
    try {
      const tools = (await c.client.listTools()).tools;
      const create = tools.find((t) => t.name === "create-note");
      expect(Object.keys((create?.inputSchema as any)?.properties ?? {})).toContain("on_behalf_of");
      const path = `onbehalf/mcp/${id()}`;
      await c.call("create-note", { content: "from the portal", path, on_behalf_of: "client-42" });
      await c.call("update-record", { id: path, body: "again", force: true, on_behalf_of: "client-43" });
      const n = (await record(path)).body;
      expect(n.createdBy).toBe(`${granted.name}:client-42`);
      expect(n.createdVia).toBe(`key:${granted.name}`);
      expect(n.lastUpdatedBy).toBe(`${granted.name}:client-43`);
      await expect(c.call("create-note", { content: "no", path: `${path}-bad`, on_behalf_of: "nostr:abc" })).rejects.toThrow(/on_behalf_of/);
      expect((await record(`${path}-bad`)).status).toBe(404);
    } finally {
      await c.close();
    }
  });

  test("without the grant the parameter isn't shown, and a supplied one is refused with a reason that teaches; nothing written", async () => {
    const c = await mcp(mcpUrl(), plain.token);
    try {
      const tools = (await c.client.listTools()).tools;
      for (const t of tools) expect(Object.keys((t.inputSchema as any)?.properties ?? {}), t.name).not.toContain("on_behalf_of");
      for (const [tool, args] of [
        ["create-note", { content: "no", path: `onbehalf/mcp-plain/${id()}` }],
        ["create-record", { body: "no", path: `onbehalf/mcp-plain/${id()}` }],
      ] as const) {
        for (const value of ["client-42", null]) {
          const err = await c.call(tool, { ...args, on_behalf_of: value }).then(() => null, (e: Error) => e);
          expect(err, `${tool} ${value}`).toBeInstanceOf(Error);
          expect(err!.message, tool).toContain("on_behalf_of: true");
          expect((await record(args.path)).status, tool).toBe(404);
        }
      }
    } finally {
      await c.close();
    }
  });
});
