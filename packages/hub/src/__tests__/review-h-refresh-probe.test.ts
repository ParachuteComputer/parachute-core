// Reviewer "h" probes for PR #22 (refresh ignores an unmatched resource; refused /oauth/token answers logged).
// Each test is an attack the change could plausibly have opened. They are expected to PASS on the shipped code;
// a failure here would be a finding.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveClient, registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { REFRESH_GRACE_MS, findRefreshToken, signRefreshToken, validateAccessToken } from "../jwt-sign.ts";
import { handleToken } from "../oauth-handlers.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.example";
const DEPS = {
  issuer: ISSUER,
  hubBoundOrigins: () => [ISSUER],
  knownIssuers: () => ["https://old.example"],
  loadServicesManifest: () => ({ services: [] }),
};

async function setup(scopes: string[]) {
  const configDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "phub-h-"));
  const db = openHubDb(hubDbPath(configDir));
  const user = await createUser(db, "owner", "pw");
  const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
  approveClient(db, reg.client.clientId);
  const minted = signRefreshToken(db, {
    jti: `jti-${randomBytes(6).toString("hex")}`,
    userId: user.id,
    clientId: reg.client.clientId,
    scopes,
  });
  return {
    db,
    clientId: reg.client.clientId,
    refresh: minted.token,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function refreshReq(fields: Record<string, string>): Request {
  return new Request(`${ISSUER}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", ...fields }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { out: await fn(), lines };
  } finally {
    console.warn = original;
  }
}

describe("review h: refresh with a crafted resource never widens", () => {
  test("single-vault grant: no crafted resource yields an audience or scope beyond vault jon", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      let refresh = s.refresh;
      const crafted = [
        `${ISSUER}/vault/boulder/mcp`,
        "http://127.0.0.1:1940/vault/boulder/mcp",
        "http://[::1]:9/vault/boulder/.well-known/oauth-protected-resource",
        "https://old.example/vault/boulder/mcp",
        `${ISSUER}/vault/jon/../boulder/mcp`,
        `${ISSUER}/vault/JON/mcp`,
        `${ISSUER}/vault/jon%2F..%2Fboulder/mcp`,
        `${ISSUER}/vault/%62oulder/mcp`,
        `${ISSUER}/mcp`,
        `${ISSUER}/.well-known/oauth-protected-resource/mcp`,
        "https://evil.example/vault/jon/mcp",
        "",
      ];
      for (const resource of crafted) {
        const res = await handleToken(s.db, refreshReq({ refresh_token: refresh, client_id: s.clientId, resource }), DEPS);
        expect({ resource, status: res.status }).toEqual({ resource, status: 200 });
        const body = (await res.json()) as { access_token: string; refresh_token: string; scope: string };
        expect({ resource, scope: body.scope }).toEqual({ resource, scope: "vault:jon:read" });
        const { payload } = await validateAccessToken(s.db, body.access_token, ISSUER);
        expect({ resource, aud: payload.aud }).toEqual({ resource, aud: "vault.jon" });
        // The rotated row keeps the grant's scopes exactly.
        expect(findRefreshToken(s.db, body.refresh_token)?.scopes).toEqual(["vault:jon:read"]);
        refresh = body.refresh_token;
      }
    } finally {
      s.cleanup();
    }
  });

  test("multi-vault grant: a resource picks one granted vault, an ignored one reverts to the grant's own, scopes never change", async () => {
    const grant = ["vault:jon:read", "vault:boulder:write"];
    const s = await setup(grant);
    try {
      const step = async (refresh: string, resource?: string) => {
        const res = await handleToken(
          s.db,
          refreshReq({ refresh_token: refresh, client_id: s.clientId, ...(resource ? { resource } : {}) }),
          DEPS,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { access_token: string; refresh_token: string; scope: string };
        expect(body.scope).toBe(grant.join(" "));
        expect(findRefreshToken(s.db, body.refresh_token)?.scopes).toEqual(grant);
        const aud = (await validateAccessToken(s.db, body.access_token, ISSUER)).payload.aud;
        return { aud, refresh: body.refresh_token };
      };
      const a = await step(s.refresh, `${ISSUER}/vault/boulder/mcp`);
      expect(a.aud).toBe("vault.boulder");
      const b = await step(a.refresh, `${ISSUER}/vault/other/mcp`);
      expect(b.aud).toBe("vault.jon"); // reverts to inferAudience(grant), not to "boulder" and not wider
      const c = await step(b.refresh);
      expect(c.aud).toBe("vault.jon");
    } finally {
      s.cleanup();
    }
  });
});

describe("review h: rotation and reuse detection survive the tolerant refresh", () => {
  test("replaying a rotated token past the grace window (with an ignored resource) still revokes the family", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      let nowMs = Date.now();
      const deps = { ...DEPS, now: () => new Date(nowMs) };
      const odd = "https://evil.example/vault/other/mcp";
      const r1 = await handleToken(s.db, refreshReq({ refresh_token: s.refresh, client_id: s.clientId, resource: odd }), deps);
      expect(r1.status).toBe(200);
      const t1 = ((await r1.json()) as { refresh_token: string }).refresh_token;
      nowMs += REFRESH_GRACE_MS + 1000;
      const replay = await handleToken(s.db, refreshReq({ refresh_token: s.refresh, client_id: s.clientId, resource: odd }), deps);
      expect(replay.status).toBe(400);
      expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
      // Theft response: the live descendant is dead too.
      const after = await handleToken(s.db, refreshReq({ refresh_token: t1, client_id: s.clientId }), deps);
      expect(after.status).toBe(400);
    } finally {
      s.cleanup();
    }
  });

  test("grace-window replay with a resource outside the grant rotates the tip and stays on the grant's vault", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      const r1 = await handleToken(s.db, refreshReq({ refresh_token: s.refresh, client_id: s.clientId }), DEPS);
      expect(r1.status).toBe(200);
      const replay = await handleToken(
        s.db,
        refreshReq({ refresh_token: s.refresh, client_id: s.clientId, resource: `${ISSUER}/vault/boulder/mcp` }),
        DEPS,
      );
      expect(replay.status).toBe(200);
      const body = (await replay.json()) as { access_token: string; scope: string };
      expect(body.scope).toBe("vault:jon:read");
      expect((await validateAccessToken(s.db, body.access_token, ISSUER)).payload.aud).toBe("vault.jon");
    } finally {
      s.cleanup();
    }
  });
});

describe("review h: the refused-token log line", () => {
  test("no CR/LF/ESC and no secret value reaches the log, whatever the request carries", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      const secrets = {
        refresh_token: `RTSECRET${randomBytes(8).toString("hex")}`,
        client_secret: `CSSECRET${randomBytes(8).toString("hex")}`,
        code: `CODESECRET${randomBytes(8).toString("hex")}`,
        code_verifier: `VERIFIERSECRET${randomBytes(8).toString("hex")}`,
        password: "PWSECRET",
      };
      const nasty = "x\r\n[oauth] FAKE\u001b[31m";
      const requests: Record<string, string>[] = [
        { grant_type: nasty, client_id: nasty, resource: `http://127.0.0.1/vault/jon/mcp?${nasty}`, ...secrets },
        { grant_type: "refresh_token", client_id: `ab\u001b[2J${nasty}`, ...secrets, resource: nasty },
        { grant_type: "authorization_code", client_id: s.clientId, ...secrets, redirect_uri: "https://app.example/cb", resource: `https://evil.example/${nasty}` },
        { grant_type: "refresh_token", client_id: s.clientId, ...secrets, resource: `http://localhost:1/vault/${encodeURIComponent(nasty)}/mcp` },
        { grant_type: "refresh_token", client_id: "unknown-client", ...secrets, resource: `https://hub.example/vault/jon/mcp#${nasty}` },
      ];
      for (const fields of requests) {
        const { out: res, lines } = await captureWarn(() =>
          handleToken(
            s.db,
            new Request(`${ISSUER}/oauth/token`, {
              method: "POST",
              body: new URLSearchParams(fields),
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }),
            DEPS,
          ),
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(lines.length).toBe(1);
        for (const l of lines) {
          expect(l).not.toMatch(/[\r\n\u001b]/);
          expect(l).not.toContain("FAKE");
          for (const v of Object.values(secrets)) expect(l).not.toContain(v);
        }
      }
    } finally {
      s.cleanup();
    }
  });

  test("observation: an unauthenticated caller gets one log line per request, with no bound", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      const N = 500;
      const { lines } = await captureWarn(async () => {
        for (let i = 0; i < N; i++) {
          await handleToken(
            s.db,
            new Request(`${ISSUER}/oauth/token`, {
              method: "POST",
              body: new URLSearchParams({ grant_type: "x" }),
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }),
            DEPS,
          );
        }
      });
      expect(lines.length).toBe(N);
    } finally {
      s.cleanup();
    }
  });
});

