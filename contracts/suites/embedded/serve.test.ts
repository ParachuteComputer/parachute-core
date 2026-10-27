// embedded/serve (PLAN §3 "Serve"; Benjamin's E1/E6; prism scripts/parachute-compat/run.mjs:310-321,394-405):
// `parachute serve --embedded` is the one process a host starts, on ports the host chooses, loopback only.
//   - a home is required (PARACHUTE_HOME or --home): exit 2 without one;
//   - hub port: --listen, then PORT, then 1939; vault port: --vault-listen, then `port` in
//     $PARACHUTE_HOME/vault/config.yaml, then 1940. Defaults are read off the sockets (/proc), never called;
//   - a non-loopback address exits 2; a port in use exits 4;
//   - run/ready.json reports both ports and the issuer;
//   - the hub's /health is 200 only once the vault answers (his suite otherwise starts a second vault).
// Today `serve` takes no arguments (hub src/cli.ts: `unexpected argument`). Lane C turns these green.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateEnv } from "../../harness/candidate.ts";
import { candidate, cli, listeners, newHome, safeFetch, start, until } from "../candidate-lib.ts";
import { red } from "../lib.ts";
import { NO_EMBEDDED, exitWithin, exited, must, ports, readyJson, serveEmbedded, tail } from "./_lib.ts";

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

  red("serve --embedded with neither PARACHUTE_HOME nor --home exits 2 and creates no home", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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

  red("--home <dir> is the same as PARACHUTE_HOME", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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

  red("the hub port is --listen, then PORT, then 1939", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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

  red("the vault port is --vault-listen, then `port` in vault/config.yaml, then 1940", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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

  red("a non-loopback --listen or --vault-listen exits 2 and binds nothing", { reason: /--listen 0\.0\.0\.0: exit 1, want 2: .*unexpected argument "--embedded"/s, lane: "C" }, async () => {
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

  red("a hub or vault port already in use exits 4", { reason: /hub port in use: exit 1, want 4: .*unexpected argument "--embedded"/s, lane: "C" }, async () => {
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

  red("run/ready.json reports both ports, the issuer and the pid", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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

  red("the hub's /health is 200 only once the vault answers", { reason: NO_EMBEDDED, lane: "C" }, async () => {
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
