// compat/uni: every client of uni's live box keeps working (PLAN §7.4 `compat/uni` row, §8.1 the writer manifest, §6
// slice 0). The clients and the calls they make are in uni-writers.json, rebuilt read-only from this machine's units
// and the code they run (no live call, nothing read from ~/.parachute, no token or note copied). Here each client gets
// one probe: its representative call, replayed against the throwaway box with made-up data, checking the shape the
// client reads back. Also NIP-98 sign-in in both shapes uni uses (Hermes on loopback, the Uni app and uni-nightly
// through Tailscale Serve), the files a restart must leave byte-identical, and one process per vault.db.
// Green on today's code (stock 0.7.19 hub + 0.7.9 vault). Every lane keeps it green; slice 2 also runs it read-only
// against live after the swap.
//
// Differences from live, by necessity:
//   - Most REST clients call the vault on :1940 directly (uni_vault.py:4 and the others in the manifest). Inside the
//     box that port is the vault's too, but the guard refuses 1939-1946, so these go through the hub's
//     /vault/<n>/api route, which proxies to the same vault. v0.8 must keep answering /vault/<n>/api on :1940.
//   - Live script passes carry the old tailnet issuer (the hub unit's t137-legacy-iss drop-in sets
//     PARACHUTE_HUB_ORIGIN). The box's issuer is its loopback origin. Not covered here; rehearsal/uni covers it.
//   - Live NIP-98 keys are linked to whichever hub user the operator chose (not recorded anywhere we may read). Here
//     the key is linked to the box's owner with `parachute auth link-pubkey`, the command the Uni app tells you to
//     run when its key is unknown (parachute.rs auth_hint).
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { hubCli } from "../../harness/services.ts";
import { enc, must, rest, runId, safeFetch, services } from "../lib.ts";
import { nip98, nostrKey, schnorrSign, xonly } from "./_lib.ts";
import manifest from "./uni-writers.json";

const s = services();
const R = runId("uni");
const V = s.vaultName;
const json = (r: { body: any }) => r.body;

/** A long-lived script pass, the kind in uni's shared tokens file (`vault:uni:write`, PEOPLE-DESIGN.md:172). */
let scriptToken = "";
let adminToken = "";
let api: ReturnType<typeof rest>;