// ---- Extensions (reviewer h, second pass) -------------------------------------------------------------------

function liveRows(db: ReturnType<typeof openHubDb>, refreshToken: string): number {
  const fam = findRefreshToken(db, refreshToken)?.familyId;
  const r = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM tokens WHERE family_id = ? AND revoked_at IS NULL AND refresh_token_hash IS NOT NULL",
    )
    .get(fam ?? "");
  return r?.n ?? -1;
}

describe("review h: more resource shapes", () => {
  test("encoded / cased / dotted / multi-valued resources pick only granted vaults, scopes unchanged", async () => {
    const grant = ["vault:jon:read", "vault:boulder:write"];
    const s = await setup(grant);
    try {
      let refresh = s.refresh;
      const cases: [string | string[], string][] = [
        [`${ISSUER}/vault/%62oulder/mcp`, "vault.boulder"], // percent-encoded granted name
        ["HTTPS://HUB.EXAMPLE/vault/boulder/mcp", "vault.boulder"], // scheme/host case folds
        [`${ISSUER}/vault/BOULDER/mcp`, "vault.jon"], // a different name: ignored
        ["https://hub.example./vault/boulder/mcp", "vault.jon"], // trailing-dot host is not ours: ignored
        ["http://127.0.0.2/vault/boulder/mcp", "vault.jon"], // other loopback addresses aren't recognised
        ["http://[::ffff:127.0.0.1]/vault/boulder/mcp", "vault.jon"],
        [`${ISSUER}/vault/jon/mcp/../../boulder/mcp`, "vault.boulder"], // URL normalises dot-segments
        [[`${ISSUER}/vault/other/mcp`, `${ISSUER}/vault/boulder/mcp`], "vault.jon"], // multiple: first wins, ignored
        [[`${ISSUER}/vault/boulder/mcp`, `${ISSUER}/vault/other/mcp`], "vault.boulder"],
      ];
      for (const [resource, aud] of cases) {
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: s.clientId });
        for (const r of Array.isArray(resource) ? resource : [resource]) body.append("resource", r);
        const res = await handleToken(
          s.db,
          new Request(`${ISSUER}/oauth/token`, {
            method: "POST",
            body,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
          DEPS,
        );
        expect({ resource, status: res.status }).toEqual({ resource, status: 200 });
        const out = (await res.json()) as { access_token: string; refresh_token: string; scope: string };
        expect(out.scope).toBe(grant.join(" "));
        const got = (await validateAccessToken(s.db, out.access_token, ISSUER)).payload.aud;
        expect({ resource, aud: got }).toEqual({ resource, aud });
        refresh = out.refresh_token;
      }
    } finally {
      s.cleanup();
    }
  });

  test("observation: a multi-vault grant whose saved resource names a GRANTED vault on an unknown host gets the OTHER vault's audience", async () => {
    // Not a widening (both vaults are granted) but a token for a resource the client did not ask for: the client
    // presents it at boulder, gets 401 audience mismatch, refreshes with the same resource, and loops.
    const s = await setup(["vault:jon:read", "vault:boulder:read"]);
    try {
      const res = await handleToken(
        s.db,
        refreshReq({ refresh_token: s.refresh, client_id: s.clientId, resource: "https://gone.example/vault/boulder/mcp" }),
        DEPS,
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as { access_token: string };
      expect((await validateAccessToken(s.db, out.access_token, ISSUER)).payload.aud).toBe("vault.jon");
    } finally {
      s.cleanup();
    }
  });
});

describe("review h: rotation under concurrency", () => {
  test("two concurrent refreshes of the same live token leave exactly one live refresh row (no forked lineage)", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      const fire = () =>
        handleToken(
          s.db,
          refreshReq({ refresh_token: s.refresh, client_id: s.clientId }),
          DEPS,
        );
      const [a, b] = await Promise.all([fire(), fire()]);
      const statuses = [a.status, b.status].sort();
      const tokens: string[] = [];
      for (const r of [a, b]) if (r.status === 200) tokens.push(((await r.json()) as { refresh_token: string }).refresh_token);
      // Each 200 hands out a refresh token; if both are live the family has forked and reuse detection is blind to
      // the second lineage (neither holder ever replays a revoked token).
      const live = liveRows(s.db, s.refresh);
      expect({ statuses, live }).toEqual({ statuses: [200, 400], live: 1 });
    } finally {
      s.cleanup();
    }
  });

  test("after two concurrent refreshes, a later benign retry inside the grace window still renews (hub#685)", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      let nowMs = Date.now();
      const deps = { ...DEPS, now: () => new Date(nowMs) };
      const fire = (t: string) => handleToken(s.db, refreshReq({ refresh_token: t, client_id: s.clientId }), deps);
      // A connector fires two refreshes at once (a retry racing the original) and keeps the last answer.
      const [, b] = await Promise.all([fire(s.refresh), fire(s.refresh)]);
      expect(b.status).toBe(200);
      const kept = ((await b.json()) as { refresh_token: string }).refresh_token;
      // 15 minutes later it renews normally, and a network retry of that request lands 5 s after: the hub#685 case
      // the grace window exists for. Without the earlier race this is 200 / 200.
      nowMs += 15 * 60_000;
      const r = await fire(kept);
      expect(r.status).toBe(200);
      const next = ((await r.json()) as { refresh_token: string }).refresh_token;
      nowMs += 5000;
      const retry = await fire(kept);
      const after = await fire(next);
      expect({ retry: retry.status, after: after.status }).toEqual({ retry: 200, after: 200 });
    } finally {
      s.cleanup();
    }
  });

  test("control: the same sequence without the initial race renews", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      let nowMs = Date.now();
      const deps = { ...DEPS, now: () => new Date(nowMs) };
      const fire = (t: string) => handleToken(s.db, refreshReq({ refresh_token: t, client_id: s.clientId }), deps);
      const b = await fire(s.refresh);
      const kept = ((await b.json()) as { refresh_token: string }).refresh_token;
      nowMs += 15 * 60_000;
      const r = await fire(kept);
      const next = ((await r.json()) as { refresh_token: string }).refresh_token;
      nowMs += 5000;
      const retry = await fire(kept);
      const after = await fire(next);
      expect({ retry: retry.status, after: after.status }).toEqual({ retry: 200, after: 200 });
    } finally {
      s.cleanup();
    }
  });
});

