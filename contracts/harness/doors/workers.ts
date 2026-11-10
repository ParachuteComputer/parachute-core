// A cloud-style door on loopback: a parachute-cloud checkout's two workers (identity + vault) under local workerd,
// with their own D1, R2 and Durable Object state in a throwaway folder. This is how Parachute Cloud and a personal
// Cloudflare door are run for the door contracts, from the same checkout with different settings.
//
// What keeps it local:
//   - it runs inside the sandbox (harness/sandbox.ts), where only loopback exists;
//   - the config it starts from is the checkout's staging config with the Workers AI binding taken out. That binding
//     is always remote: with it, `wrangler dev` opens a session to the real Cloudflare account using whatever
//     sign-in the machine has. Embeddings and transcription are off here, as on a personal door;
//   - every origin setting is pointed at this door's own two ports;
//   - the operator token is random per start and written 0600 beside the state.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { allowOrigins, safeFetch } from "../guard.ts";
import { freePort } from "../../suites/candidate-lib.ts";

export interface WorkersDoor {
  issuer: string;
  vaultOrigin: string;
  /** The identity worker's operator bearer for /ops/* (a file path, never the value). */
  opsTokenFile: string;
  state: string;
  stop(): Promise<void>;
  logs(): string;
}

const GEN = "wrangler.door.gen.toml";

