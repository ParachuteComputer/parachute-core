// embedded/serve (PLAN §3 "Serve"; Benjamin's E1/E6; prism scripts/parachute-compat/run.mjs:310-321,394-405):
// `parachute serve --embedded` is the one process a host starts, on ports the host chooses, loopback only.
//   - a home is required (PARACHUTE_HOME or --home): exit 2 without one;
//   - hub port: --listen, then PORT, then 1939; vault port: --vault-listen, then `port` in
//     $PARACHUTE_HOME/vault/config.yaml, then 1940. Defaults are read off the sockets (/proc), never called;
//   - a non-loopback address exits 2; a port in use exits 4;
//   - run/ready.json reports both ports and the issuer;
//   - the hub's /health is 200 only once the vault answers (his suite otherwise starts a second vault).
// Stock 0.7 `serve` takes no arguments (hub src/cli.ts: `unexpected argument`). Green since lane C
// (packages/cli/src/embedded.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateEnv } from "../../harness/candidate.ts";
import { candidate, cli, freePort, listeners, newHome, safeFetch, start, until } from "../candidate-lib.ts";
import { exitWithin, exited, must, ports, readyJson, serveEmbedded, tail } from "./_lib.ts";

/** Wait until something listens on `addr` (e.g. "127.0.0.1:1939") or the process exits; fail with its log if not. */
async function listensOn(s: ReturnType<typeof start>, addr: string) {
  const ok = await until(() => exited(s) || listeners().includes(addr), 45_000);
  must(!exited(s), `serve --embedded exited ${s.proc.exitCode}: ${tail(s.log())}`);
  must(ok, `nothing listens on ${addr} after 45 s; listeners: ${listeners().join(" ")}`);
}

function writeVaultConfig(home: string, port: number) {
  mkdirSync(join(home, "vault"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "vault", "config.yaml"), `port: ${port}\nautostart: false\nembeddings_enabled: false\n`, { mode: 0o600 });
}

