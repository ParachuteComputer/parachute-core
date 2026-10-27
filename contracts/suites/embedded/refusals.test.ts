// embedded/refusals (PLAN §3 "Managed by the host", §3.1 R1; Benjamin's E1; G/CONTRACT.md "Marker"): while
// `serve --embedded` holds a home, the host manages Parachute, so nothing else may start, install, upgrade,
// expose, migrate or (re)start parts of it:
//   - `parachute-vault serve` exits 2 with managed_by_host (a second vault on the same vault.db is the failure
//     Prism's suite would otherwise cause, run.mjs:402-405);
//   - install, upgrade, expose, migrate and module commands exit 2 the same way, and change nothing;
//   - the matching HTTP routes answer 409 {"error":{"code":"managed_by_host",…}}, even to the operator's token.
// Today there is no embedded mode. Lane C turns these green.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cli, freePort, newHome, safeFetch, start, until, allowOrigins } from "../candidate-lib.ts";
import { red } from "../lib.ts";
import { NO_EMBEDDED, diff, embeddedHome, exitWithin, must, snapshot, tail } from "./_lib.ts";

const REFUSED_COMMANDS = [
  ["install", "vault"],
  ["upgrade"],
  ["expose", "tailnet"],
  ["migrate"],
  ["start", "vault"],
  ["stop", "vault"],
  ["restart", "vault"],
  ["uninstall", "vault"],
];

const REFUSED_ROUTES = [
  ["POST", "/api/modules/vault/install"],
  ["POST", "/api/modules/vault/upgrade"],
  ["POST", "/api/modules/vault/uninstall"],
  ["POST", "/api/modules/vault/restart"],
  ["POST", "/api/modules/vault/stop"],
  ["POST", "/api/hub/upgrade"],
];

describe("embedded/refusals", () => {
  test("setup works today (positive control): outside embedded mode, parachute-vault serve starts and answers", async () => {
    const home = newHome("refuse");
    expect((await cli(home, ["create", "r1", "--no-mirror", "--json"], { vault: true })).code).toBe(0);
    const port = await freePort();
    allowOrigins(`http://127.0.0.1:${port}`);
    const s = start(home, ["serve"], { vault: true, env: { PORT: String(port), EMBEDDINGS_ENABLED: "false" } });
    try {
      expect(await until(async () => (await safeFetch(`http://127.0.0.1:${port}/health`)).status === 200, 30_000)).toBe(true);
    } finally {
      await s.stop();
    }
  });

  red("while serve --embedded holds the home, parachute-vault serve exits 2 with managed_by_host", { reason: NO_EMBEDDED, lane: "C" }, async () => {
    const e = await embeddedHome(newHome("refuse"));
    try {
      const port = await freePort([e.hubPort, e.vaultPort]);
      const s = start(e.home, ["serve"], { vault: true, env: { PORT: String(port) } });
      const code = await exitWithin(s, 20_000);
      await s.stop("SIGKILL", 2000);
      must(code === 2, `parachute-vault serve: ${code === null ? "still running after 20 s" : `exit ${code}`}, want 2: ${tail(s.log())}`);
      must(/managed_by_host/.test(s.log()), `parachute-vault serve didn't say managed_by_host: ${tail(s.log())}`);
    } finally {
      await e.stop();
    }
  });

  red(
    "while serve --embedded holds the home, install, upgrade, expose, migrate and module commands exit 2 with managed_by_host and change nothing",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const e = await embeddedHome(newHome("refuse"));
      try {
        const services = () => {
          try {
            return readFileSync(`${e.home}/services.json`, "utf8");
          } catch {
            return "";
          }
        };
        const before = snapshot(e.home);
        const servicesBefore = services();
        for (const args of REFUSED_COMMANDS) {
          const r = await cli(e.home, args, { timeoutMs: 30_000 });
          must(r.code === 2, `parachute ${args.join(" ")}: exit ${r.code}, want 2: ${tail(r.stderr || r.stdout)}`);
          must(/managed_by_host/.test(r.stdout + r.stderr), `parachute ${args.join(" ")} didn't say managed_by_host: ${tail(r.stderr || r.stdout)}`);
        }
        must(services() === servicesBefore, "services.json changed");
        // The databases change as serve works; nothing else may appear or go.
        const changed = diff(before, snapshot(e.home)).filter((l) => !/\.db(-wal|-shm)?$/.test(l) && !l.includes("run/"));
        must(changed.length === 0, `the refused commands changed the home: ${changed.join(", ")}`);
        must(e.proc.exitCode === null, "serve --embedded stopped");
      } finally {
        await e.stop();
      }
    },
  );

  red(
    "while serve --embedded holds the home, install/upgrade/module routes answer 409 managed_by_host, even to the operator",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const e = await embeddedHome(newHome("refuse"));
      try {
        const operator = readFileSync(e.boot.operator_token_file, "utf8").trim();
        for (const [method, path] of REFUSED_ROUTES) {
          const r = await safeFetch(`${e.hub}${path}`, {
            method,
            headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
            body: "{}",
          });
          const text = await r.text();
          let body: any;
          try {
            body = JSON.parse(text);
          } catch {}
          must(r.status === 409, `${method} ${path}: HTTP ${r.status}, want 409: ${text.slice(0, 200)}`);
          must(body?.error?.code === "managed_by_host", `${method} ${path}: body ${text.slice(0, 200)}, want {"error":{"code":"managed_by_host"}}`);
        }
      } finally {
        await e.stop();
      }
    },
  );
});