beforeAll(async () => {
  const mint = async (scope: string, label: string) =>
    (await hubCli(s, ["auth", "mint-token", "--scope", scope, "--expires-in", "31536000", "--label", label])).trim().split("\n").pop()!.trim();
  scriptToken = await mint(`vault:${V}:write`, "compat-uni-script");
  adminToken = await mint(`vault:${V}:admin`, "compat-uni-admin");
  api = rest(s.vaultViaHub, scriptToken);
  // The clients' operator queries (metadata={"state":{"in":..}}, meta[uid][eq], fireflies_id exists) need those
  // fields indexed; uni's vault declares them on its type tags. Same here, with the admin pass.
  const admin = rest(s.vaultViaHub, adminToken);
  for (const [tag, field] of [["task", "state"], ["event", "uid"], ["meeting", "fireflies_id"]]) {
    const r = await admin.put(`/tags/${tag}`, { fields: { [field!]: { type: "string", indexed: true } } });
    if (r.status !== 200) throw new Error(`declaring ${tag}.${field} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
});

/** GET with a raw query, as the Python clients build it (urllib.parse.urlencode). */
const get = (path: string, q: Record<string, string> = {}) => api.get(`${path}${Object.keys(q).length ? "?" + new URLSearchParams(q) : ""}`);

/** A made-up note, created with the script pass. */
async function seed(note: Record<string, unknown>) {
  const r = await api.post("/notes", note);
  if (r.status !== 201) throw new Error(`seed failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

// ── NIP-98 on the hub's account door (/mcp) ─────────────────────────────────────────────────────────────────

const TAILNET_HOST = "uni.example-tailnet.ts.net"; // a placeholder; Tailscale Serve keeps the Host it was asked for
const key = nostrKey();

/** The account door as one signer calls it: JSON-RPC over POST, one fresh NIP-98 event per request. */
function door(shape: "loopback" | "tailnet", encoding: "base64" | "base64url") {
  const url = `${s.hub}/mcp`;
  const signed = shape === "loopback" ? url : `https://${TAILNET_HOST}/mcp`;
  // What Tailscale Serve adds when it proxies https://<host>/ to 127.0.0.1:<hub> (hub src/request-layer.ts:100-110).
  const proxy: Record<string, string> =
    shape === "tailnet" ? { host: TAILNET_HOST, "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.7", "tailscale-user-login": "someone@example.com" } : {};
  async function rpc(method: string, params?: unknown) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
    const r = await safeFetch(url, {
      method: "POST",
      headers: { authorization: nip98(key, signed, "POST", body, encoding), "content-type": "application/json", accept: "application/json, text/event-stream", ...proxy },
      body,
    });
    const text = await r.text();
    return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  }
  return {
    rpc,
    /** tools/call; returns the tool's JSON result, or throws with its error text. */
    async tool(name: string, args: Record<string, unknown>): Promise<any> {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      if (r.body?.error) throw new Error(`${name}: ${JSON.stringify(r.body.error).slice(0, 300)}`);
      const text = (r.body.result.content ?? []).map((c: any) => c.text ?? "").join("");
      if (r.body.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
  };
}

describe("compat/uni: NIP-98 sign-in", () => {
  test("the Schnorr signer here matches BIP-340's test vectors (so a failure below is the hub's, not ours)", () => {
    const sk = "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF";
    expect(xonly(sk)).toBe("dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659");
    const sig = schnorrSign(sk, Buffer.from("243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "hex"), Buffer.from("00".repeat(31) + "01", "hex"));
    expect(sig).toBe("6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a");
  });

  test("an unlinked key is refused with 401 and a body saying 'not linked' (the Uni app keys its hint on that)", async () => {
    const r = await door("loopback", "base64url").rpc("tools/list");
    expect(r.status).toBe(401);
    expect(r.text).toContain("not linked");
  });

  test("`parachute auth link-pubkey --user <owner> <hex>` links a key", async () => {
    const out = await hubCli(s, ["auth", "link-pubkey", "--user", s.admin.username, key.pubkey]);
    expect(out).toContain(key.pubkey);
  });

  test("Hermes' shape: POST http://127.0.0.1:<hub>/mcp signed for that URL, standard base64 → the account door answers", async () => {
    const d = door("loopback", "base64");
    const init = await d.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hermes", version: "0" } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("parachute-account");
    const list = await d.rpc("tools/list");
    const tools = list.body.result.tools.map((t: any) => t.name);
    for (const t of ["query-notes", "create-note", "update-note", "list-vaults", "request-attachment-upload", "doctor"]) expect(tools).toContain(t);
    const create = list.body.result.tools.find((t: any) => t.name === "create-note");
    expect(Object.keys(create.inputSchema.properties)).toContain("vault"); // the `vault` selector every call carries
  });

  test("the Uni app's shape: https://<tailnet host>/mcp through Tailscale Serve's forwarded headers, base64url → answers", async () => {
    const r = await door("tailnet", "base64url").rpc("tools/list");
    expect(r.status).toBe(200);
    expect(r.body.result.tools.length).toBeGreaterThan(0);
  });

  test("the https-signed event is refused when the request carries no forwarding headers (hub#915: no loopback replay)", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = await safeFetch(`${s.hub}/mcp`, {
      method: "POST",
      headers: { authorization: nip98(key, `https://${TAILNET_HOST}/mcp`, "POST", body), host: TAILNET_HOST, "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    expect(r.status).toBe(401);
  });

  test("a NIP-98 event is single-use: the same header twice → the second is 401", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const auth = nip98(key, `${s.hub}/mcp`, "POST", body);
    const send = () => safeFetch(`${s.hub}/mcp`, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(401);
  });
});

// ── one probe per client (uni-writers.json) ─────────────────────────────────────────────────────────────────

describe("compat/uni: the writer manifest", () => {
  test("every client named in PLAN §8.1 is in the manifest, each with at least one call and a probe below", () => {
    const names = manifest.clients.map((c) => c.name);
    for (const n of [
      "hermes-mcp", "uni-app", "uni-tasks", "mts", "uni-publish", "intake-importer", "uni-calendar", "the-door",
      "tasks-mirror", "marker-sweep", "civics-ingest", "kirtan-sync", "uni-nightly", "uni-digest", "call-capture",
      "uni-mail-needs-aaron", "uni-areas-proto", "pacer", "loops", "backup-jobs",
    ]) expect(names).toContain(n);
    for (const c of manifest.clients) {
      expect(c.calls.length).toBeGreaterThan(0);
      expect(c.probe).toBeString();
    }
  });

  test("the manifest holds no secrets or real hostnames", () => {
    const text = readFileSync(join(import.meta.dir, "uni-writers.json"), "utf8");
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|pvk_|nsec1|\.ts\.net|unforced\.|@[a-z0-9-]+\.[a-z]/i);
  });
});

describe("compat/uni: REST clients (Bearer script pass)", () => {
  test("uni-tasks: GET notes?tag=task&metadata={state in [...]}&include_content=false is a flat array with id, path, metadata, updatedAt", async () => {
    await seed({ path: `${R}/Tasks/T-01 made up`, content: "a made-up task", tags: ["task"], metadata: { state: "open" } });
    await seed({ path: `${R}/Tasks/T-02 made up`, content: "another", tags: ["task"], metadata: { state: "done" } });
    const r = await get("/notes", { tag: "task", metadata: JSON.stringify({ state: { in: ["open", "doing", "waiting"] } }), path_prefix: `${R}/Tasks`, include_content: "false" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((n: any) => n.path)).toEqual([`${R}/Tasks/T-01 made up`]);
    const n = r.body[0];
    for (const k of ["id", "path", "tags", "metadata", "updatedAt", "createdAt"]) expect(n).toHaveProperty(k);
    expect(n.metadata.state).toBe("open");
  });

  test("tasks-mirror: PATCH {metadata, if_updated_at} → 200 with the new updatedAt; the old stamp again → 409", async () => {
    const t = await seed({ path: `${R}/Tasks/T-03 mirror`, content: "x", tags: ["task"], metadata: { state: "open" } });
    const ok = await api.patch(`/notes/${enc(t.id)}`, { metadata: { content_hash: "abc123", generated_by: "tasks-mirror", generated_at: "2026-10-27T00:00:00Z" }, if_updated_at: t.updatedAt });
    expect(ok.status).toBe(200);
    expect(ok.body.metadata).toMatchObject({ state: "open", content_hash: "abc123" });
    expect(ok.body.updatedAt).toBeString();
    const stale = await api.patch(`/notes/${enc(t.id)}`, { metadata: { content_hash: "def456" }, if_updated_at: t.updatedAt });
    expect(stale.status).toBe(409);
  });

  test("mts: PATCH {force:true, metadata} on a run note → 200, metadata merged", async () => {
    const run = await seed({ path: `${R}/Runs/run-1`, content: "run", tags: ["run"], metadata: { state: "running" } });
    const r = await api.patch(`/notes/${enc(run.id)}`, { force: true, metadata: { state: "done", claude_accounts: ["a", "b"] } });
    expect(r.status).toBe(200);
    expect(r.body.metadata).toEqual({ state: "done", claude_accounts: ["a", "b"] });
  });

  test("marker-sweep: GET notes?tag=task&include_content=true returns content on each note", async () => {
    await seed({ path: `${R}/Tasks/T-04 marker`, content: "body with [marker]", tags: ["task"], metadata: { state: "open" } });
    const r = await get("/notes", { tag: "task", include_content: "true", path_prefix: `${R}/Tasks/T-04` });
    expect(r.status).toBe(200);
    expect(r.body.map((n: any) => n.content)).toEqual(["body with [marker]"]);
  });

  test("uni-digest: GET notes?tag&include_content=false&cursor=&limit=N is {notes, next_cursor}; a bad cursor is 400 with a code starting 'cursor'", async () => {
    const r = await get("/notes", { tag: "task", include_content: "false", cursor: "", limit: "200" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.notes)).toBe(true);
    expect(r.body).toHaveProperty("next_cursor");
    const bad = await get("/notes", { tag: "task", include_content: "false", cursor: "not-a-cursor", limit: "200" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.code)).toStartWith("cursor");
    // "What changed since <stamp>": two tasks, the second written after the first; the filter must cut between them.
    const older = await seed({ path: `${R}/Digest/older`, content: "x", tags: ["task"], metadata: { state: "open" } });
    await Bun.sleep(20);
    const newer = await seed({ path: `${R}/Digest/newer`, content: "y", tags: ["task"], metadata: { state: "open" } });
    expect(newer.updatedAt > older.updatedAt).toBe(true);
    const since = (gte: string) => get("/notes", { tag: "task", include_content: "false", "meta[updated_at][gte]": gte, path_prefix: `${R}/Digest` });
    const all = await since("2000-01-01T00:00:00Z");
    expect(all.status).toBe(200);
    expect(all.body.map((n: any) => n.id).sort()).toEqual([older.id, newer.id].sort());
    expect((await since(newer.updatedAt)).body.map((n: any) => n.id)).toEqual([newer.id]);
  });

  test("pacer: a read-only query (metadata filter, include_content=false) is a flat array without content", async () => {
    for (const state of ["open", "doing", "waiting", "done", "dropped"]) {
      await seed({ path: `${R}/Pacer/${state}`, content: `a made-up ${state} task`, tags: ["task"], metadata: { state } });
    }
    const r = await get("/notes", { tag: "task", metadata: JSON.stringify({ state: { in: ["open", "doing", "waiting"] } }), include_content: "false", path_prefix: `${R}/Pacer` });
    expect(r.status).toBe(200);
    expect(r.body.map((n: any) => n.path).sort()).toEqual([`${R}/Pacer/doing`, `${R}/Pacer/open`, `${R}/Pacer/waiting`]);
    for (const n of r.body) expect(n.content ?? "").toBe("");
  });

  test("loops: weekly push upserts by path (GET path_prefix exact, then PATCH {content, if_updated_at} or POST)", async () => {
    const path = `${R}/Plans/Weekly push 2026-W44`;
    const none = await get("/notes", { path_prefix: path, include_content: "false" });
    expect(none.body.filter((n: any) => n.path === path)).toEqual([]);
    const created = await api.post("/notes", { path, content: "plan v1", tags: ["push-plan"] });
    expect(created.status).toBe(201);
    const found = (await get("/notes", { path_prefix: path, include_content: "false" })).body.find((n: any) => n.path === path);
    const upd = await api.patch(`/notes/${enc(found.id)}`, { content: "plan v2", if_updated_at: found.updatedAt });
    expect(upd.status).toBe(200);
  });

  test("uni-publish: POST to a taken path → 409, so it can retry with a suffix; GET notes?tag=published finds it by metadata.sha256", async () => {
    const note = { path: `${R}/Published/2026-10-27 Made up`, content: "a published page", tags: ["published"], metadata: { sha256: "0".repeat(64), kind: "page", url: "https://example.invalid/p" } };
    const first = await api.post("/notes", note);
    expect(first.status).toBe(201);
    expect(first.body.id).toBeString();
    expect(first.body.path).toBe(note.path);
    expect((await api.post("/notes", note)).status).toBe(409);
    expect((await api.post("/notes", { ...note, path: `${note.path} (2)` })).status).toBe(201);
    const list = await get("/notes", { tag: "published", path_prefix: `${R}/Published` });
    expect(list.body.filter((n: any) => n.metadata?.sha256 === "0".repeat(64)).length).toBe(2);
  });

  test("uni-mail-needs-aaron: `tasks.py new` → POST a task note, then `tasks.py set --state done` → PATCH with if_updated_at", async () => {
    const t = await seed({ path: `${R}/Tasks/T-05 mail`, content: "reply to a made-up email", tags: ["task"], metadata: { state: "open", source: "mail" } });
    const done = await api.patch(`/notes/${enc(t.id)}`, { metadata: { state: "done" }, if_updated_at: t.updatedAt });
    expect(done.status).toBe(200);
    expect(done.body.metadata.state).toBe("done");
  });

  test("intake importer: storage/upload → .path; attach with transcribe and segment_index; list attachments; PATCH {append}", async () => {
    const person = await seed({ path: `${R}/People/Made Up Person`, content: "intake", tags: ["intake"], metadata: { submission_id: `${R}-sub1` } });
    const form = new FormData();
    form.append("file", new File([new Uint8Array(64)], "voice.m4a", { type: "audio/mp4" }));
    const up = await safeFetch(`${s.vaultViaHub}/api/storage/upload`, { method: "POST", headers: { authorization: `Bearer ${scriptToken}` }, body: form });
    expect(up.status).toBeLessThan(300);
    const stored = await up.json();
    expect(stored.path).toBeString();
    const att = await api.post(`/notes/${enc(person.id)}/attachments`, { path: stored.path, mimeType: "audio/mp4", transcribe: true, segment_index: 0 });
    expect(att.status).toBeLessThan(300);
    const list = await api.get(`/notes/${enc(person.id)}/attachments`);
    expect(list.status).toBe(200);
    const rows = Array.isArray(list.body) ? list.body : list.body.attachments;
    expect(rows.length).toBe(1);
    expect(rows[0].metadata?.segment_index).toBe(0);
    const byMeta = await get("/notes", { tag: "intake", include_content: "true", limit: "50", "meta[submission_id]": `${R}-sub1` });
    expect(byMeta.body.map((n: any) => n.id)).toEqual([person.id]);
    const fresh = (await api.get(`/notes/${enc(person.id)}`)).body;
    expect((await api.patch(`/notes/${enc(person.id)}`, { metadata: { imported: true }, if_updated_at: fresh.updatedAt })).status).toBe(200);
    const app = await api.patch(`/notes/${enc(person.id)}`, { append: "\nmore" });
    expect(app.status).toBe(200);
    expect((await api.get(`/notes/${enc(person.id)}`)).body.content).toStartWith("intake");
  });

  test("uni-calendar: GET notes?tag=event&include_content=true&limit=200&offset=N pages a flat array", async () => {
    await seed({ path: `${R}/Calendar/e1`, content: "made-up event", tags: ["event"], metadata: { start: "2026-11-01T10:00:00Z" } });
    await seed({ path: `${R}/Calendar/e2`, content: "another event", tags: ["event"], metadata: { start: "2026-11-02T10:00:00Z" } });
    const p0 = await get("/notes", { tag: "event", include_content: "true", limit: "1", offset: "0", path_prefix: `${R}/Calendar` });
    const p1 = await get("/notes", { tag: "event", include_content: "true", limit: "1", offset: "1", path_prefix: `${R}/Calendar` });
    expect(p0.body.length).toBe(1);
    expect(p1.body.length).toBe(1);
    const paged = [...p0.body, ...p1.body].map((n: any) => [n.path, n.content]).sort();
    expect(paged).toEqual([[`${R}/Calendar/e1`, "made-up event"], [`${R}/Calendar/e2`, "another event"]]);
  });

  test("the door: cursor pages {notes,next_cursor}, meta[uid][eq], batch POST, PATCH tags{add,remove}, 409 path_conflict, DELETE, PUT /tags with admin", async () => {
    const root = `${R}/Door`;
    const batch = await api.post("/notes", { notes: [
      { path: `${root}/ev-a`, content: "A", tags: ["event"], metadata: { uid: `${R}-a`, last_op: "create" } },
      { path: `${root}/ev-b`, content: "B", tags: ["event"], metadata: { uid: `${R}-b`, last_op: "create" } },
    ] });
    expect(batch.status).toBe(201);
    expect(Array.isArray(batch.body)).toBe(true);
    expect(batch.body.length).toBe(2);
    const page = await get("/notes", { tag: "event", path_prefix: root, limit: "200", cursor: "" });
    expect(page.body.notes.map((n: any) => n.path).sort()).toEqual([`${root}/ev-a`, `${root}/ev-b`]);
    const byUid = await get("/notes", { tag: "event", "meta[uid][eq]": `${R}-a`, limit: "200", cursor: "" });
    expect(byUid.body.notes.map((n: any) => n.path)).toEqual([`${root}/ev-a`]);
    const a = byUid.body.notes[0];
    const tagged = await api.patch(`/notes/${enc(a.id)}`, { metadata: { last_op: "conflict" }, tags: { add: ["event-conflict"], remove: [] }, if_updated_at: a.updatedAt });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tags.sort()).toEqual(["event", "event-conflict"]);
    const dup = await api.post("/notes", { path: `${root}/ev-a`, content: "again", tags: ["event"] });
    expect(dup.status).toBe(409);
    expect(dup.body.error_type).toBe("path_conflict");
    expect((await api.get(`/notes/${enc(`${root}/ev-b`)}`)).status).toBe(200); // GET by path, urlencoded
    expect((await api.del(`/notes/${enc(a.id)}`)).status).toBeLessThan(300);
    expect((await api.get(`/notes/${enc(a.id)}`)).status).toBe(404);
    const schema = await rest(s.vaultViaHub, adminToken).put(`/tags/${enc(`${R}-booking-request`)}`, { description: "made up", fields: { idempotency_key: { type: "string" } } });
    expect(schema.status).toBe(200);
    const read = await api.get(`/tags?include_schema=true`);
    expect(read.status).toBe(200);
    const event = read.body.find((t: any) => t.name === "event");
    expect(event?.fields?.uid).toMatchObject({ type: "string", indexed: true }); // declared in beforeAll
  });

  test("civics-ingest: POST with links[{target,relationship}], then PATCH {force, tags{add}, links{add,remove}} → 200", async () => {
    const body = await seed({ path: `${R}/Civics/Body`, content: "a made-up council", tags: ["civic-body"] });
    const meeting = await api.post("/notes", { path: `${R}/Civics/Meeting 1`, content: "agenda", tags: ["meeting"], metadata: { date: "2026-10-01" }, links: [{ target: body.id, relationship: "held-by" }] });
    expect(meeting.status).toBe(201);
    const upd = await api.patch(`/notes/${enc(meeting.body.id)}`, { force: true, content: "minutes", tags: { add: ["minutes"] }, links: { add: [{ target: `${R}/Civics/Body`, relationship: "about" }], remove: [{ target: body.id, relationship: "held-by" }] } });
    expect(upd.status).toBe(200);
    expect(upd.body.metadata).toEqual({ date: "2026-10-01" });
    expect(upd.body.tags.sort()).toEqual(["meeting", "minutes"]);
  });

  test("kirtan-sync: GET notes/<fixed id> returns that note's content", async () => {
    const n = await seed({ path: `${R}/Chants`, content: "made-up chant list", tags: ["chants"] });
    const r = await api.get(`/notes/${enc(n.id)}`);
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("made-up chant list");
  });

  test("call-capture: POST, then PATCH {append} and PATCH {metadata, force}", async () => {
    const c = await seed({ path: `${R}/Calls/call-1`, content: "transcript part 1", tags: ["call"], metadata: { status: "recording" } });
    expect((await api.patch(`/notes/${enc(c.id)}`, { append: "\npart 2" })).status).toBe(200);
    const done = await api.patch(`/notes/${enc(c.id)}`, { metadata: { status: "done" }, force: true });
    expect(done.status).toBe(200);
    expect((await api.get(`/notes/${enc(c.id)}`)).body.content).toBe("transcript part 1\npart 2");
  });

  test("uni-areas-proto: GET notes?path=<exact>&include_content=true reads [0]", async () => {
    await seed({ path: `${R}/Areas/Health`, content: "area body", tags: ["area"] });
    await seed({ path: `${R}/Areas/Health/sub`, content: "not this one", tags: ["area"] });
    const r = await get("/notes", { path: `${R}/Areas/Health`, include_content: "true", limit: "200" });
    expect(r.status).toBe(200);
    expect(r.body[0].content).toBe("area body");
  });

  test("extra clients (fireflies, sources digest, area briefs, journal sweeps, stack-update): if_exists:update batches, sort/search, tag swaps, path GETs, /health", async () => {
    // fireflies-ingest: a batch upsert; run twice, the second updates in place.
    const item = { path: `${R}/Meetings/Made up sync`, content: "v1", tags: ["meeting"], metadata: { fireflies_id: `${R}-ff1` }, created_at: "2026-10-01T15:00:00Z", if_exists: "update" };
    expect((await api.post("/notes", { notes: [item] })).status).toBe(201);
    const second = await api.post("/notes", { notes: [{ ...item, content: "v2" }] });
    expect(second.status).toBeLessThan(300);
    const ff = await get("/notes", { metadata: JSON.stringify({ fireflies_id: { exists: true } }), tag: "meeting", path_prefix: `${R}/Meetings`, include_content: "true" });
    expect(ff.body.map((n: any) => n.content)).toEqual(["v2"]);
    expect(ff.body[0].createdAt).toStartWith("2026-10-01");
    // sources digest: a single upsert with if_exists:update.
    const src = { path: `${R}/Sources/digest`, content: "week 1", tags: ["source"], metadata: { week: 1 }, if_exists: "update" };
    expect((await api.post("/notes", src)).status).toBeLessThan(300);
    expect((await api.post("/notes", { ...src, content: "week 2" })).status).toBeLessThan(300);
    // area-briefs: newest first, keyword search, GET by path. Five more meetings, written out of date order, so that
    // with the fireflies one there are six: newest-first with limit 5 is the five newest, newest first, and neither
    // the default (oldest first) nor write order gives that answer.
    const days = ["04", "02", "06", "03", "05"];
    await api.post("/notes", { notes: days.map((d) => ({ path: `${R}/Meetings/Made up 10-${d}`, content: `meeting on 10-${d}`, tags: ["meeting"], created_at: `2026-10-${d}T15:00:00Z` })) });
    const desc = await get("/notes", { tag: "meeting", sort: "desc", limit: "5", include_content: "true", path_prefix: `${R}/Meetings` });
    expect(desc.status).toBe(200);
    expect(desc.body.map((n: any) => n.content)).toEqual(["06", "05", "04", "03", "02"].map((d) => `meeting on 10-${d}`));
    // Keyword search: two notes hold the word, two don't.
    await seed({ path: `${R}/Sources/monthly`, content: "a month of made-up sources", tags: ["source"] });
    await seed({ path: `${R}/Sources/daily`, content: "nothing to see", tags: ["source"] });
    await seed({ path: `${R}/Sources/weekly roundup`, content: "this week in made-up sources", tags: ["source"] });
    const found = await get("/notes", { tag: "source", search: "week", include_content: "true", path_prefix: `${R}/Sources` });
    expect(found.status).toBe(200);
    expect(found.body.map((n: any) => [n.path, n.content]).sort()).toEqual([[`${R}/Sources/digest`, "week 2"], [`${R}/Sources/weekly roundup`, "this week in made-up sources"]]);
    const byPath = await api.get(`/notes/${enc(`${R}/Sources/digest`)}?include_content=true`);
    expect(byPath.status).toBe(200);
    expect(byPath.body.content).toBe("week 2");
    // journal sweep: capture → journal by a tag swap, with the stamp it read.
    const cap = await seed({ path: `${R}/Inbox/capture`, content: "a made-up thought", tags: ["capture"] });
    const swap = await api.patch(`/notes/${enc(cap.id)}`, { tags: { add: ["journal"], remove: ["capture"] }, path: `${R}/Journal/thought`, if_updated_at: cap.updatedAt });
    expect(swap.status).toBe(200);
    expect(swap.body.tags).toEqual(["journal"]);
    const extract = await get("/notes", { tag: "journal", "meta[created_at][gte]": "2000-01-01T00:00:00Z", "meta[created_at][lt]": "2100-01-01T00:00:00Z", sort: "asc", include_content: "true", limit: "40", path_prefix: `${R}/Journal/thought` });
    expect(extract.body.map((n: any) => n.id)).toEqual([cap.id]);
    // stack-update: an unauthenticated health check on the hub.
    expect((await safeFetch(`${s.hub}/health`)).status).toBe(200);
  });
});

describe("compat/uni: account-door MCP clients (NIP-98)", () => {
  test("uni-nightly: through its {results:[{vault,...}]} unwrap, a count is [{value:int}], doctor has findings[], and a note round-trips", async () => {
    const d = door("tailnet", "base64");
    // nightly/hub.py vcall: unwrap the account door's envelope exactly as nightly does.
    const vcall = async (tool: string, args: Record<string, unknown>) => {
      const r = await d.tool(tool, { ...args, vault: V });
      if (!(r && typeof r === "object" && "results" in r)) return r;
      const rows = r.results.filter((x: any) => x.vault === V);
      must(rows.length, `${tool}: no result for vault`);
      const x = rows[0];
      must(!x.error, `${tool}: ${JSON.stringify(x.error)}`);
      for (const k of ["notes", "result", "note", "data"]) if (k in x) return x[k];
      return Object.fromEntries(Object.entries(x).filter(([k]) => k !== "vault"));
    };
    await seed({ path: `${R}/Nightly/one`, content: "x", tags: [`${R}-nightly`] });
    await seed({ path: `${R}/Nightly/two`, content: "y", tags: [`${R}-nightly`] });
    const count = await vcall("query-notes", { tag: `${R}-nightly`, aggregate: { op: "count" } });
    expect(Array.isArray(count) && count.length === 1 && Number.isInteger(count[0].value)).toBe(true);
    expect(count[0].value).toBe(2);
    const doc = await vcall("doctor", {});
    expect(Array.isArray(doc.findings)).toBe(true);
    const made = await vcall("create-note", { path: `${R}/System/nightly`, content: "nightly report", tags: ["system"], metadata: { run: "made-up" } });
    expect(made.id).toBeString();
    const page = await vcall("query-notes", { path: `${R}/System/nightly`, include_content: true });
    const ex = Array.isArray(page) ? page[0] : page.notes?.[0] ?? page;
    expect(ex.id).toBe(made.id);
    expect(ex.updatedAt).toBeString();
    await vcall("update-note", { id: ex.id, content: "nightly report v2", metadata: { run: "again" }, if_updated_at: ex.updatedAt, include_content: false });
    await vcall("update-note", { id: ex.id, append: "\n## Undone" });
    const after = (await api.get(`/notes/${enc(ex.id)}`)).body;
    expect(after.content).toBe("nightly report v2\n## Undone");
    expect(after.metadata).toEqual({ run: "again" });
  });

  test("Hermes: create-note then query-notes {vault, id, include_content} over loopback", async () => {
    const d = door("loopback", "base64");
    const made = await d.tool("create-note", { vault: V, path: `${R}/Hermes/note`, content: "from hermes", tags: ["made-up"] });
    const id = made.id ?? made.note?.id;
    expect(id).toBeString();
    const q = await d.tool("query-notes", { vault: V, id, include_content: true });
    expect(JSON.stringify(q)).toContain("from hermes");
  });

  test("the Uni app: create-note with if_exists:'ignore' is idempotent; update-note with a state_transition; an upload ticket spent with a bare PUT", async () => {
    const d = door("tailnet", "base64url");
    const entry = { vault: V, content: "a made-up journal entry", path: `${R}/Journal/2026-10-27 entry`, tags: ["journal"], metadata: { source: "voice", client: "uni-app", entry_id: `${R}-e1` }, if_exists: "ignore" };
    const first = await d.tool("create-note", entry);
    const again = await d.tool("create-note", entry);
    const note = first.id ? first : first.note;
    expect(note.id).toBeString();
    expect((again.id ?? again.note?.id)).toBe(note.id);
    expect(again.existed).toBe(true);

    const moved = await d.tool("update-note", { vault: V, id: note.id, include_content: false, if_updated_at: note.updatedAt, state_transition: { field: "status", from: null, to: "filed" }, metadata: { status: "filed" } });
    expect(JSON.stringify(moved)).toContain("filed");

    const bytes = new Uint8Array(128).fill(7);
    const ticket = await d.tool("request-attachment-upload", { vault: V, note: note.id, filename: "entry.m4a", mime_type: "audio/mp4", size_bytes: bytes.length, transcribe: true });
    const path = new URL(ticket.url).pathname;
    const prefix = `/vault/${V}/tickets/`;
    expect(path.startsWith(prefix)).toBe(true);
    const id = path.slice(prefix.length);
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toContain("/");
    // The app re-roots the ticket on the origin it reached and PUTs the bytes with no Authorization (parachute.rs:1470-1482).
    const put = await safeFetch(`${s.hub}${prefix}${id}`, { method: "PUT", headers: { "content-type": "audio/mp4" }, body: bytes });
    expect(put.status).toBeLessThan(300);
    const again2 = await safeFetch(`${s.hub}${prefix}${id}`, { method: "PUT", headers: { "content-type": "audio/mp4" }, body: bytes });
    expect(again2.status).toBeGreaterThanOrEqual(400); // single-use
    const atts = await rest(s.vaultViaHub, scriptToken).get(`/notes/${enc(note.id)}/attachments`);
    expect((Array.isArray(atts.body) ? atts.body : atts.body.attachments).length).toBe(1);
  });
});

// ── the box itself ──────────────────────────────────────────────────────────────────────────────────────────

/** pids with an open fd on `file`. */
function holders(file: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      for (const fd of readdirSync(`/proc/${name}/fd`)) {
        try {
          if (readlinkSync(`/proc/${name}/fd/${fd}`) === file) {
            out.push(Number(name));
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return out;
}

describe("compat/uni: the box", () => {
  test("backup jobs: a read-only sqlite .backup of vault.db and hub.db while the box runs gives a database with the notes in it", async () => {
    const db = join(s.home, "vault", "data", V, "vault.db");
    const n = await seed({ path: `${R}/Backup/marker`, content: "in the backup", tags: ["made-up"] });
    const out = join(s.home, "..", `backup-${R}.db`);
    const b = Bun.spawnSync(["sqlite3", "-readonly", db, `.backup '${out}'`]);
    expect(b.exitCode).toBe(0);
    const { Database } = await import("bun:sqlite");
    const copy = new Database(out, { readonly: true });
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(copy.query("SELECT id, path FROM notes WHERE id = ?").get(n.id)).toEqual({ id: n.id, path: `${R}/Backup/marker` });
    copy.close();
    const hb = Bun.spawnSync(["sqlite3", "-readonly", join(s.home, "hub.db"), `.backup '${out}.hub'`]);
    expect(hb.exitCode).toBe(0);
    const hubCopy = new Database(`${out}.hub`, { readonly: true });
    expect(hubCopy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect((hubCopy.query("SELECT COUNT(*) AS n FROM signing_keys").get() as { n: number }).n).toBeGreaterThan(0);
    hubCopy.close();
  });

  test("exactly one process holds the running box's vault.db, and it is the vault", () => {
    const pids = holders(join(s.home, "vault", "data", V, "vault.db"));
    expect(pids.length).toBe(1);
    const cmd = readFileSync(`/proc/${pids[0]}/cmdline`, "utf8").split("\0").join(" ");
    expect(cmd).toMatch(/vault\/src\/cli\.ts serve|parachute-vault(\.ts)? serve|parachute(\.ts)? serve/);
  });

  test("a restart leaves services.json, vault/config.yaml and vault/.env byte-identical, keeps the data, and one process holds vault.db", async () => {
    // Its own box in its own network namespace (the shared box holds :1940 here); see _restart-box.ts.
    const p = Bun.spawn(["unshare", "--net", "--fork", "--kill-child", "--", "sh", "-c", `ip link set lo up && exec "${process.execPath}" "${join(import.meta.dir, "_restart-box.ts")}"`], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const line = out.trim().split("\n").pop() ?? "";
    let rep: any;
    try {
      rep = JSON.parse(line);
    } catch {
      throw new Error(`restart driver gave no report: ${out.slice(-800)} ${err.slice(-800)}`);
    }
    if (rep.error) throw new Error(`restart driver: ${rep.error}`);
    expect(rep.secondUp).toBe(true);
    expect(rep.readAfter).toEqual(["restart/one"]);
    for (const f of ["services.json", "vault/config.yaml", "vault/.env"]) {
      expect(rep.firstBoot[f]).toBeString();
      expect(rep.afterStop[f]).toBe(rep.firstBoot[f]);
      expect(rep.secondBoot[f]).toBe(rep.firstBoot[f]);
    }
    for (const holdersAt of [rep.holdersFirst, rep.holdersSecond]) {
      const dbs = Object.keys(holdersAt);
      expect(dbs.length).toBe(1);
      expect(holdersAt[dbs[0]!].length).toBe(1);
    }
  }, 110_000);
});
