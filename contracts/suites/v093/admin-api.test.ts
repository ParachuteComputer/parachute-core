// 0.9.3 row 9, "One place, part 3: the admin API with one login" (T-463). A vault's admin routes (config, usage,
// embeddings, transcription, mirror, triggers) answer under the hub's one admin API, `/admin/api/vaults/<n>/...`, to
// the same sign-in as the hub's admin page: the session cookie, with the CSRF double-submit on writes. A script can use
// a vault admin key there instead. The old `/vault/<n>/.parachute/*` and `/vault/<n>/api/triggers` keep answering
// through 0.9 and say they are going (`Deprecation`, `Link`).
//
//   bun run doors -- --doors box suites/v093/admin-api.test.ts
//
// Box only: the cloud door has no hub session; the sign-in the door harness holds (cookie + CSRF) is the one under test.
import { describe, expect, test } from "bun:test";
import { door, safeFetch, token } from "../door/_door.ts";

const d = door();
if (d.signIn.how !== "cookie") throw new Error("these contracts run on a box, signed in with the hub's session cookie");
const signIn: { cookie: string; csrf: string } = d.signIn;
const NEW = `${d.issuer}/admin/api/vaults/${d.vault}`;
const OLD = `${d.vaultOrigin}/vault/${d.vault}`;

type Opts = { cookie?: boolean; csrf?: boolean | string; origin?: boolean; bearer?: string; body?: unknown; headers?: Record<string, string> };
async function call(method: string, url: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = signIn.cookie;
  if (o.csrf) headers["x-csrf-token"] = typeof o.csrf === "string" ? o.csrf : signIn.csrf;
  if (o.origin !== false && o.cookie && method !== "GET") headers.origin = d.issuer;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const r = await safeFetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body, headers: r.headers, text };
}

describe("the admin API under one login", () => {
  test("a signed-in session reads config at /admin/api/vaults/<n>/config, the same body the old route gives an admin key", async () => {
    const admin = await token("admin");
    const old = await call("GET", `${OLD}/.parachute/config`, { bearer: admin });
    expect(old.status, old.text.slice(0, 200)).toBe(200);
    const viaSession = await call("GET", `${NEW}/config`, { cookie: true });
    expect(viaSession.status, viaSession.text.slice(0, 200)).toBe(200);
    expect(viaSession.body).toEqual(old.body);
  });

  test("usage and the embeddings snapshot answer to the session too", async () => {
    expect((await call("GET", `${NEW}/usage`, { cookie: true })).status).toBe(200);
    const e = await call("GET", `${NEW}/embeddings`, { cookie: true });
    expect(e.status).toBe(200);
    expect(typeof e.body.enabled).toBe("boolean");
  });

  test("a write with the session but no CSRF token is refused; with it, it works (PUT and POST/DELETE)", async () => {
    const current = (await call("GET", `${NEW}/embeddings`, { cookie: true })).body.enabled;
    const put = await call("PUT", `${NEW}/embeddings`, { cookie: true, body: { enabled: current } });
    expect(put.status, put.text.slice(0, 200)).toBe(403);
    const wrong = await call("PUT", `${NEW}/embeddings`, { cookie: true, csrf: "not-the-token", body: { enabled: current } });
    expect(wrong.status).toBe(403);
    const ok = await call("PUT", `${NEW}/embeddings`, { cookie: true, csrf: true, body: { enabled: current } });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.body.enabled).toBe(current);

    const trig = { name: `adm${Date.now()}`, when: {}, action: { webhook: "http://127.0.0.1:9/never" } };
    const noCsrf = await call("POST", `${NEW}/triggers`, { cookie: true, body: trig });
    expect(noCsrf.status).toBe(403);
    const made = await call("POST", `${NEW}/triggers`, { cookie: true, csrf: true, body: trig });
    expect(made.status, made.text.slice(0, 200)).toBe(200);
    const listed = await call("GET", `${NEW}/triggers`, { cookie: true });
    expect(listed.body.triggers.map((t: any) => t.name)).toContain(trig.name);
    expect((await call("DELETE", `${NEW}/triggers/${trig.name}`, { cookie: true })).status).toBe(403);
    expect((await call("DELETE", `${NEW}/triggers/${trig.name}`, { cookie: true, csrf: true })).status).toBe(200);
  });

  test("a cookie write with no Origin header is refused even with the CSRF token (the hub's belt)", async () => {
    const r = await call("PUT", `${NEW}/embeddings`, { cookie: true, csrf: true, origin: false, body: { enabled: false } });
    expect(r.status).toBe(403);
  });

  test("no sign-in and no key is 401", async () => {
    expect((await call("GET", `${NEW}/config`)).status).toBe(401);
    expect((await call("POST", `${NEW}/triggers`, { body: {} })).status).toBe(401);
  });

  test("a vault key without admin is 403; an admin key works as a Bearer, for a script", async () => {
    const read = await call("GET", `${NEW}/config`, { bearer: await token("read") });
    expect(read.status, read.text.slice(0, 200)).toBe(403);
    expect((await call("GET", `${NEW}/triggers`, { bearer: await token("write") })).status).toBe(403);
    const admin = await call("GET", `${NEW}/config`, { bearer: await token("admin") });
    expect(admin.status, admin.text.slice(0, 200)).toBe(200);
    // A key of the other vault does not open this one.
    const other = await call("GET", `${d.issuer}/admin/api/vaults/${d.otherVault}/config`, { bearer: await token("admin") });
    expect([401, 403]).toContain(other.status);
  });

  test("a vault that is not there is 404 for the session", async () => {
    expect((await call("GET", `${d.issuer}/admin/api/vaults/no-such-vault-here/config`, { cookie: true })).status).toBe(404);
  });

  test("a header that claims an admin identity, from outside, opens nothing", async () => {
    for (const h of <Record<string, string>[]>[
      { "x-parachute-internal-admin": d.vault },
      { "x-parachute-admin": "1" },
      { "x-parachute-vault-admin": d.vault },
      { "x-forwarded-user": "admin", "x-parachute-layer": "loopback" },
    ]) {
      expect((await call("GET", `${NEW}/config`, { headers: h })).status).toBe(401);
      expect((await call("GET", `${OLD}/.parachute/config`, { headers: h })).status).toBe(401);
    }
  });

  test("the old routes still answer, and say they are going", async () => {
    const admin = await token("admin");
    for (const [old, successor] of [
      [`${OLD}/.parachute/config`, `/admin/api/vaults/${d.vault}/config`],
      [`${OLD}/.parachute/usage`, `/admin/api/vaults/${d.vault}/usage`],
      [`${OLD}/api/triggers`, `/admin/api/vaults/${d.vault}/triggers`],
    ] as const) {
      const r = await call("GET", old, { bearer: admin });
      expect(r.status, `${old}: ${r.text.slice(0, 200)}`).toBe(200);
      expect(r.headers.get("deprecation"), old).toBe("true");
      expect(r.headers.get("link"), old).toBe(`<${successor}>; rel="successor-version"`);
    }
    // What stays public is not marked.
    const info = await safeFetch(`${OLD}/.parachute/info`);
    expect(info.status).toBe(200);
    expect(info.headers.get("deprecation")).toBeNull();
    // The new route is not marked either.
    expect((await call("GET", `${NEW}/config`, { cookie: true })).headers.get("deprecation")).toBeNull();
  });
});
