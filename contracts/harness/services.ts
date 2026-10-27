// Start and stop a throwaway hub + vault built from today's repos at the commits in pins.json.
//
// Everything runs on 127.0.0.1, on random ports, with HOME and PARACHUTE_HOME in a fresh temp dir, so nothing
// here can reach ~/.parachute, the live hub (1939) or the live vault (1940). Hazards in today's code, and how we
// avoid them (sources: hub 53d327b, vault 42fbf93):
//   - the hub's module boot rewrites the vault's services.json row to port 1940 and may kill a vault there
//     (hub src/commands/serve-boot.ts:104-143) → we start the hub with `skipModuleBoot` and the vault ourselves;
//   - the vault registers itself with the port from config.yaml, not PORT (vault src/self-register.ts) → we write
//     config.yaml first;
//   - the vault trusts http://127.0.0.1:1939 unless told otherwise (vault src/hub-jwt.ts:24-41) → we always set
//     PARACHUTE_HUB_ORIGIN and PARACHUTE_HUB_JWKS_ORIGIN to the throwaway hub.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import pins from "../pins.json";

export interface Services {
  hub: string; // http://127.0.0.1:<port>
  vaultName: string;
  vaultDirect: string; // http://127.0.0.1:<vault port>/vault/<name>, bypassing the hub
  vaultViaHub: string; // <hub>/vault/<name>
  operatorToken: string; // VAULT_AUTH_TOKEN: full access, this throwaway vault only
  admin: { username: string; password: string };
  hubRepo: string;
  home: string; // the throwaway PARACHUTE_HOME
}

const FORBIDDEN_PORTS = new Set([1939, 1940, 1941, 1942, 1943, 1944, 1945, 1946]);
const CONTRACTS = resolve(import.meta.dir, "..");

