// embedded/ready-stop (PLAN §3 "Ready and stop", "Nothing outside the home", §2.2 item 1; Benjamin's E1/E2):
//   - /api/ready is 200 only once both databases are migrated and the vault answers, and run/ready.json exists then;
//   - SIGTERM: exit 0 within 10 s, ready.json removed, both ports closed;
//   - it exits when its parent dies: the pid given by --parent-pid, or the process that started it;
//   - nothing is written outside the home: the throwaway user HOME has no new entry afterwards, Bun's transpiler
//     cache included (today's stock run writes .bun/install/cache into $HOME, one of the 3 FAILs in Benjamin's suite).
// Today there is no embedded mode, and /api/ready is true before any module has started (hub src/api-ready.ts).
// Green since lane C (packages/cli/src/embedded.ts); the E2 cases (nothing outside the home) from lane D's bundle on.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { candidateEnv } from "../../harness/candidate.ts";
import { candidate, cli, listeners, listeningProcesses, newHome, safeFetch, until } from "../candidate-lib.ts";
import { red, services } from "../lib.ts";
import { embeddedHome, exitWithin, exited, mintJwt, must, ports, readyJson, serveEmbedded, snapshot, tail } from "./_lib.ts";

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

  test("/api/ready is 200 only once the vault answers, and ready.json exists by then", async () => {
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

  test("SIGTERM: exit 0 within 10 s, ready.json removed, both ports closed", async () => {
    const e = await embeddedHome(newHome("stop"));
    const t0 = Date.now();
    const code = await e.stop("SIGTERM", 15_000);
    const ms = Date.now() - t0;
    must(code === 0 && ms <= 10_000, `SIGTERM: exit ${code} after ${ms} ms, want 0 within 10 s`);
    must(!existsSync(join(e.home, "run", "ready.json")), "run/ready.json is still there after a clean stop");
    must(closed(e.hubPort, e.vaultPort), `still listening: ${listeners().join(" ")}`);
  });

  test("SIGKILL: its vault does not outlive it (the vault port closes within 10 s)", async () => {
    const e = await serveEmbedded(newHome("kill"));
    e.proc.kill("SIGKILL");
    await e.proc.exited;
    const gone = await until(() => closed(e.vaultPort), 10_000, 100);
    // If the vault outlived it, end it here (only the process holding this home's vault port).
    for (const p of listeningProcesses()) if (p.listens.some((l) => l.endsWith(`:${e.vaultPort}`))) process.kill(p.pid, "SIGKILL");
    must(gone, `the vault still listens on ${e.vaultPort} 10 s after serve --embedded was SIGKILLed`);
  });

  test("SIGTERM during start-up: exit 0 within 10 s, never ready afterwards, ready.json absent, both ports closed", async () => {
    const e = await serveEmbedded(newHome("early"), { ready: false });
    // As soon as the hub listens (its vault is still starting), stop it.
    must(await until(() => exited(e) || listeners().includes(`127.0.0.1:${e.hubPort}`), 45_000, 10), "the hub never listened");
    must(!exited(e), `serve --embedded exited ${e.proc.exitCode} before the test could stop it: ${tail(e.log())}`);
    const t0 = Date.now();
    const code = await e.stop("SIGTERM", 15_000);
    const ms = Date.now() - t0;
    must(code === 0 && ms <= 10_000, `SIGTERM during start-up: exit ${code} after ${ms} ms, want 0 within 10 s: ${tail(e.log())}`);
    must(!existsSync(join(e.home, "run", "ready.json")), "run/ready.json exists after a stop during start-up");
    must(closed(e.hubPort, e.vaultPort), `still listening: ${listeners().join(" ")}`);
  });

  test("--parent-pid naming a process already gone: it exits without binding a port", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const e = await serveEmbedded(newHome("parent"), { ready: false, args: ["--parent-pid", String(gone.pid)] });
    let bound = false;
    const done = await until(() => {
      if (listeners().some((l) => l.endsWith(`:${e.hubPort}`) || l.endsWith(`:${e.vaultPort}`))) bound = true;
      return exited(e);
    }, 20_000, 20);
    await e.stop("SIGKILL", 2000);
    must(done, "still running 20 s after starting with a dead --parent-pid");
    must(!bound, "it bound a port although its parent was already gone");
  });

  test("its vault dies after ready: serve stops with exit 75, ready.json removed, the hub's port closed", async () => {
    const e = await serveEmbedded(newHome("vaultdies"));
    const vault = listeningProcesses().find((p) => p.listens.includes(`127.0.0.1:${e.vaultPort}`));
    must(vault, `setup: no process listens on the vault port ${e.vaultPort}`);
    process.kill(vault.pid, "SIGKILL");
    const code = await exitWithin(e, 20_000);
    await e.stop("SIGKILL", 2000);
    must(code === 75, `after its vault died: exit ${code}, want 75: ${tail(e.log())}`);
    must(!existsSync(join(e.home, "run", "ready.json")), "run/ready.json still there after its vault died");
    must(closed(e.hubPort), `the hub still listens on ${e.hubPort}`);
  });

  test("it exits when the pid given by --parent-pid dies", async () => {
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

  test("without --parent-pid, it exits when the process that started it dies", async () => {
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

  // Lane C made serve itself write nothing outside the home; lane D's bundle keeps Bun's cache out of it too.
  test(
    "nothing is written outside the home: serve, bootstrap, a mint, a write and a stop leave the user HOME as it was",
    async () => {
      const home = newHome("e2");
      const before = new Set(snapshot(dirname(home)).keys());
      const e = await embeddedHome(home);
      try {
        const t = await mintJwt(home, `vault:${e.vaultName}:write`);
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
      const others = extra.filter((p) => p !== ".bun" && !p.startsWith(".bun/"));
      must(others.length === 0, `written outside the home: ${others.slice(0, 10).join(", ")}`);
      must(extra.length === 0, `written outside the home: only Bun's cache (${extra.slice(0, 3).join(", ")}, ${extra.length} entries)`);
    },
  );

  // Lane D: the bundle's wrappers turn Bun's transpiler cache off (it went to ~/.bun/install/cache).
  test(
    "box: the CLI writes nothing outside PARACHUTE_HOME (set-password, rotate-operator, vault create, mint)",
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