/** The checkout's wrangler.toml without its Workers AI bindings (every `[ai]` / `[env.<name>.ai]` table). */
export function withoutAi(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const table = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*(#.*)?$/.exec(line);
    if (table) skipping = /(^|\.)ai$/.test(table[1]!.trim());
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function node(): string {
  const n = process.env.PCORE_NODE_BIN ?? Bun.which("node");
  if (!n) throw new Error("door: Node is needed to run wrangler");
  return n;
}

async function waitFor(url: string, what: string, logs: () => string, ms = 180_000): Promise<void> {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await safeFetch(url);
      if (r.ok) return;
      last = `status ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await Bun.sleep(500);
  }
  throw new Error(`door: ${what} did not come up (${last}); log tail:\n${logs().slice(-3000)}`);
}

/**
 * Start both workers of `repo` (a parachute-cloud checkout with its dependencies installed and its engine pin
 * materialised beside it). `vars` are extra identity settings, e.g. a personal door's OWNER_PUBKEY.
 */
export async function startWorkersDoor(opts: {
  repo: string;
  scratch: string;
  label: string;
  identityVars?: Record<string, string>;
  vaultVars?: Record<string, string>;
}): Promise<WorkersDoor> {
  const { repo, label } = opts;
  const identityDir = join(repo, "workers", "identity");
  const vaultDir = join(repo, "workers", "vault");
  for (const d of [identityDir, vaultDir]) {
    if (!existsSync(join(d, "node_modules", "wrangler", "bin", "wrangler.js"))) throw new Error(`door: ${d} has no wrangler installed (run bun install there)`);
  }
  const state = join(opts.scratch, `door-${label}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const ip = await freePort();
  const vp = await freePort([ip]);
  const issuer = `http://127.0.0.1:${ip}`;
  const vaultOrigin = `http://127.0.0.1:${vp}`;
  allowOrigins(issuer, vaultOrigin);
  const opsTokenFile = join(state, "ops-token");
  writeFileSync(opsTokenFile, randomBytes(24).toString("base64url"), { mode: 0o600 });
  chmodSync(opsTokenFile, 0o600);

  for (const d of [identityDir, vaultDir]) writeFileSync(join(d, GEN), withoutAi(readFileSync(join(d, "wrangler.toml"), "utf8")));
  // The identity worker serves the app's files from dist-assets. A door test needs none of them: the same stub the
  // worker's own tests make. A real build is left alone.
  const assets = join(identityDir, "dist-assets");
  if (!existsSync(join(assets, "index.html"))) {
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "index.html"), '<!doctype html><html><head><meta name="parachute-spa-stub" content="door"></head><body></body></html>\n');
  }

  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", PATH: `${join(node(), "..")}:${process.env.PATH ?? ""}` } as Record<string, string>;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const wrangler = (dir: string) => [node(), join(dir, "node_modules", "wrangler", "bin", "wrangler.js")];
  const logFile = (n: string) => join(state, `${n}.log`);
  const logs = () => ["migrate", "vault", "identity"].map((n) => (existsSync(logFile(n)) ? `== ${n}\n${readFileSync(logFile(n), "utf8").replace(/\x1b\[[0-9;]*m/g, "")}` : "")).join("\n");

  const mig = Bun.spawn([...wrangler(identityDir), "d1", "migrations", "apply", "parachute-identity-staging", "--local", "--env", "staging", "-c", GEN, "--persist-to", state], {
    cwd: identityDir,
    env,
    stdout: Bun.file(logFile("migrate")),
    stderr: Bun.file(logFile("migrate")),
    stdin: "ignore",
  });
  if ((await mig.exited) !== 0) throw new Error(`door: the identity migrations failed:\n${logs().slice(-2000)}`);

  const vars = (v: Record<string, string>) => Object.entries(v).flatMap(([k, val]) => ["--var", `${k}:${val}`]);
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const dev = (dir: string, port: number, name: string, v: Record<string, string>) => {
    const p = Bun.spawn(
      [...wrangler(dir), "dev", "-c", GEN, "--env", "staging", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", state, "--show-interactive-dev-session=false", ...vars(v)],
      { cwd: dir, env, stdout: Bun.file(logFile(name)), stderr: Bun.file(logFile(name)), stdin: "ignore" },
    );
    procs.push(p);
  };
  const host = `127.0.0.1:${vp}`;
  const stop = async () => {
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM");
    await Promise.all(procs.map((p) => Promise.race([p.exited, Bun.sleep(8_000).then(() => p.kill("SIGKILL"))])));
    for (const d of [identityDir, vaultDir]) rmSync(join(d, GEN), { force: true });
    rmSync(state, { recursive: true, force: true });
  };
  try {
    dev(vaultDir, vp, "vault", { ISSUER_ORIGIN: issuer, CONSOLE_PUBLIC_ORIGIN: issuer, VAULT_BASE_DOMAIN: host, EMBEDDINGS_ENABLED: "false", ...opts.vaultVars });
    await waitFor(`${vaultOrigin}/health`, "the vault worker", logs);
    dev(identityDir, ip, "identity", {
      ISSUER: issuer,
      APP_ORIGIN: issuer,
      VAULT_ORIGIN: vaultOrigin,
      VAULT_BASE_DOMAIN: host,
      OPS_RUN_TOKEN: readFileSync(opsTokenFile, "utf8"),
      ...opts.identityVars,
    });
    await waitFor(`${issuer}/health`, "the identity worker", logs);
  } catch (err) {
    const tail = logs();
    await stop();
    throw new Error(`${(err as Error).message}\n${tail.slice(-1500)}`);
  }
  return { issuer, vaultOrigin, opsTokenFile, state, stop, logs };
}

function cookieVal(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Sign up a made-up person the way a person does: the sign-up form, then the emailed link (a dev door echoes it in a
 * header instead of sending mail). Returns the session as a cookie header, and the address and password for the
 * consent screen.
 */
export async function signUp(issuer: string): Promise<{ cookie: string; csrf: string; email: string; password: string }> {
  const email = `door-contracts+${randomBytes(5).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const page = await safeFetch(`${issuer}/signup`);
  const csrf = cookieVal(page.headers.getSetCookie(), "parachute_id_csrf");
  if (!csrf) throw new Error(`door: GET /signup gave no csrf cookie (status ${page.status})`);
  const su = await safeFetch(`${issuer}/signup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: issuer, cookie: `parachute_id_csrf=${csrf}` },
    body: new URLSearchParams({ __csrf: csrf, email, password }).toString(),
  });
  const binding = cookieVal(su.headers.getSetCookie(), "parachute_id_signup");
  const link = su.headers.get("x-parachute-dev-magic-link");
  if (su.status !== 200 || !binding || !link) throw new Error(`door: sign-up gave ${su.status} (binding ${!!binding}, link ${!!link})`);
  const v = await safeFetch(link, { headers: { cookie: `parachute_id_signup=${binding}` } });
  const session = cookieVal(v.headers.getSetCookie(), "parachute_id_session");
  if (!session) throw new Error(`door: the sign-up link gave no session (status ${v.status})`);
  return { cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`, csrf, email, password };
}
