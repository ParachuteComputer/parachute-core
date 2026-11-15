// Surface A: notes over REST. What an app does with a vault URL and a credential must work the same at every door.
import { describe, expect, test } from "bun:test";
import { door, enc, fp, fpEach, mediaType, paths, refusal, rest, runId, safeFetch, shape, token, vaultUrl } from "./_door.ts";

const api = rest("write");
const reader = rest("read");

describe("notes", () => {
  test("a note keeps its body, fields, tags and path exactly", async () => {
    const id = runId("notes");
    const content = `# Plan for ${id}\n\nUmlauts stay: Grüße, 東京, emoji 🪂.\n\n- one\n- two\n`;
    const metadata = { status: "open", due: "2026-11-02", count: 3, done: false, people: ["ana", "bo"], nested: { a: { b: [1, 2] } } };
    const made = await api.post("/notes", { content, path: `${id}/plan`, tags: ["project"], metadata });
    expect(made.status).toBe(201);
    expect(made.body.id).toBeString();
    fp("rest/note.create.shape", shape({ ...made.body, warnings: undefined }));

    for (const ref of [made.body.id, enc(`${id}/plan`)]) {
      const got = await api.get(`/notes/${ref}`);
      expect(got.status).toBe(200);
      expect(got.body.content).toBe(content);
      expect(got.body.metadata).toEqual(metadata);
      expect(got.body.tags).toEqual(["project"]);
      expect(got.body.path).toBe(`${id}/plan`);
    }
    const got = await api.get(`/notes/${made.body.id}`);
    fp("rest/note.get.shape", shape(got.body));
    fp("rest/note.get.content-type", mediaType(got.headers));
  });

  test("two notes cannot share a path", async () => {
    const path = `${runId("notes")}/same`;
    expect((await api.post("/notes", { content: "a", path })).status).toBe(201);
    const again = await api.post("/notes", { content: "b", path });
    expect(again.status).toBe(409);
    fp("rest/refusal.path-taken", refusal(again));
  });

  test("an update must say which version it saw; a stale one is refused, not merged", async () => {
    const made = await api.post("/notes", { content: "v1", path: `${runId("notes")}/cas` });
    const id = made.body.id;
    const seen = made.body.updatedAt;

    const blind = await api.patch(`/notes/${id}`, { content: "blind" });
    expect(blind.status).toBe(428);
    fp("rest/refusal.blind-update", refusal(blind));

    const first = await api.patch(`/notes/${id}`, { content: "v2", if_updated_at: seen });
    expect(first.status).toBe(200);
    expect(first.body.content).toBe("v2");
    fp("rest/note.update.shape", shape(first.body));

    const stale = await api.patch(`/notes/${id}`, { content: "v2-other", if_updated_at: seen });
    expect(stale.status).toBe(409);
    fp("rest/refusal.stale-update", refusal(stale));
    expect((await api.get(`/notes/${id}`)).body.content).toBe("v2");
  });

  test("fields merge on update; null removes one", async () => {
    const made = await api.post("/notes", { content: "x", path: `${runId("notes")}/fields`, metadata: { a: 1, b: "keep", c: true } });
    const up = await api.patch(`/notes/${made.body.id}`, { metadata: { a: 2, c: null }, if_updated_at: made.body.updatedAt });
    expect(up.status).toBe(200);
    expect((await api.get(`/notes/${made.body.id}`)).body.metadata).toEqual({ a: 2, b: "keep" });
  });

  test("tags can be added and removed without touching the body", async () => {
    const made = await api.post("/notes", { content: "body", path: `${runId("notes")}/tags`, tags: ["one"] });
    const up = await api.patch(`/notes/${made.body.id}`, { tags: { add: ["two"], remove: ["one"] }, if_updated_at: made.body.updatedAt });
    expect(up.status).toBe(200);
    const got = await api.get(`/notes/${made.body.id}`);
    expect(got.body.tags).toEqual(["two"]);
    expect(got.body.content).toBe("body");
  });

  test("a deleted note is gone by id and by path", async () => {
    const path = `${runId("notes")}/gone`;
    const made = await api.post("/notes", { content: "bye", path });
    const del = await api.del(`/notes/${made.body.id}`);
    expect(del.status).toBe(200);
    fp("rest/note.delete.shape", shape(del.body));
    const gone = await api.get(`/notes/${made.body.id}`);
    expect(gone.status).toBe(404);
    fp("rest/refusal.no-such-note", refusal(gone));
    expect((await api.get(`/notes/${enc(path)}`)).status).toBe(404);
  });

  test("several notes are made in one call, and a bad one keeps none of them", async () => {
    const r = runId("batch");
    const made = await api.post("/notes", { notes: [1, 2, 3].map((n) => ({ content: `n${n}`, path: `${r}/${n}` })) });
    expect(made.status).toBe(201);
    fp("rest/note.batch.shape", shape(made.body));
    expect(paths((await api.get(`/notes?path_prefix=${enc(`${r}/`)}`)).body)).toEqual([`${r}/1`, `${r}/2`, `${r}/3`]);

    const r2 = runId("batch");
    const bad = await api.post("/notes", { notes: [{ content: "a", path: `${r2}/a` }, { content: "b", path: `${r2}/a` }] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    fp("rest/refusal.batch-half-bad", refusal(bad));
    expect((await api.get(`/notes?path_prefix=${enc(`${r2}/`)}`)).body).toEqual([]);
  });

  test("a list is paged the same way: limit, offset, and oldest first on request", async () => {
    const r = runId("page");
    for (const n of [1, 2, 3, 4, 5]) expect((await api.post("/notes", { content: `p${n}`, path: `${r}/${n}` })).status).toBe(201);
    const q = `path_prefix=${enc(`${r}/`)}&sort=asc`;
    const first = await api.get(`/notes?${q}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.map((n: any) => n.path)).toEqual([`${r}/1`, `${r}/2`]);
    const next = await api.get(`/notes?${q}&limit=2&offset=2`);
    expect(next.body.map((n: any) => n.path)).toEqual([`${r}/3`, `${r}/4`]);
    const unsorted = await api.get(`/notes?path_prefix=${enc(`${r}/`)}&limit=1`);
    fp("rest/list.default-order", unsorted.body[0]?.path === `${r}/1` ? "oldest first" : unsorted.body[0]?.path === `${r}/5` ? "newest first" : "other");
    const desc = await api.get(`/notes?path_prefix=${enc(`${r}/`)}&limit=1&sort=desc`);
    expect(desc.body.map((n: any) => n.path)).toEqual([`${r}/5`]);
    fp("rest/list.item.shape", shape(first.body[0]));
    const full = await api.get(`/notes?${q}&limit=1&include_content=true&include_links=true&include_attachments=true`);
    fp("rest/list.item.full.shape", shape(full.body[0]));
    fp("rest/list.headers", { type: mediaType(first.headers), cursor: first.headers.has("x-next-cursor") });
  });

  test("a long list is walked with a cursor: each page names the next", async () => {
    const r = runId("cursor");
    for (const n of [1, 2, 3]) expect((await api.post("/notes", { content: `c${n}`, path: `${r}/${n}` })).status).toBe(201);
    const q = `path_prefix=${enc(`${r}/`)}&limit=2`;
    const first = await api.get(`/notes?${q}&cursor=`);
    expect(first.status, JSON.stringify(first.body).slice(0, 200)).toBe(200);
    fp("rest/cursor.page.shape", shape({ ...first.body, notes: first.body.notes?.slice(0, 1) }));
    expect(first.body.notes.length).toBe(2);
    expect(first.body.next_cursor).toBeString();
    const second = await api.get(`/notes?${q}&cursor=${enc(first.body.next_cursor)}`);
    expect(second.status).toBe(200);
    expect(paths([...first.body.notes, ...second.body.notes])).toEqual([`${r}/1`, `${r}/2`, `${r}/3`]);
    const bad = await api.get(`/notes?${q}&cursor=not-a-cursor`);
    fp("rest/refusal.bad-cursor", refusal(bad));
  });

  test("a note without a path is kept and found by id", async () => {
    const made = await api.post("/notes", { content: `pathless ${runId("p")}` });
    expect(made.status).toBe(201);
    const got = await api.get(`/notes/${made.body.id}`);
    expect(got.status).toBe(200);
    fp("rest/note.pathless", { path: got.body.path ?? null });
  });
});

describe("who may do what", () => {
  test("no credential, no notes; the refusal says how to sign in", async () => {
    const r = await safeFetch(`${vaultUrl()}/api/notes`);
    expect(r.status).toBe(401);
    const body = await r.json().catch(() => ({}));
    fp("rest/refusal.no-credential", { status: r.status, keys: Object.keys(body).sort(), error: body.error ?? null, www: (r.headers.get("www-authenticate") ?? "").replace(/"[^"]*"/g, '"…"') });
  });

  test("a made-up credential is refused", async () => {
    const r = await safeFetch(`${vaultUrl()}/api/notes`, { headers: { authorization: "Bearer not-a-real-credential" } });
    expect(r.status).toBe(401);
    const body = await r.json().catch(() => ({}));
    fp("rest/refusal.bad-credential", { status: r.status, keys: Object.keys(body).sort(), error: body.error ?? null });
  });

  test("a read credential reads and cannot write", async () => {
    const path = `${runId("ro")}/x`;
    expect((await api.post("/notes", { content: "x", path })).status).toBe(201);
    expect((await reader.get(`/notes/${enc(path)}`)).status).toBe(200);
    const write = await reader.post("/notes", { content: "no", path: `${path}-2` });
    expect(write.status).toBe(403);
    fp("rest/refusal.read-credential-writes", refusal(write));
    const del = await reader.del(`/notes/${enc(path)}`);
    expect(del.status).toBe(403);
  });

  test("a credential for one vault opens no other", async () => {
    const d = door();
    const other = rest("write", d.otherVault);
    expect((await other.get("/notes?limit=1")).status).toBe(200);
    const mine = await token("write");
    const r = await safeFetch(`${vaultUrl(d.otherVault)}/api/notes?limit=1`, { headers: { authorization: `Bearer ${mine}` } });
    expect([401, 403]).toContain(r.status);
    const body = await r.json().catch(() => ({}));
    fp("rest/refusal.other-vault", { status: r.status, error: body.error ?? null });
  });

  test("a browser app on another origin may call the vault (CORS)", async () => {
    const pre = await safeFetch(`${vaultUrl()}/api/notes`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    expect(pre.status).toBeLessThan(300);
    const allow = (h: string) => (pre.headers.get(h) ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(pre.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(allow("access-control-allow-headers")).toContain("authorization");
    fp("rest/cors.preflight", { status: pre.status, origin: pre.headers.get("access-control-allow-origin"), methods: allow("access-control-allow-methods"), headers: allow("access-control-allow-headers") });
    const got = await safeFetch(`${vaultUrl()}/api/notes?limit=1`, { headers: { origin: "https://app.example", authorization: `Bearer ${await token("read")}` } });
    fp("rest/cors.reply", { origin: got.headers.get("access-control-allow-origin") });
  });
});

describe("the vault itself", () => {
  test("a vault says what it is", async () => {
    const admin = rest("admin");
    const described = await admin.patch("/vault", { description: "Made-up vault for the door contracts." });
    expect(described.status, JSON.stringify(described.body)).toBe(200);
    const info = await reader.get("/vault");
    expect(info.status).toBe(200);
    expect(info.body.name).toBe(door().vault);
    expect(info.body.description).toBe("Made-up vault for the door contracts.");
    fpEach("rest/vault", info.body);
    const root = await reader.call("GET", "");
    expect(root.status).toBe(200);
    fpEach("rest/vault-root", root.body);
  });

  test("the description is the owner's: a write credential cannot change it", async () => {
    const r = await api.patch("/vault", { description: "no" });
    expect(r.status).toBe(403);
    fp("rest/refusal.describe-without-admin", refusal(r));
  });

  test("an unknown route says so", async () => {
    const r = await reader.get("/no-such-route");
    expect(r.status).toBe(404);
    fp("rest/refusal.no-such-route", refusal(r));
  });

  test("a new vault starts with the same notes at every door", async () => {
    const d = door();
    const fresh = await rest("read", d.otherVault).get("/notes?limit=100&sort=asc");
    expect(fresh.status).toBe(200);
    // Other suites (consent, multivault) write run-scoped notes (`<label><8 hex>/…`) into this vault; which ran first
    // depends on file order, so only the vault's own starting notes are the fact.
    fp("rest/new-vault.notes", paths(fresh.body).filter((p: string) => !/^[a-z]+-?[0-9a-f]{8}\//.test(p)));
    const tags = await rest("read", d.otherVault).get("/tags");
    fp("rest/new-vault.tags", tags.body.map((t: any) => t.name).sort());
  });
});
