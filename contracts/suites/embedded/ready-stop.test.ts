// embedded/ready-stop (PLAN §3 "Ready and stop", "Nothing outside the home", §2.2 item 1; Benjamin's E1/E2):
//   - /api/ready is 200 only once both databases are migrated and the vault answers, and run/ready.json exists then;
//   - SIGTERM: exit 0 within 10 s, ready.json removed, both ports closed;
//   - it exits when its parent dies: the pid given by --parent-pid, or the process that started it;
//   - nothing is written outside the home: the throwaway user HOME has no new entry afterwards, Bun's transpiler
//     cache included (today's stock run writes .bun/install/cache into $HOME, one of the 3 FAILs in Benjamin's suite).
// Today there is no embedded mode, and /api/ready is true before any module has started (hub src/api-ready.ts).
// Lane C turns these green (E2 with lane D's bundle).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { candidateEnv } from "../../harness/candidate.ts";
import { candidate, cli, listeners, listeningProcesses, newHome, safeFetch, until } from "../candidate-lib.ts";
import { red, services } from "../lib.ts";
import { NO_EMBEDDED, embeddedHome, exitWithin, exited, mint, must, ports, readyJson, serveEmbedded, snapshot, tail } from "./_lib.ts";

const closed = (...ps: number[]) => !listeners().some((l) => ps.some((p) => l.endsWith(`:${p}`)));

/** New entries in the user HOME around the home, leaving out the home, TMPDIR and the logs this suite writes. */
function outsideHome(home: string, before: Set<string>): string[] {
  return [...snapshot(dirname(home)).keys()].filter(
    (p) => !before.has(p) && !p.startsWith(".parachute") && p !== "tmp" && !p.startsWith("tmp/") && !/^[^/]+\.log$/.test(p) && p !== "admin-password",
  );
}

describe("embedded/ready-stop", () => {
  test("setup works today: the suite's box answers /api/ready", async () => {
    expect((await safeFetch(`${services().hub}/api/ready`)).status).toBe(200);
  });

  red("/api/ready is 200 only once the vault answers, and ready.json exists by then", { reason: NO_EMBEDDED, lane: "C" }, async () => {
    const e = await serveEmbedded(newHome("ready"), { ready: false });
    try {
      let ready = false;
      const deadline = Date.now() + 45_000;
      while (!ready && Date.now() < deadline && !exited(e)) {
        ready = await safeFetch(`${e.hub}/api/ready`).then((r) => r.status === 200, () => false);
        if (!ready) await Bun.sleep(25);
      }
      must(!exited(e), `serve --embedded exited ${e.proc.exitCode}: ${tail(e.log())}`);
      must(ready, "/api/ready never answered 200");
      const v = await safeFetch(`${e.vault}/health`).catch(() => ({ status: 0 }));
      must(v.status === 200, `/api/ready said 200 while the vault's /health answered ${v.status}`);
      must(readyJson(e.home)?.pid === e.proc.pid, "/api/ready said 200 before run/ready.json was written");
    } finally {
      await e.stop();
    }
  });

  red("SIGTERM: exit 0 within 10 s, ready.json removed, both ports closed", { reason: NO_EMBEDDED, lane: "C" }, async () => {
    const e = await embeddedHome(newHome("stop"));
    const t0 = Date.now();
    const code = await e.stop("SIGTERM", 15_000);
    const ms = Date.now() - t0;
    must(code === 0 && ms <= 10_000, `SIGTERM: exit ${code} after ${ms} ms, want 0 within 10 s`);
    must(!existsSync(join(e.home, "run", "ready.json")), "run/ready.json is still there after a clean stop");
    must(closed(e.hubPort, e.vaultPort), `still listening: ${listeners().join(" ")}`);
  });

  red("it exits when the pid given by --parent-pid dies", { reason: NO_EMBEDDED, lane: "C" }, async () => {
    const parent = Bun.spawn(["sleep", "600"]);
    const e = await serveEmbedded(newHome("parent"), { args: ["--parent-pid", String(parent.pid)] });
    try {
      parent.kill("SIGKILL");
      await parent.exited;
      const code = await exitWithin(e, 15_000);
      must(code !== null, "still running 15 s after its parent died");
      must(closed(e.hubPort, e.vaultPort), `still listening after its parent died: ${listeners().join(" ")}`);
      must(!existsSync(join(e.home, "run", "ready.json")), "run/ready.json left behind after its parent died");
    } finally {
      await e.stop("SIGKILL", 2000);
    }
  });

  red("without --parent-pid, it exits when the process that started it dies", { reason: /never came up: .*unexpected argument "--embedded"/s, lane: "C" }, async () => {
    const c = candidate();
    const home = newHome("parent");
    const [h, v] = await ports(2);
    // A shell starts it and stays its parent, as launchd's or Prism's process would; then the shell is killed.
    const log = join(dirname(home), "parent.log");
    const sh = Bun.spawn(
      ["sh", "-c", `"$0" serve --embedded --listen 127.0.0.1:${h} --vault-listen 127.0.0.1:${v} >"$1" 2>&1 & wait`, c.bin, log],
      { env: candidateEnv(c, home) },
    );
    const up = await until(() => sh.exitCode !== null || (listeners().includes(`127.0.0.1:${h}`) && readyJson(home) !== undefined), 45_000) && sh.exitCode === null;
    const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    if (!up) {
      sh.kill("SIGKILL");
      must(false, `never came up: ${tail(logText())}`);
    }
    sh.kill("SIGKILL");
    const gone = await until(() => closed(h!, v!), 15_000);
    // If it outlived its parent, end it here (only the processes holding these two ports).
    for (const p of listeningProcesses()) if (p.listens.some((l) => l.endsWith(`:${h}`) || l.endsWith(`:${v}`))) process.kill(p.pid, "SIGKILL");
    must(gone, "still listening 15 s after the process that started it died");
  });

  red(
    "nothing is written outside the home: serve, bootstrap, a mint, a write and a stop leave the user HOME as it was",
    { reason: NO_EMBEDDED, lane: "C" },
    async () => {
      const home = newHome("e2");
      const before = new Set(snapshot(dirname(home)).keys());
      const e = await embeddedHome(home);
      try {
        const t = await mint(home, `vault:${e.vaultName}:write`);
        const w = await safeFetch(`${e.vault}/vault/${e.vaultName}/api/notes`, {
          method: "POST",
          headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
          body: JSON.stringify({ content: "made-up", path: "e2/one" }),
        });
        must(w.status === 201, `a write failed: HTTP ${w.status}`);
      } finally {
        await e.stop();
      }
      const extra = outsideHome(home, before);
      must(extra.length === 0, `written outside the home: ${extra.slice(0, 10).join(", ")}`);
    },
  );

  red(
    "box: the CLI writes nothing outside PARACHUTE_HOME (set-password, rotate-operator, vault create, mint)",
    { reason: /written outside the home: .*\.bun/, lane: "D" },
    async () => {
      const home = newHome("e2box");
      const before = new Set(snapshot(dirname(home)).keys());
      must((await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code === 0, "setup: set-password failed");
      must((await cli(home, ["auth", "rotate-operator"])).code === 0, "setup: rotate-operator failed");
      must((await cli(home, ["create", "e2v", "--no-mirror", "--json"], { vault: true })).code === 0, "setup: vault create failed");
      must((await cli(home, ["auth", "mint-token", "--scope", "vault:e2v:read", "--ephemeral"])).code === 0, "setup: mint-token failed");
      const extra = outsideHome(home, before);
      must(extra.length === 0, `written outside the home: ${extra.slice(0, 10).join(", ")}`);
    },
  );
});