describe("review h: what the refused-token log covers", () => {
  test("client_secret_basic credentials never reach the log", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      const secret = `BASICSECRET${randomBytes(8).toString("hex")}`;
      const { out: res, lines } = await captureWarn(() =>
        handleToken(
          s.db,
          new Request(`${ISSUER}/oauth/token`, {
            method: "POST",
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "nope", client_id: s.clientId }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${s.clientId}:${secret}`).toString("base64")}`,
            },
          }),
          DEPS,
        ),
      );
      expect(res.status).toBe(400);
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain(secret);
      expect(lines[0]).not.toContain(Buffer.from(`${s.clientId}:${secret}`).toString("base64"));
    } finally {
      s.cleanup();
    }
  });

  test("a JSON body to /oauth/token: answered how, and logged?", async () => {
    const s = await setup(["vault:jon:read"]);
    try {
      let status: number | string = "?";
      const { lines } = await captureWarn(async () => {
        try {
          const r = await handleToken(
            s.db,
            new Request(`${ISSUER}/oauth/token`, {
              method: "POST",
              body: JSON.stringify({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId }),
              headers: { "content-type": "application/json" },
            }),
            DEPS,
          );
          status = r.status;
        } catch (e) {
          status = `threw ${(e as Error).name}`;
        }
      });
      expect({ status: String(status), lines: lines.length }).toEqual({ status: "400", lines: 1 });
    } finally {
      s.cleanup();
    }
  });
});

describe("review h: /oauth/token through the real listener", () => {
  test("a JSON body gets an RFC 6749 400, not Bun's development error page (stack, source, file paths)", async () => {
    const { hubServeOptions } = await import("../commands/serve.ts");
    const { hubFetch } = await import("../hub-server.ts");
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "phub-h-serve-"));
    const db = openHubDb(hubDbPath(dir));
    // NODE_ENV is "test" here; a local install (`parachute-core serve` under systemd/launchd) runs with it unset.
    // Either way Bun.serve defaults to development mode, which renders uncaught errors as an HTML debug page.
    const server = Bun.serve(
      hubServeOptions({ port: 0, hostname: "127.0.0.1", fetch: hubFetch(dir, { getDb: () => db, issuer: ISSUER }) }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "x", client_id: "y" }),
      });
      const text = await res.text();
      expect({
        status: res.status,
        ctype: res.headers.get("content-type"),
        leaksPaths: text.includes(process.cwd()) || /oauth-handlers\.ts/.test(text),
      }).toEqual({ status: 400, ctype: "application/json", leaksPaths: false });
      expect((JSON.parse(text) as { error: string }).error).toBe("invalid_request");
    } finally {
      server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
