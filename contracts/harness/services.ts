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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import pins from "../pins.json";
import { allowOrigins, safeFetch } from "./guard.ts";

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

// Ports are drawn from 47000-49499, so these can't come up; the guard stays in case the range ever changes.
const FORBIDDEN_PORTS = new Set([1939, 1940, 1941, 1942, 1943, 1944, 1945, 1946]);
const CONTRACTS = resolve(import.meta.dir, "..");
// Preloaded into both services: they exit if this process dies, even by SIGKILL (harness/watchdog.ts).
const WATCHDOG = join(import.meta.dir, "watchdog.ts");
const SANDBOX_PREFIX = "pcore-contracts-";

/** Remove temp homes left by harness processes that are gone (e.g. SIGKILLed: no cleanup code could run).
 *  Only a provably dead owner counts (ESRCH; EPERM means someone else's live process), homes kept with --keep stay,
 *  and a home we can't remove is left alone rather than failing the run. */
export function sweepStaleSandboxes(base: string): void {
  for (const name of readdirSync(base)) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (existsSync(join(dir, "kept")) || !existsSync(join(dir, "owner.pid"))) continue;
      const owner = Number(readFileSync(join(dir, "owner.pid"), "utf8"));
      try {
        process.kill(owner, 0);
        continue; // alive
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export function reposDir(): string {
  return process.env.PARACHUTE_REPOS ?? join(CONTRACTS, ".cache", "repos");
}

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-800)}`);
  return out;
}

// Ignored files a pinned checkout may carry: installed dependencies, and the packages the hub's own `prepare`
// script builds from tracked source on install (their bytes are checked against the stamp below).
const ALLOWED_IGNORED = [/(^|\/)node_modules\//, /^packages\/[^/]+\/dist\//];

/** Files that make a checkout differ from its commit: edits, untracked files, unexpected ignored files. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  // node_modules is left out of the walk (it's huge); see the README on what that does and doesn't check.
  const out = await sh(
    ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--", ".", ":(glob,exclude)**/node_modules/**"],
    dir,
  );
  const fields = out.split("\0");
  const dirty: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i]!;
    if (!e) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // -z puts a rename's source path in its own field
    if (xy === "!!" && ALLOWED_IGNORED.some((re) => re.test(path))) continue;
    dirty.push(path);
  }
  // git status can't see edits to files flagged skip-worktree (S) or assume-unchanged (lowercase); refuse those.
  for (const line of (await sh(["git", "ls-files", "-v", "-z"], dir)).split("\0")) {
    if (line && (line[0] === "S" || /^[a-z]/.test(line))) dirty.push(line.slice(2));
  }
  return dirty;
}

/** A hash of the install-built output, so a hand-edited dist/ can't pass as pinned code. */
async function buildHash(dir: string): Promise<string> {
  const files = (await sh(["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "packages"], dir))
    .split("\0")
    .filter((f) => /^packages\/[^/]+\/dist\//.test(f))
    .sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(`${f}\0`).update(await Bun.file(join(dir, f)).bytes());
  return h.digest("hex");
}

export interface Repos {
  vault: string;
  hub: string;
  /** One line saying exactly what code this run uses; printed by harness/run.ts. */
  provenance: string;
}

/** Clone vault and hub at their pins (once), refuse checkouts that differ from the pins, install dependencies. */
export async function ensureRepos(): Promise<Repos> {
  const root = reposDir();
  mkdirSync(root, { recursive: true });
  const out: Record<string, string> = {};
  const said: string[] = [];
  for (const [key, name] of [["vault", "parachute-vault"], ["hub", "parachute-hub"]] as const) {
    const pin = (pins as any)[key] as { repo: string; commit: string };
    // VAULT_REPO_DIR / HUB_REPO_DIR: run against another checkout on purpose (harness/mutate.ts uses this). Such a
    // run is not a pinned run, and says so.
    const override = process.env[`${key.toUpperCase()}_REPO_DIR`];
    if (override) {
      out[key] = override;
      said.push(`${key} NOT PINNED (from ${override})`);
      continue;
    }
    const dir = join(root, name);
    if (!existsSync(join(dir, ".git"))) await sh(["git", "clone", "--quiet", pin.repo, dir]);
    const head = (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
    if (!head.startsWith(pin.commit)) {
      await sh(["git", "fetch", "--quiet", "origin"], dir).catch(() => {});
      await sh(["git", "checkout", "--quiet", pin.commit], dir);
    }
    const dirty = await dirtyFiles(dir);
    if (dirty.length) {
      throw new Error(
        `${dir} differs from pinned commit ${pin.commit}: ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? ", ..." : ""}. ` +
          `Delete it to re-clone, or use ${key.toUpperCase()}_REPO_DIR for a deliberate unpinned run.`,
      );
    }
    // Reinstall whenever the commit differs from the one the dependencies were installed for; then the build
    // output must match what that install produced.
    const stamp = join(dir, "node_modules", ".contracts-installed-for");
    const want = (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
    const [stampedCommit, stampedBuild] = existsSync(stamp) ? readFileSync(stamp, "utf8").trim().split(" ") : [];
    if (stampedCommit !== want || !stampedBuild) {
      // The hub's prepare script skips building a package whose dist/ exists, so clear old build output first:
      // otherwise dist/ compiled from an earlier commit would be stamped as this one.
      if (existsSync(join(dir, "packages"))) {
        for (const pkg of readdirSync(join(dir, "packages"))) rmSync(join(dir, "packages", pkg, "dist"), { recursive: true, force: true });
      }
      await sh(["bun", "install", "--frozen-lockfile"], dir);
      writeFileSync(stamp, `${want} ${await buildHash(dir)}\n`);
    } else if (stampedBuild !== (await buildHash(dir))) {
      throw new Error(`${dir}: packages/*/dist changed since install. Delete ${stamp} to rebuild.`);
    }
    out[key] = dir;
    said.push(`${key} ${pin.commit} (clean)`);
  }
  return { vault: out.vault!, hub: out.hub!, provenance: said.join(", ") };
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
      if (ok(await safeFetch(url))) return;
    } catch {}
    await Bun.sleep(200);
  }
  const log = existsSync(logPath) ? await Bun.file(logPath).text() : "(no log)";
  throw new Error(`${what} did not come up at ${url}\n--- log tail ---\n${log.slice(-2000)}`);
}

export interface Running {
  services: Services;
  provenance: string;
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

// Every running set registers its stop here, so a signal at any point (even mid-startup) can clean up.
const live = new Set<() => Promise<void>>();

/** Stop every throwaway service this process started and remove their temp homes. */
export async function stopAll(): Promise<void> {
  await Promise.all([...live].map((stop) => stop().catch(() => {})));
}

