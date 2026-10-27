/**
 * Tests for `GET /api/me` — the public who-am-I endpoint that powers the
 * signed-in indicator on hub-served surfaces (discovery server-rendered
 * + admin SPA fetched). Covers:
 *   - Method gate (non-GET → 405).
 *   - No session → minimal `{ hasSession: false }`, no CSRF, no Set-Cookie.
 *   - Active session → full payload with displayName + CSRF.
 *   - Session-cookie present but row deleted → `{ hasSession: false }`.
 *   - CSRF cookie reused when present, minted + Set-Cookie when absent.
 *   - CSRF token bound to the cookie (consumer can submit it back).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiMe } from "../api-me.ts";
import { CSRF_COOKIE_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { createUser } from "../users.ts";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-me-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function withSession(): Promise<{ cookie: string; userId: string; sid: string }> {
  const user = await createUser(harness.db, "aaron", "pw");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id, sid: session.id };
}

describe("handleApiMe", () => {
  test("405 on non-GET", async () => {
    const req = new Request("http://hub.test/api/me", { method: "POST" });
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(405);
  });

  test("no session cookie → { hasSession: false }, no CSRF, no Set-Cookie", async () => {
    const req = new Request("http://hub.test/api/me");
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { hasSession: boolean; user?: unknown; csrf?: string };
    expect(body.hasSession).toBe(false);
    expect(body.user).toBeUndefined();
    expect(body.csrf).toBeUndefined();
  });

  test("session cookie pointing at deleted session → { hasSession: false }", async () => {
    const { cookie, sid } = await withSession();
    deleteSession(harness.db, sid);
    const req = new Request("http://hub.test/api/me", { headers: { cookie } });
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasSession: boolean };
    expect(body.hasSession).toBe(false);
  });

  test("active session → full payload with user + CSRF token", async () => {
    const { cookie, userId } = await withSession();
    const req = new Request("http://hub.test/api/me", { headers: { cookie } });
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      hasSession: boolean;
      user?: { id: string; displayName: string };
      csrf?: string;
    };
    expect(body.hasSession).toBe(true);
    expect(body.user?.id).toBe(userId);
    expect(body.user?.displayName).toBe("aaron");
    expect(typeof body.csrf).toBe("string");
    expect((body.csrf ?? "").length).toBeGreaterThan(20);
  });

  test("active session + no CSRF cookie → mints token + Set-Cookie attached", async () => {
    const { cookie } = await withSession();
    const req = new Request("http://hub.test/api/me", { headers: { cookie } });
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${CSRF_COOKIE_NAME}=`);
    // The token in the JSON body must match the value being set in the
    // cookie — that's the consumer's contract for submitting it back.
    const body = (await res.json()) as { csrf?: string };
    const cookieValueMatch = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([A-Za-z0-9_-]+)`));
    expect(cookieValueMatch?.[1]).toBe(body.csrf);
  });

  test("active session + CSRF cookie already present → reuses token, no Set-Cookie", async () => {
    const { cookie } = await withSession();
    const csrfToken = generateCsrfToken();
    const csrfCookie = buildCsrfCookie(csrfToken).split(";")[0]!; // just `name=value`
    const combinedCookie = `${cookie}; ${csrfCookie}`;
    const req = new Request("http://hub.test/api/me", { headers: { cookie: combinedCookie } });
    const res = handleApiMe(req, { db: harness.db });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { csrf?: string };
    expect(body.csrf).toBe(csrfToken);
  });

  test("two distinct requests (no CSRF cookie either way) get distinct freshly-minted tokens", async () => {
    // Pin that the CSRF token is request-randomized when no cookie is
    // present. Two requests from the same session, neither carrying a
    // CSRF cookie, get two different tokens. Real consumers carry the
    // first response's Set-Cookie back on subsequent requests, so this
    // path is operationally rare — but the entropy property is still
    // load-bearing for the no-cookie cold-start case.
    const { cookie } = await withSession();
    const resA = handleApiMe(new Request("http://hub.test/api/me", { headers: { cookie } }), {
      db: harness.db,
    });
    const resB = handleApiMe(new Request("http://hub.test/api/me", { headers: { cookie } }), {
      db: harness.db,
    });
    const bodyA = (await resA.json()) as { csrf?: string };
    const bodyB = (await resB.json()) as { csrf?: string };
    expect(bodyA.csrf).toBeDefined();
    expect(bodyB.csrf).toBeDefined();
    expect(bodyA.csrf).not.toBe(bodyB.csrf);
  });
});
