// Surface G: the exit. A person can take their whole vault out as files: every note, every type, every attached
// file. The export is what a move between doors is made of, so the bytes of the same vault must be the same bytes
// whichever door wrote them.
//
// The contract writes one fixed, made-up vault corner (`exit-fixture/…`) and records each exported file with ids and
// times masked. A door with an export over HTTP is read here. A box exports with its CLI, so the runner
// (harness/doors/run.ts) records the same facts from the box's own export after the run; the comparison is the same.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accountToken, door, fp, lacks, mcpUrl, rest, runId, safeFetch, shape, token, vaultUrl } from "./_door.ts";
import { FIXTURE, FIXTURE_FILE, recordExport } from "./_exit.ts";
import { untar } from "./_tar.ts";

const api = rest("write");
const admin = rest("admin");
/** The fixture: a type with an enum, three linked notes with unusual but supported fields, a file, a pathless note. */
export async function writeFixture(): Promise<void> {
  if ((await api.get(`/notes/${FIXTURE}%2Fplan`)).status === 200) return;
  const t = await admin.put(`/tags/exitfixture`, {
    description: "A made-up type for the exit contract",
    fields: { status: { type: "string", enum: ["open", "done", "a:b"], strict: true }, due: { type: "date" }, points: { type: "integer", indexed: true } },
  });
  if (t.status !== 200) throw new Error(`fixture: declaring the type gave ${t.status}`);
  const note = (body: Record<string, unknown>) => api.post("/notes", body).then((r) => (r.status === 201 ? r.body : Promise.reject(new Error(`fixture: a note gave ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`))));
  const target = await note({ path: `${FIXTURE}/target`, content: "The target.\n" });
  const plan = await note({
    path: `${FIXTURE}/plan`,
    content: `# Plan\n\nSee [[${FIXTURE}/target]] and [[${FIXTURE}/not-yet]].\n\nUmlauts stay: Grüße, 東京, 🪂.\n`,
    tags: ["exitfixture", "exit/nested-tag"],
    metadata: {
      status: "a:b",
      due: "2027-02-03",
      points: 5,
      done: false,
      urls: ["https://example.org/a", "plain", "http://example.org:8080/b?c=d#e"],
      people: [{ address: "mailto:sam@example.org", name: "Sam" }],
      nested: { deep: { list: [1, 2, 3], yes: true } },
      empty_text: "",
      multi: "line one\nline two",
      quote: "it's \"quoted\"",
    },
  });
  const linked = await api.patch(`/notes/${plan.id}`, { links: { add: [{ target: target.id, relationship: "depends-on" }] }, if_updated_at: plan.updatedAt });
  if (linked.status !== 200) throw new Error(`fixture: the typed link gave ${linked.status}`);
  const form = new FormData();
  form.set("file", new File([FIXTURE_FILE as unknown as BlobPart], "map.png", { type: "image/png" }));
  const up = await api.call("POST", "/api/storage/upload", form);
  if (up.status !== 201) throw new Error(`fixture: the upload gave ${up.status}`);
  const att = await api.post(`/notes/${target.id}/attachments`, { path: up.body.path, mimeType: "image/png" });
  if (att.status !== 201) throw new Error(`fixture: attaching gave ${att.status}`);
  await note({ content: "exit-fixture pathless note\n", tags: ["exit/nested-tag"] });
}

describe("the exit", () => {
  test("the fixture is written", async () => {
    await writeFixture();
    expect((await api.get(`/notes/${FIXTURE}%2Fplan`)).status).toBe(200);
  });

  test.skipIf(lacks("export-over-http"))("the whole vault comes out as one tar over HTTP: notes, types and files", async () => {
    await writeFixture();
    const r = await safeFetch(`${vaultUrl()}/api/export`, { headers: { authorization: `Bearer ${await token("read")}` } });
    expect(r.status).toBe(200);
    fp("exit/http.headers", { type: (r.headers.get("content-type") ?? "").split(";")[0], disposition: (r.headers.get("content-disposition") ?? "").replace(/vault-.*\.tar/, "vault-<v>-<time>.tar") });
    const files = untar(new Uint8Array(await r.arrayBuffer()));
    const names = files.map((f) => f.name);
    expect(names).toContain(".parachute/vault.yaml");
    expect(names).toContain(".parachute/schemas/exitfixture.yaml");
    expect(names).toContain(`${FIXTURE}/plan.md`);
    const attached = files.find((f) => f.name.startsWith(".parachute/attachments/") && f.name.endsWith(".png") && f.bytes.length === FIXTURE_FILE.length);
    expect(attached, names.join(" ")).toBeTruthy();
    expect(createHash("sha256").update(attached!.bytes).digest("hex")).toBe(createHash("sha256").update(FIXTURE_FILE).digest("hex"));
    recordExport(files, fp);
    const anon = await safeFetch(`${vaultUrl()}/api/export`);
    expect(anon.status).toBe(401);
  });
});

