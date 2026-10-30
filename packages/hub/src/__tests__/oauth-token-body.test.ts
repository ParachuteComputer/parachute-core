// /oauth/token with a body that isn't a form (T-318 day review, reviewer h, of core#22).
//
// core#22 made /oauth/token log every non-2xx answer. One answer it can't log: `handleToken` parses the body with
// `req.formData()` before its try, so a body that isn't form-encoded (a client posting JSON, which some OAuth clients
// do) throws out of the handler. Through the real listener (`hubServeOptions`: no `error` handler, no
// `development: false`) and with NODE_ENV unset, as the systemd/launchd unit runs the hub, Bun answers that throw
// with its development error page: ~50 KB of HTML with the stack, the source around the throw and absolute file
// paths, to an unauthenticated caller. RFC 6749 §5.2 wants `400 invalid_request`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubServeOptions } from "../commands/serve.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { handleToken } from "../oauth-handlers.ts";

const ISSUER = "https://hub.example";
const DEPS = {
  issuer: ISSUER,
  hubBoundOrigins: () => [ISSUER],
  loadServicesManifest: () => ({ services: [] }),
};

function tempDb() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "phub-token-body-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    dir,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

const SECRET_REFRESH = "RT-SECRET-not-for-logs";

describe("/oauth/token with a body that isn't a form", () => {
  test("a JSON body is answered 400 invalid_request and logged once, without the body", async () => {
    const t = tempDb();
    try {
      const { out: res, lines } = await captureWarn(() =>
        handleToken(
          t.db,
          new Request(`${ISSUER}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: SECRET_REFRESH,
              client_id: "abcdefgh",
            }),
          }),
          DEPS,
        ),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("status=400 error=invalid_request");
      expect(lines[0]).not.toContain(SECRET_REFRESH);
    } finally {
      t.cleanup();
    }
  });

  test("through the real listener: a JSON body gets the RFC 6749 JSON answer, not Bun's development error page", async () => {
    const t = tempDb();
    const server = Bun.serve(
      hubServeOptions({
        port: 0,
        hostname: "127.0.0.1",
        fetch: hubFetch(t.dir, { getDb: () => t.db, issuer: ISSUER }),
      }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: SECRET_REFRESH,
          client_id: "abcdefgh",
        }),
      });
      const text = await res.text();
      expect({
        status: res.status,
        json: (res.headers.get("content-type") ?? "").startsWith("application/json"),
        showsSource: text.includes("oauth-handlers.ts") || text.includes(process.cwd()),
      }).toEqual({ status: 400, json: true, showsSource: false });
    } finally {
      server.stop(true);
      t.cleanup();
    }
  });
});
