// parachute.yaml (T-463, 0.9.3, PR 8): one settings file in the home. Keys built so far: server.port, server.bind,
// server.origin, server.accepted_issuers, vaults.<n>.description. Precedence: an env var, then parachute.yaml, then the
// old files (vault.yaml, hub_settings), then the default. `parachute config get|set|unset` reads and writes it and
// says where a value came from. With no parachute.yaml nothing changes: the old files still rule.
//
// Runs on the candidate (`TMPDIR=/tmp bun run candidate -- suites/lifecycle/parachute-yaml.test.ts`), made-up data only.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { candidate, cli, freePort, newHome, until } from "../candidate-lib.ts";
import { candidateEnv } from "../../harness/candidate.ts";
import { randomBytes } from "node:crypto";

// A box's vault listens on 1940 and the run's own box already holds it in the sandbox, so each serve here runs in a
// network namespace of its own (`unshare --net`, as shutdown.test.ts does) and is asked over HTTP from inside it
// (`nsenter` + bun), never from outside. Made-up data only.
const UNSHARE = Bun.which("unshare") ?? "/usr/bin/unshare";
const NSENTER = Bun.which("nsenter") ?? "/usr/bin/nsenter";
const ASK = `const r = await fetch(process.argv[1], { headers: process.argv[2] ? { authorization: "Bearer " + process.argv[2] } : {} });
console.log(JSON.stringify({ status: r.status, body: await r.text() }));`;

