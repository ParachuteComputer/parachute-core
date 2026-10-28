// embedded/hostile-local (PLAN §3 "Boundary, stated"): loopback binds and 0600 files keep other users out, not
// code running as the same user, so every admin, module and token route must refuse a loopback caller without the
// right token: no token, a vault read, write or vault-admin token, or a forged operator token, with spoofed
// X-Forwarded-For/X-Real-IP: 127.0.0.1. Each probe gets a 4xx, and afterwards nothing it asked for happened (the
// operator's token still works, no account was added, the vault still serves). The routes are in _hostile.ts.
// Box mode is green today (run in a network of its own, so stop/restart probes can't touch the suite's own box,
// hostile.run.ts). Embedded mode: green since lane C (packages/cli/src/embedded.ts), set up with `bootstrap --embedded`
// (embeddedHome(), lane E).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { newHome, safeFetch } from "../candidate-lib.ts";
import { claims, embeddedHome, inOwnNetwork, mintJwt, must } from "./_lib.ts";
import { effects, forged, notRefused } from "./_hostile.ts";

let box: any;
const boxRun = async () => (box ??= await inOwnNetwork("hostile.run.ts"));

describe("embedded/hostile-local", () => {
  test("setup works today (positive controls): the operator's token opens an admin route, and a write token reads notes", async () => {
    const r = await boxRun();
    expect(r.controls).toEqual({ operatorOnModules: 200, writeReadsNotes: 200 });
  });

  for (const who of ["none", "read", "write", "vaultAdmin", "forgedOperator"] as const) {
    const label = { none: "no token", read: "a vault read token", write: "a vault write token", vaultAdmin: "a vault admin token", forgedOperator: "a forged operator token" }[who];
    test(`box: with ${label}, a loopback caller is refused on every admin, module and token route`, async () => {
      expect((await boxRun()).notRefused[who]).toEqual([]);
    });
  }

  test("box: after all those probes, nothing they asked for has happened", async () => {
    expect((await boxRun()).effects).toEqual([]);
  });

  test(
    "embedded: no token, vault tokens and a forged operator token are refused on every admin, module and token route, and change nothing", async () => {
      const e = await embeddedHome(newHome("hostile"));
      try {
        const operator = readFileSync(e.boot.operator_token_file, "utf8").trim();
        const jti = claims(operator)?.jti;
        const v = e.vaultName;
        const read = (await mintJwt(e.home, `vault:${v}:read`)).token;
        const write = (await mintJwt(e.home, `vault:${v}:write`)).token;
        const vaultAdmin = (await mintJwt(e.home, `vault:${v}:read vault:${v}:write vault:${v}:admin`)).token;
        const control = await safeFetch(`${e.hub}/api/modules`, { headers: { authorization: `Bearer ${operator}` } });
        must(control.status === 200 || control.status === 409, `setup: the operator's token doesn't open GET /api/modules (${control.status})`);
        for (const [who, token] of [["no token", undefined], ["read", read], ["write", write], ["forged operator", forged(operator)]] as const) {
          const got = await notRefused(e.hub, v, jti, token);
          must(got.length === 0, `with ${who}: not refused: ${got.join(", ")}`);
        }
        const got = (await notRefused(e.hub, v, jti, vaultAdmin)).filter((l) => !l.includes(`/vault/${v}/api/tags/`));
        must(got.length === 0, `with a vault admin token: not refused: ${got.join(", ")}`);
        const done = await effects(e.hub, e.vault, v, operator, write);
        must(done.length === 0, `the probes had effects: ${done.join("; ")}`);
      } finally {
        await e.stop();
      }
    },
  );
});