// The backup key (0.9.3 "the exit"): a key that can download the full export and do nothing else, so a person's own
// scheduler (cron and curl) can pull a backup without holding a key that could read, change or delete anything.
describe.skipIf(door().release !== "0.9.1" || lacks("export-key"))("the backup key", () => {
  const d = door();
  const owner = async () => ({ authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" });
  const mint = async (name: string, can: string) => safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await owner(), body: JSON.stringify({ name, vault: d.vault, can }) });
  const call = (key: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    safeFetch(`${vaultUrl()}${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const lastExport = async () => (await rest("admin").get("/vault")).body as { last_export_at?: string | null; last_export_by?: string | null };

  test("a key that holds only the export permission pulls the whole vault as one tar, and the vault records who and when", async () => {
    await writeFixture();
    const name = `door-backup-${runId("b")}`;
    const made = await mint(name, "export");
    expect(made.status, (await made.clone().text()).slice(0, 200)).toBe(201);
    const key = await made.json();
    fp("exit/export-key.mint.shape", shape(key));
    expect(key.can).toBe("export");
    const claims = JSON.parse(Buffer.from(key.token.split(".")[1], "base64url").toString());
    // Exactly the one scope: no read comes with it.
    expect(claims.scope).toBe(`vault:${d.vault}:export`);

    const before = await lastExport();
    const r = await call(key.token, "GET", "/api/export");
    expect(r.status, (await r.clone().text()).slice(0, 200)).toBe(200);
    fp("exit/export-key.headers", { type: (r.headers.get("content-type") ?? "").split(";")[0] });
    const files = untar(new Uint8Array(await r.arrayBuffer()));
    const names = files.map((f) => f.name);
    expect(names).toContain(`${FIXTURE}/plan.md`);
    expect(names).toContain(".parachute/schemas/exitfixture.yaml");
    const attached = files.find((f) => f.name.startsWith(".parachute/attachments/") && f.bytes.length === FIXTURE_FILE.length);
    expect(attached, names.join(" ")).toBeTruthy();

    // The stamp is written when the last byte has gone out; the reply above was read to its end.
    const after = await lastExport();
    expect(typeof after.last_export_at, JSON.stringify(after)).toBe("string");
    expect(Date.parse(after.last_export_at!)).toBeGreaterThan(Date.parse(before.last_export_at ?? "1970-01-01T00:00:00Z") - 1);
    expect(after.last_export_at).not.toBe(before.last_export_at ?? null);
    expect(after.last_export_by).toBe(`key:${name}`);
    fp("exit/export-key.stamp.shape", shape(after.last_export_at === null ? null : { last_export_at: after.last_export_at, last_export_by: after.last_export_by }));

    // A second pull moves it again.
    await Bun.sleep(1100);
    expect((await (await call(key.token, "GET", "/api/export")).arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(Date.parse((await lastExport()).last_export_at!)).toBeGreaterThan(Date.parse(after.last_export_at!));

    // A read key still exports, as on cloud, and no key at all is refused.
    const asRead = await call(await token("read"), "GET", "/api/export");
    expect(asRead.status).toBe(200);
    await asRead.arrayBuffer();
    expect((await call(null, "GET", "/api/export")).status).toBe(401);
  });

  test("the export key opens nothing else: 403 on every other route, REST, MCP, admin, files and the vault's own page", async () => {
    await writeFixture();
    const name = `door-backup-${runId("c")}`;
    const key = (await (await mint(name, "export")).json()).token as string;
    const noteId = (await rest("write").get(`/notes/${FIXTURE}%2Fplan`)).body.id as string;
    const none = "00000000000000000000000000";
    const refused: [string, string, unknown?, Record<string, string>?][] = [
      // Reading notes, types, links, files
      ["GET", "/api/notes"], ["GET", `/api/notes/${FIXTURE}%2Fplan`], ["GET", `/api/notes?search=exit`], ["GET", `/api/notes/${noteId}/versions`],
      ["GET", "/api/tags"], ["GET", "/api/tags/exitfixture"], ["GET", "/api/records"], ["GET", "/api/types"],
      ["GET", "/api/find-path?from=a&to=b"], ["GET", "/api/unresolved-wikilinks"], ["GET", "/api/doctor"], ["GET", "/api/health"],
      ["GET", "/api/storage/anything.png"], ["GET", "/api/history/deleted"], ["GET", "/api/subscribe"],
      // Writing
      ["POST", "/api/notes", { content: "x", path: `${FIXTURE}/by-export-key` }], ["PATCH", `/api/notes/${noteId}`, { content: "x" }], ["DELETE", `/api/notes/${none}`],
      ["POST", "/api/records", { content: "x" }], ["POST", "/api/storage/upload", {}], ["POST", `/api/notes/${noteId}/attachments`, { path: "x", mimeType: "image/png" }],
      // Types, the vault's settings, admin
      ["PUT", "/api/tags/exitfixture", { description: "x" }], ["DELETE", "/api/tags/exitfixture"], ["POST", "/api/tags/merge", { sources: ["a"], target: "b" }],
      ["GET", "/api/vault"], ["PATCH", "/api/vault", { description: "x" }], ["GET", "/api/triggers"], ["POST", "/api/triggers", {}],
      ["POST", "/api/history/compact", {}], ["DELETE", `/api/notes/${noteId}/versions`],
      // The export route itself takes only GET from this key
      ["POST", "/api/export", {}], ["DELETE", "/api/export"],
      // The vault root, its own endpoints, the mirror and settings
      ["GET", ""], ["GET", "/"], ["GET", "/.parachute/usage"], ["GET", "/.parachute/config"], ["GET", "/.parachute/embeddings"], ["GET", "/.parachute/transcription"],
      ["GET", "/.parachute/mirror"], ["POST", "/.parachute/mirror/run-now", {}], ["POST", "/.parachute/mirror/push-now", {}], ["GET", "/.parachute/mirror/history"], ["GET", "/.parachute/mirror/auth"],
    ];
    const got: string[] = [];
    for (const [method, path, body, extra] of refused) {
      const r = await call(key, method, path, body, extra);
      const text = await r.text();
      if (r.status !== 403) got.push(`${method} ${path} -> ${r.status} ${text.slice(0, 80)}`);
    }
    expect(got, "every one of these must be 403").toEqual([]);

    // MCP: connecting (initialize), listing tools and calling one are all refused.
    const mcpCall = (body: unknown, sid?: string) =>
      safeFetch(mcpUrl(), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
    const init = await mcpCall({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    expect(init.status).toBe(403);
    fp("exit/export-key.mcp-refusal", { status: init.status });
    expect((await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(403);
    expect((await mcpCall({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query-notes", arguments: {} } })).status).toBe(403);
    const rootMcp = await safeFetch(`${d.vaultOrigin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) });
    expect([401, 403]).toContain(rootMcp.status);
    // The key opens no other vault, nor the account door.
    expect([401, 403]).toContain((await safeFetch(`${d.vaultOrigin}/vault/${d.otherVault}/api/export`, { headers: { authorization: `Bearer ${key}` } })).status);
    expect([401, 403]).toContain((await safeFetch(`${d.issuer}/account/vaults`, { headers: { authorization: `Bearer ${key}` } })).status);
    // /view reads like no key at all: a note nobody published stays hidden.
    const view = await call(key, "GET", `/view/${FIXTURE}%2Fplan`);
    const anon = await call(null, "GET", `/view/${FIXTURE}%2Fplan`);
    expect(view.status).toBe(anon.status);
    expect(view.status).not.toBe(200);
  });

  test("a revoked export key stops", async () => {
    const name = `door-backup-${runId("r")}`;
    const key = (await (await mint(name, "export")).json()).token as string;
    expect((await (await call(key, "GET", "/api/export")).arrayBuffer()).byteLength).toBeGreaterThan(0);
    const gone = await safeFetch(`${d.issuer}/account/keys/${encodeURIComponent(name)}`, { method: "DELETE", headers: await owner() });
    expect(gone.status).toBe(200);
    expect((await call(key, "GET", "/api/export")).status).toBe(401);
  });
});