async function kill(p: ReturnType<typeof Bun.spawn> | null): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  const done = await Promise.race([p.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
  if (!done) {
    p.kill("SIGKILL");
    await p.exited;
  }
}

export async function startServices(opts: { keep?: boolean } = {}): Promise<Running> {
  const repos = await ensureRepos();
  const runId = randomBytes(4).toString("hex");
  const base = process.env.TMPDIR ?? tmpdir();
  sweepStaleSandboxes(base);
  const sandbox = mkdtempSync(join(base, `${SANDBOX_PREFIX}${runId}-`));
  writeFileSync(join(sandbox, "owner.pid"), `${process.pid}\n`);
  if (opts.keep) writeFileSync(join(sandbox, "kept"), ""); // the sweep leaves kept homes alone
  let hubProc: ReturnType<typeof Bun.spawn> | null = null;
  let vaultProc: ReturnType<typeof Bun.spawn> | null = null;
  // One shared promise: a signal handler and the normal exit path may both call stop(), and both must wait for
  // the whole cleanup. It stays in `live` until the cleanup has finished, so a signal that arrives mid-cleanup
  // still awaits it through stopAll() before process.exit (harness/selftest/cleanup.test.ts).
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await kill(vaultProc);
        await kill(hubProc);
      } finally {
        if (!opts.keep) rmSync(sandbox, { recursive: true, force: true });
        live.delete(stop);
      }
    })());
  live.add(stop);

  const home = join(sandbox, "home");
  const phome = join(home, ".parachute");
  const hubLog = join(sandbox, "hub.log");
  const vaultLog = join(sandbox, "vault.log");
    try {
    mkdirSync(join(phome, "vault"), { recursive: true });
    const hubPort = await freePort();
    const vaultPort = await freePort([hubPort]);
    const hub = `http://127.0.0.1:${hubPort}`;
    allowOrigins(hub, `http://127.0.0.1:${vaultPort}`);
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
      PCORE_HARNESS_PID: String(process.pid), // read by harness/watchdog.ts
      HOME: home,
      PARACHUTE_HOME: phome,
      TMPDIR: sandbox,
      PARACHUTE_HUB_ORIGIN: hub,
    };

    // A stop() that began mid-startup has already run; never start a service after it.
    const notStopping = () => {
      if (stopping) throw new Error("startup interrupted");
    };
    notStopping();
    hubProc = Bun.spawn(
      [
        "bun",
        "--preload",
        WATCHDOG,
        "-e",
        `const m = await import(${JSON.stringify(join(repos.hub, "src/commands/serve.ts"))}); await m.serve({ skipModuleBoot: true });`,
      ],
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
    await waitFor(`${hub}/health`, (r) => r.ok, "hub", hubLog);
    notStopping();
    vaultProc = Bun.spawn(["bun", "--preload", WATCHDOG, "src/server.ts"], {
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
    // The hub routes /vault/<name> by reading services.json. Wait until it reaches our vault: the vault's own 401
    // names this vault's resource metadata (the hub's 401 would not).
    await waitFor(
      `${hub}/vault/${vaultName}/mcp`,
      (r) => r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vaultName}/`),
      "hub → vault route",
      hubLog,
    );

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
    // The operator token the hub CLI needs before it can mint passes.
    await hubCli(services, ["auth", "rotate-operator"]);
    return {
      services,
      provenance: repos.provenance,
      stop,
      logs: async () =>
        `--- hub ---\n${await Bun.file(hubLog).text().catch(() => "")}\n--- vault ---\n${await Bun.file(vaultLog).text().catch(() => "")}`
          .replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>"),
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