describe("embedded/serve", () => {
  test("setup works today: the candidate's parachute runs and answers --version", async () => {
    const r = await cli(newHome("serve"), ["--version"]);
    expect(r.code).toBe(0);
  });

  test("serve --embedded with neither PARACHUTE_HOME nor --home exits 2 and creates no home", async () => {
    const c = candidate();
    const home = newHome("serve");
    const env = candidateEnv(c, home);
    delete env.PARACHUTE_HOME;
    const p = Bun.spawn([c.bin, "serve", "--embedded"], { env, cwd: dirname(home), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
    const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    must(code === 2, `exit ${code}, want 2: ${tail(err)}`);
    must(!(await Bun.file(join(dirname(home), ".parachute", "hub.db")).exists()), "it made a home in $HOME/.parachute anyway");
  });

  test("--home <dir> is the same as PARACHUTE_HOME", async () => {
    const home = newHome("serve");
    const elsewhere = newHome("other"); // PARACHUTE_HOME points here; --home must win
    const [h, v] = await ports(2);
    const s = start(elsewhere, ["serve", "--embedded", "--home", home, "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    try {
      await listensOn(s, `127.0.0.1:${h}`);
      must(await until(() => readyJson(home) !== undefined, 30_000), "no ready.json under --home");
      must(readyJson(elsewhere) === undefined, "ready.json written under PARACHUTE_HOME, not --home");
    } finally {
      await s.stop();
    }
  });

  test("a flag given twice (--home A --home=B) exits 2 and touches neither home", async () => {
    // One home, decided once: the checks before serve (newer data, modes) and serve itself must agree on it.
    const a = newHome("serve");
    const b = newHome("serve");
    const [h, v] = await ports(2);
    const s = start(newHome("other"), ["serve", "--embedded", "--home", a, `--home=${b}`, "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    const code = await exitWithin(s, 15_000);
    await s.stop("SIGKILL", 2000);
    must(code === 2, `--home given twice: exit ${code}, want 2: ${tail(s.log())}`);
    must(!existsSync(a) && !existsSync(b), `a home was created: ${[a, b].filter(existsSync).join(", ")}`);
  });

  test("the hub port is --listen, then PORT, then 1939", async () => {
    const [flag, env, v1, v2, v3] = await ports(5);
    // --listen beats PORT.
    let s = start(newHome("serve"), ["serve", "--embedded", "--listen", `127.0.0.1:${flag}`, "--vault-listen", `127.0.0.1:${v1}`], { env: { PORT: String(env) } });
    try {
      await listensOn(s, `127.0.0.1:${flag}`);
      must(!listeners().some((l) => l.endsWith(`:${env}`)), `PORT ${env} was bound although --listen said ${flag}`);
    } finally {
      await s.stop();
    }
    // PORT when there is no --listen (Prism's suite sets it, run.mjs:316-321).
    s = start(newHome("serve"), ["serve", "--embedded", "--vault-listen", `127.0.0.1:${v2}`], { env: { PORT: String(env) } });
    try {
      await listensOn(s, `127.0.0.1:${env}`);
    } finally {
      await s.stop();
    }
    // Neither: 1939 (inside the sandbox; read off the socket table, never called).
    s = start(newHome("serve"), ["serve", "--embedded", "--vault-listen", `127.0.0.1:${v3}`]);
    try {
      await listensOn(s, "127.0.0.1:1939");
    } finally {
      await s.stop();
    }
  });

  test("the vault port is --vault-listen, then `port` in vault/config.yaml, then 1940", async () => {
    const [h1, h2, h3, flag, conf] = await ports(5);
    // --vault-listen beats the config file.
    let home = newHome("serve");
    writeVaultConfig(home, conf!);
    let s = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h1}`, "--vault-listen", `127.0.0.1:${flag}`]);
    try {
      await listensOn(s, `127.0.0.1:${flag}`);
      must(!listeners().includes(`127.0.0.1:${conf}`), `config.yaml port ${conf} was bound although --vault-listen said ${flag}`);
      must(readyJson(home)?.vault_listen === `127.0.0.1:${flag}`, `ready.json vault_listen is ${readyJson(home)?.vault_listen}`);
    } finally {
      await s.stop();
    }
    // The config file when there is no flag (Prism's suite writes it, run.mjs:310-311).
    home = newHome("serve");
    writeVaultConfig(home, conf!);
    s = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h2}`]);
    try {
      await listensOn(s, `127.0.0.1:${conf}`);
    } finally {
      await s.stop();
    }
    // Neither: 1940, Prism's default PARACHUTE_URL. The suite's own box may hold 1940 in this sandbox; then the
    // default shows as "port in use" (exit 4) naming 1940.
    s = start(newHome("serve"), ["serve", "--embedded", "--listen", `127.0.0.1:${h3}`]);
    try {
      if (listeners().includes("127.0.0.1:1940")) {
        const code = await exitWithin(s, 30_000);
        must(code === 4 && /1940/.test(s.log()), `with 1940 taken and no vault port given: exit ${code}, want 4 naming 1940: ${tail(s.log())}`);
      } else {
        await listensOn(s, "127.0.0.1:1940");
      }
    } finally {
      await s.stop();
    }
  });

  test("a non-loopback --listen or --vault-listen exits 2 and binds nothing", async () => {
    const [h, v] = await ports(2);
    // 198.18.0.1 is a real non-loopback address in the sandbox (the trap interface), so a bind would succeed.
    for (const [flag, addr] of [["--listen", "0.0.0.0"], ["--listen", "198.18.0.1"], ["--vault-listen", "0.0.0.0"], ["--vault-listen", "198.18.0.1"]] as const) {
      const args = flag === "--listen"
        ? ["--listen", `${addr}:${h}`, "--vault-listen", `127.0.0.1:${v}`]
        : ["--listen", `127.0.0.1:${h}`, "--vault-listen", `${addr}:${v}`];
      const s = start(newHome("serve"), ["serve", "--embedded", ...args]);
      const code = await exitWithin(s, 15_000);
      await s.stop("SIGKILL", 2000);
      must(code === 2, `${flag} ${addr}: exit ${code}, want 2: ${tail(s.log())}`);
      must(!listeners().some((l) => l.endsWith(`:${h}`) || l.endsWith(`:${v}`)), `${flag} ${addr}: something still listens`);
    }
  });

  test("a hub or vault port already in use exits 4", async () => {
    const [h, v] = await ports(2);
    const holder = Bun.listen({ hostname: "127.0.0.1", port: h!, socket: { data() {} } });
    try {
      const s = start(newHome("serve"), ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
      const code = await exitWithin(s, 30_000);
      await s.stop("SIGKILL", 2000);
      must(code === 4, `hub port in use: exit ${code}, want 4: ${tail(s.log())}`);
    } finally {
      holder.stop(true);
    }
    const [h2, v2] = await ports(2);
    const vholder = Bun.listen({ hostname: "127.0.0.1", port: v2!, socket: { data() {} } });
    try {
      const s = start(newHome("serve"), ["serve", "--embedded", "--listen", `127.0.0.1:${h2}`, "--vault-listen", `127.0.0.1:${v2}`]);
      const code = await exitWithin(s, 30_000);
      await s.stop("SIGKILL", 2000);
      must(code === 4, `vault port in use: exit ${code}, want 4: ${tail(s.log())}`);
    } finally {
      vholder.stop(true);
    }
  });

  test("only 127.0.0.1: another loopback address (127.0.0.2, ::1) exits 2 and binds nothing", async () => {
    // The hub reaches its vault on 127.0.0.1; a vault listening elsewhere would answer its own /health while
    // every request through the hub failed (Codex review 1, finding 3).
    const [h, v] = await ports(2);
    for (const [flag, addr] of [["--vault-listen", "127.0.0.2"], ["--vault-listen", "[::1]"], ["--listen", "127.0.0.2"], ["--listen", "[::1]"]] as const) {
      const args = flag === "--listen"
        ? ["--listen", `${addr}:${h}`, "--vault-listen", `127.0.0.1:${v}`]
        : ["--listen", `127.0.0.1:${h}`, "--vault-listen", `${addr}:${v}`];
      const s = start(newHome("serve"), ["serve", "--embedded", ...args]);
      const code = await exitWithin(s, 15_000);
      await s.stop("SIGKILL", 2000);
      must(code === 2, `${flag} ${addr}: exit ${code}, want 2: ${tail(s.log())}`);
      must(!listeners().some((l) => l.endsWith(`:${h}`) || l.endsWith(`:${v}`)), `${flag} ${addr}: something still listens`);
    }
  });

  test("a PARACHUTE_HUB_ORIGIN that isn't exactly an origin (a trailing slash, a path) exits 2", async () => {
    // The issuer is PARACHUTE_HUB_ORIGIN exactly (PLAN §3); a value serve would have to rewrite is refused.
    for (const origin of [`http://127.0.0.1:${await freePort()}/`, "http://host.example.test/parachute"]) {
      const [h, v] = await ports(2);
      const s = start(newHome("serve"), ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`], { env: { PARACHUTE_HUB_ORIGIN: origin } });
      const code = await exitWithin(s, 15_000);
      await s.stop("SIGKILL", 2000);
      must(code === 2, `PARACHUTE_HUB_ORIGIN=${origin}: exit ${code}, want 2: ${tail(s.log())}`);
    }
  });

  test("an unusable home exits 5 and leaves nothing running (embedded.json is a folder)", async () => {
    const home = newHome("serve");
    mkdirSync(join(home, "embedded.json"), { recursive: true, mode: 0o700 });
    const [h, v] = await ports(2);
    const s = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    const code = await exitWithin(s, 30_000);
    await s.stop("SIGKILL", 2000);
    must(code === 5, `exit ${code}, want 5: ${tail(s.log())}`);
    must(!listeners().some((l) => l.endsWith(`:${h}`) || l.endsWith(`:${v}`)), `still listening: ${listeners().join(" ")}`);
    must(!existsSync(join(home, "run", "serve.lock")), "run/serve.lock left behind");
  });

  test("two serves started at once on one home: one runs, the other exits 2 with managed_by_host", async () => {
    const home = newHome("serve");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const [h1, v1, h2, v2] = await ports(4);
    const a = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h1}`, "--vault-listen", `127.0.0.1:${v1}`]);
    const b = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h2}`, "--vault-listen", `127.0.0.1:${v2}`]);
    try {
      const both = [a, b];
      const settled = await until(() => both.some(exited) && both.some((s) => !exited(s)) && readyJson(home) !== undefined, 45_000);
      must(!both.every(exited), `both exited: ${a.proc.exitCode} / ${b.proc.exitCode}: ${tail(a.log())} | ${tail(b.log())}`);
      must(settled, `after 45 s: ${both.filter(exited).length} of 2 exited (want exactly one), ready.json ${readyJson(home) ? "present" : "absent"}`);
      const loser = both.find(exited)!;
      const winner = both.find((s) => !exited(s))!;
      must(loser.proc.exitCode === 2 && /managed_by_host/.test(loser.log()), `the second serve: exit ${loser.proc.exitCode}, want 2 with managed_by_host: ${tail(loser.log())}`);
      must(readyJson(home)?.pid === winner.proc.pid, `ready.json names pid ${readyJson(home)?.pid}, want the running serve ${winner.proc.pid}`);
      // The running serve still holds the home: its lock survived the other's exit.
      const second = start(home, ["serve"], { vault: true, env: { PORT: String(await freePort([h1!, v1!, h2!, v2!])) } });
      const code = await exitWithin(second, 20_000);
      await second.stop("SIGKILL", 2000);
      must(code === 2, `after the race, parachute-vault serve: exit ${code}, want 2 (the home must still be held): ${tail(second.log())}`);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("a home whose run/ready.json is a folder exits 5, leaves nothing running, and releases the home", async () => {
    const home = newHome("serve");
    mkdirSync(join(home, "run", "ready.json"), { recursive: true, mode: 0o700 });
    for (const round of [1, 2]) {
      const [h, v] = await ports(2);
      const s = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
      const code = await exitWithin(s, 30_000);
      await s.stop("SIGKILL", 2000);
      must(code === 5, `start ${round}: exit ${code}, want 5: ${tail(s.log())}`);
      // The second start finds the home free: the first released its hold although a cleanup step failed.
      must(!/managed_by_host/.test(s.log()), `start ${round} was refused as managed_by_host: the hold wasn't released`);
      must(!listeners().some((l) => l.endsWith(`:${h}`) || l.endsWith(`:${v}`)), `start ${round}: still listening: ${listeners().join(" ")}`);
    }
  });

  test("after a SIGKILLed serve, three serves started at once on its home: one runs, the others exit 2", async () => {
    const home = newHome("serve");
    const first = await serveEmbedded(home);
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    must(await until(() => !listeners().some((l) => l.endsWith(`:${first.hubPort}`) || l.endsWith(`:${first.vaultPort}`)), 15_000), "setup: the killed serve's ports never closed");
    const ps = await ports(6);
    const all = [0, 1, 2].map((i) => start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${ps[2 * i]}`, "--vault-listen", `127.0.0.1:${ps[2 * i + 1]}`]));
    try {
      const settled = await until(() => all.filter(exited).length === 2 && readyJson(home)?.pid !== first.proc.pid && readyJson(home) !== undefined, 45_000);
      const running = all.filter((s) => !exited(s));
      must(settled && running.length === 1, `after 45 s: ${running.length} of 3 running (want exactly one): ${all.map((s) => `${s.proc.exitCode}: ${tail(s.log(), 300)}`).join(" | ")}`);
      for (const s of all.filter(exited)) {
        must(s.proc.exitCode === 2 && /managed_by_host/.test(s.log()), `a losing serve: exit ${s.proc.exitCode}, want 2 with managed_by_host: ${tail(s.log())}`);
      }
      must(readyJson(home)?.pid === running[0]!.proc.pid, `ready.json names pid ${readyJson(home)?.pid}, want the running serve ${running[0]!.proc.pid}`);
    } finally {
      for (const s of all) await s.stop();
    }
  });

  test("a corrupt embedded.json exits 5 and is left as it was (its earlier issuers are never dropped)", async () => {
    const home = newHome("serve");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const corrupt = '{"issuer": "http://127.0.0.1:47001", "accepted_issuers": ["http://127.0.0.1:47001"'; // cut short
    writeFileSync(join(home, "embedded.json"), corrupt, { mode: 0o600 });
    const [h, v] = await ports(2);
    const s = start(home, ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    const code = await exitWithin(s, 30_000);
    await s.stop("SIGKILL", 2000);
    must(code === 5, `exit ${code}, want 5: ${tail(s.log())}`);
    must(readFileSync(join(home, "embedded.json"), "utf8") === corrupt, "embedded.json was rewritten");
  });

  test("run/ready.json reports both ports, the issuer and the pid", async () => {
    const e = await serveEmbedded(newHome("serve"));
    try {
      const r = readyJson(e.home);
      must(r, "no run/ready.json once /api/ready is 200");
      must(r.listen === `127.0.0.1:${e.hubPort}`, `ready.json listen is ${r.listen}, want 127.0.0.1:${e.hubPort}`);
      must(r.vault_listen === `127.0.0.1:${e.vaultPort}`, `ready.json vault_listen is ${r.vault_listen}, want 127.0.0.1:${e.vaultPort}`);
      must(r.issuer === `http://127.0.0.1:${e.hubPort}`, `ready.json issuer is ${r.issuer}`);
      must(r.pid === e.proc.pid, `ready.json pid is ${r.pid}, want ${e.proc.pid}`);
      // Everything listening belongs to this serve and is loopback (E6).
      const mine = listeners().filter((l) => l.endsWith(`:${e.hubPort}`) || l.endsWith(`:${e.vaultPort}`));
      must(mine.sort().join(" ") === [`127.0.0.1:${e.hubPort}`, `127.0.0.1:${e.vaultPort}`].sort().join(" "), `listeners: ${mine.join(" ")}`);
    } finally {
      await e.stop();
    }
  });

  test("the hub's /health is 200 only once the vault answers", async () => {
    const e = await serveEmbedded(newHome("serve"), { ready: false });
    try {
      let hubUp = false;
      const deadline = Date.now() + 45_000;
      while (!hubUp && Date.now() < deadline && !exited(e)) {
        try {
          hubUp = (await safeFetch(`${e.hub}/health`)).status === 200;
        } catch {}
        if (!hubUp) await Bun.sleep(25);
      }
      must(!exited(e), `serve --embedded exited ${e.proc.exitCode}: ${tail(e.log())}`);
      must(hubUp, "the hub's /health never answered 200");
      // The first moment the hub says healthy, the vault already answers.
      const v = await safeFetch(`${e.vault}/health`).catch(() => ({ status: 0 }));
      must(v.status === 200, `the hub said healthy while the vault's /health answered ${v.status}`);
    } finally {
      await e.stop();
    }
  });
});