export function reposDir(): string {
  return process.env.PARACHUTE_REPOS ?? join(CONTRACTS, ".cache", "repos");
}

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-800)}`);
  return out;
}

/** Clone vault and hub at their pins (once) and install their dependencies. */
export async function ensureRepos(): Promise<{ vault: string; hub: string }> {
  const root = reposDir();
  mkdirSync(root, { recursive: true });
  const out: Record<string, string> = {};
  for (const [key, name] of [["vault", "parachute-vault"], ["hub", "parachute-hub"]] as const) {
    const pin = (pins as any)[key] as { repo: string; commit: string };
    // VAULT_REPO_DIR / HUB_REPO_DIR: run against another checkout (harness/mutate.ts uses this for mutants).
    const override = process.env[`${key.toUpperCase()}_REPO_DIR`];
    if (override) {
      out[key] = override;
      continue;
    }
    const dir = join(root, name);
    if (!existsSync(join(dir, ".git"))) await sh(["git", "clone", "--quiet", pin.repo, dir]);
    const head = (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
    if (!head.startsWith(pin.commit)) {
      await sh(["git", "fetch", "--quiet", "origin"], dir).catch(() => {});
      await sh(["git", "checkout", "--quiet", pin.commit], dir);
    }
    if (!existsSync(join(dir, "node_modules"))) await sh(["bun", "install", "--frozen-lockfile"], dir);
    out[key] = dir;
  }
  return out as { vault: string; hub: string };
}

async function portFree(port: number): Promise<boolean> {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function freePort(taken: number[] = []): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const p = 47000 + Math.floor(Math.random() * 2500);
    if (FORBIDDEN_PORTS.has(p) || taken.includes(p)) continue;
    if (await portFree(p)) return p;
  }
  throw new Error("no free port");
}

async function waitFor(url: string, ok: (r: Response) => boolean, what: string, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (ok(await fetch(url))) return;
    } catch {}
    await Bun.sleep(200);
  }
  const log = existsSync(logPath) ? await Bun.file(logPath).text() : "(no log)";
  throw new Error(`${what} did not come up at ${url}\n--- log tail ---\n${log.slice(-2000)}`);
}

export interface Running {
  services: Services;
  stop(): Promise<void>;
  logs(): Promise<string>;
}

/** Run the throwaway hub's own CLI against the throwaway home. */
export async function hubCli(s: Services, args: string[]): Promise<string> {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: s.hubRepo,
    env: { PATH: process.env.PATH ?? "", HOME: s.home.replace(/\/\.parachute$/, ""), PARACHUTE_HOME: s.home, PARACHUTE_HUB_ORIGIN: s.hub },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`hub cli ${args.slice(0, 2).join(" ")} failed (${code}): ${err.slice(-600)}`);
  return out;
}

/** Mint a hub-signed pass the way an operator does today (`parachute auth mint-token`). */
export async function mintToken(
  s: Services,
  opts: { scope: string; permissions?: object; label?: string; user?: string },
): Promise<string> {
  const args = ["auth", "mint-token", "--scope", opts.scope, "--ephemeral", "--label", opts.label ?? "contracts"];
  if (opts.user) args.push("--user", opts.user);
  if (opts.permissions) args.push("--permissions", JSON.stringify(opts.permissions));
  const tok = (await hubCli(s, args)).trim().split("\n").pop()!.trim();
  if (tok.split(".").length !== 3) throw new Error("mint-token did not print a JWT");
  const iss = JSON.parse(Buffer.from(tok.split(".")[1]!, "base64url").toString()).iss;
  if (iss !== s.hub) throw new Error(`minted pass names issuer ${iss}, expected the throwaway hub ${s.hub}`);
  return tok;
}

export async function startServices(opts: { keep?: boolean } = {}): Promise<Running> {
  const repos = await ensureRepos();
  const runId = randomBytes(4).toString("hex");
  const sandbox = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pcore-contracts-${runId}-`));
  const home = join(sandbox, "home");
  const phome = join(home, ".parachute");
  mkdirSync(join(phome, "vault"), { recursive: true });

  const hubPort = await freePort();
  const vaultPort = await freePort([hubPort]);
  const hub = `http://127.0.0.1:${hubPort}`;
  const vaultName = `contracts${runId}`;
  const operatorToken = randomBytes(24).toString("base64url");
  const admin = { username: "owner", password: `pw-${randomBytes(12).toString("hex")}` };

  // The vault's services.json row takes its port from here (and the hub proxies to it).
  writeFileSync(join(phome, "vault", "config.yaml"), `port: ${vaultPort}\n`);
  // The hub CLI signs passes with an issuer read from this file; without it, it falls back to the live hub's
  // http://127.0.0.1:1939 (hub src/hub-issuer.ts, src/hub-control.ts:33).
  mkdirSync(join(phome, "hub", "run"), { recursive: true });
  writeFileSync(join(phome, "hub", "run", "hub.port"), `${hubPort}\n`);

  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    PARACHUTE_HOME: phome,
    TMPDIR: sandbox,
    PARACHUTE_HUB_ORIGIN: hub,
  };
  const hubLog = join(sandbox, "hub.log");
  const vaultLog = join(sandbox, "vault.log");

  const hubProc = Bun.spawn(
    ["bun", "-e", `const m = await import(${JSON.stringify(join(repos.hub, "src/commands/serve.ts"))}); await m.serve({ skipModuleBoot: true });`],
    {
      cwd: repos.hub,
      env: {
        ...baseEnv,
        PORT: String(hubPort),
        PARACHUTE_BIND_HOST: "127.0.0.1",
        PARACHUTE_INITIAL_ADMIN_USERNAME: admin.username,
        PARACHUTE_INITIAL_ADMIN_PASSWORD: admin.password,
      },
      stdout: Bun.file(hubLog),
      stderr: Bun.file(hubLog),
    },
  );
  let vaultProc: ReturnType<typeof Bun.spawn> | null = null;

  const stop = async () => {
    for (const p of [vaultProc, hubProc]) {
      if (!p) continue;
      p.kill();
      await p.exited;
    }
    if (!opts.keep) rmSync(sandbox, { recursive: true, force: true });
  };

  try {
    await waitFor(`${hub}/health`, (r) => r.ok, "hub", hubLog);
    vaultProc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: repos.vault,
      env: {
        ...baseEnv,
        PORT: String(vaultPort),
        VAULT_BIND: "127.0.0.1",
        PARACHUTE_VAULT_NAME: vaultName,
        PARACHUTE_HUB_JWKS_ORIGIN: hub,
        VAULT_AUTH_TOKEN: operatorToken,
        EMBEDDINGS_ENABLED: "false",
      },
      stdout: Bun.file(vaultLog),
      stderr: Bun.file(vaultLog),
    });
    await waitFor(`http://127.0.0.1:${vaultPort}/health`, (r) => r.ok, "vault", vaultLog);
    // The hub routes /vault/<name> by reading services.json; wait until it does (401 = reached the vault).
    await waitFor(`${hub}/vault/${vaultName}/api/health`, (r) => r.status === 401 || r.ok, "hub → vault route", hubLog);
  } catch (err) {
    await stop();
    throw err;
  }

  const services: Services = {
    hub,
    vaultName,
    vaultDirect: `http://127.0.0.1:${vaultPort}/vault/${vaultName}`,
    vaultViaHub: `${hub}/vault/${vaultName}`,
    operatorToken,
    admin,
    hubRepo: repos.hub,
    home: phome,
  };
  try {
    // The operator token the hub CLI needs before it can mint passes.
    await hubCli(services, ["auth", "rotate-operator"]);
  } catch (err) {
    await stop();
    throw err;
  }
  return {
    services,
    stop,
    logs: async () =>
      `--- hub ---\n${await Bun.file(hubLog).text().catch(() => "")}\n--- vault ---\n${await Bun.file(vaultLog).text().catch(() => "")}`
        .replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>"),
  };
}