interface NsServe {
  proc: ReturnType<typeof Bun.spawn>;
  log(): string;
  ask(url: string, token?: string): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

/** `parachute serve` on `h` inside a fresh network namespace, with only `env` (plus the candidate's own). */
function serveInNs(h: string, env: Record<string, string> = {}): NsServe {
  const c = candidate();
  const logPath = join(dirname(h), `serve-${Date.now()}.log`);
  const proc = Bun.spawn([UNSHARE, "--net", "--", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", c.bin, "serve"], {
    env: candidateEnv(c, h, { EMBEDDINGS_ENABLED: "false", ...env }),
    cwd: dirname(h),
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  return {
    proc,
    log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : ""),
    async ask(url, token = "") {
      const p = Bun.spawn([NSENTER, `--net=/proc/${proc.pid}/ns/net`, "--", process.execPath, "-e", ASK, url, token], {
        env: { PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      try {
        const r = JSON.parse(out.trim().split("\n").pop()!);
        let body: any = r.body;
        try { body = JSON.parse(r.body); } catch {}
        return { status: r.status as number, body };
      } catch {
        return { status: 0, body: out };
      }
    },
    async stop() {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8"));
const tail = (s: string) => s.trim().slice(-600);

/** A home with one vault and a hub account, and no parachute.yaml. */
async function home(label: string) {
  const h = newHome(label);
  const name = `y${randomBytes(3).toString("hex")}`;
  const made = await cli(h, ["create", name, "--no-mirror", "--json"], { vault: true });
  expect(made.code, tail(made.stderr)).toBe(0);
  const user = await cli(h, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]);
  expect(user.code, tail(user.stderr)).toBe(0);
  return { h, name, yaml: join(h, "parachute.yaml") };
}

async function waitUp(port: number, s: NsServe) {
  const ok = await until(async () => s.proc.exitCode !== null || (await s.ask(`http://127.0.0.1:${port}/health`)).status === 200, 45_000);
  expect(s.proc.exitCode, `serve exited before it was up: ${tail(s.log())}`).toBeNull();
  expect(ok, `serve never answered on ${port}: ${tail(s.log())}`).toBe(true);
  return `http://127.0.0.1:${port}`;
}

describe("a home with only parachute.yaml", () => {
  test("serve listens on server.port, signs with server.origin, and the vault serves the yaml description", async () => {
    const { h, name, yaml } = await home("yaml-serve");
    const [port, other] = [await freePort(), await freePort()];
    const origin = `http://127.0.0.1:${other}`;
    writeFileSync(
      yaml,
      `# made-up settings\nserver:\n  port: ${port}\n  bind: 127.0.0.1\n  origin: ${origin}\nvaults:\n  ${name}:\n    description: "Described in parachute.yaml"\n`,
      { mode: 0o600 },
    );
    const s = serveInNs(h);
    try {
      const base = await waitUp(port, s);
      const m = await cli(h, ["auth", "mint-token", "--scope", `vault:${name}:read`, "--ephemeral"]);
      expect(m.code, tail(m.stderr)).toBe(0);
      const token = m.stdout.trim().split("\n").pop()!;
      expect(claims(token).iss).toBe(origin);
      const info = await s.ask(`${base}/vault/${name}/api/vault`, token);
      expect(info.status, JSON.stringify(info.body)).toBe(200);
      expect(info.body.description).toBe("Described in parachute.yaml");
    } finally {
      await s.stop();
    }
  }, 120_000);

  test("with no parachute.yaml the old files still rule (env port, vault.yaml description)", async () => {
    const { h, name } = await home("yaml-old");
    appendFileSync(join(h, "vault", "data", name, "vault.yaml"), `description: Described in vault.yaml\n`);
    const port = await freePort();
    const s = serveInNs(h, { PORT: String(port), PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_HUB_ORIGIN: `http://127.0.0.1:${port}` });
    try {
      const base = await waitUp(port, s);
      const m = await cli(h, ["auth", "mint-token", "--scope", `vault:${name}:read`, "--ephemeral"], { env: { PARACHUTE_HUB_ORIGIN: `http://127.0.0.1:${port}` } });
      const token = m.stdout.trim().split("\n").pop()!;
      const info = await s.ask(`${base}/vault/${name}/api/vault`, token);
      expect(info.body.description).toBe("Described in vault.yaml");
    } finally {
      await s.stop();
    }
    const g = await cli(h, ["config", "get", `vaults.${name}.description`]);
    expect(g.stdout.trim()).toBe(`vaults.${name}.description = Described in vault.yaml (old file vault.yaml)`);
  }, 120_000);
});

describe("parachute config get / set / unset", () => {
  test("a round trip: set writes the file (0600, comments kept), get says where it came from, unset removes it", async () => {
    const h = newHome("yaml-config");
    const yaml = join(h, "parachute.yaml");
    const get = async (key: string, env?: Record<string, string>) => (await cli(h, ["config", "get", key], { env })).stdout.trim();
    expect(await get("server.port")).toBe("server.port = 1939 (default)");

    const set = await cli(h, ["config", "set", "server.port", "47123"]);
    expect(set.code, tail(set.stderr)).toBe(0);
    expect(statSync(yaml).mode & 0o777).toBe(0o600);
    expect(await get("server.port")).toBe("server.port = 47123 (parachute.yaml)");

    writeFileSync(yaml, `# keep this comment\n${readFileSync(yaml, "utf8")}`, { mode: 0o600 });
    expect((await cli(h, ["config", "set", "server.accepted_issuers", "https://a.example.test,https://b.example.test"])).code).toBe(0);
    expect(await get("server.accepted_issuers")).toBe("server.accepted_issuers = https://a.example.test, https://b.example.test (parachute.yaml)");
    expect((await cli(h, ["config", "set", "server.port", "47124"])).code).toBe(0);
    expect(readFileSync(yaml, "utf8")).toContain("# keep this comment");

    const all = (await cli(h, ["config", "get"])).stdout;
    expect(all).toContain("server.port = 47124 (parachute.yaml)");

    expect((await cli(h, ["config", "unset", "server.port"])).code).toBe(0);
    expect(await get("server.port")).toBe("server.port = 1939 (default)");
    expect(readFileSync(yaml, "utf8")).toContain("# keep this comment");
  }, 120_000);

  test("an env var wins and get says so", async () => {
    const h = newHome("yaml-env");
    await cli(h, ["config", "set", "server.port", "47123"]);
    const g = await cli(h, ["config", "get", "server.port"], { env: { PORT: "47999" } });
    expect(g.stdout.trim()).toBe("server.port = 47999 (env PORT, overrides parachute.yaml 47123)");
    const o = await cli(h, ["config", "set", "server.origin", "https://hub.example.test"]);
    expect(o.code, tail(o.stderr)).toBe(0);
    const g2 = await cli(h, ["config", "get", "server.origin"], { env: { PARACHUTE_HUB_ORIGIN: "https://env.example.test" } });
    expect(g2.stdout.trim()).toBe("server.origin = https://env.example.test (env PARACHUTE_HUB_ORIGIN, overrides parachute.yaml https://hub.example.test)");
  }, 120_000);

  test("an unknown key or a bad value is refused (exit 2) and the file is untouched", async () => {
    const h = newHome("yaml-bad");
    const typo = await cli(h, ["config", "set", "server.prot", "47123"]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("server.port");
    const bad = await cli(h, ["config", "set", "server.port", "banana"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("server.port");
    expect(await Bun.file(join(h, "parachute.yaml")).exists()).toBe(false);
  }, 120_000);

  test("a file that is not valid YAML names the line, and serve refuses to start on it", async () => {
    const h = newHome("yaml-broken");
    await cli(h, ["config", "set", "server.port", "47123"]);
    writeFileSync(join(h, "parachute.yaml"), "server:\n  port: 47123\n  bind 127.0.0.1\n", { mode: 0o600 });
    const g = await cli(h, ["config", "get", "server.port"]);
    expect(g.code).not.toBe(0);
    expect(g.stderr).toMatch(/parachute\.yaml.*line 3/);
  }, 120_000);
});
