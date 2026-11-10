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
  /**
   * Which of the checkout's configurations to run. "cloud": the staging environment of each worker's
   * wrangler.toml (Parachute Cloud's own settings, with a dev sign-up). "personal": the single-owner profile the
   * checkout ships in deploy/personal, rendered for a made-up owner key: closed sign-ups, billing off, production
   * settings.
   */
  profile?: { kind: "cloud" } | { kind: "personal"; ownerPubkey: string; plan?: string };
  identityVars?: Record<string, string>;
  vaultVars?: Record<string, string>;
}): Promise<WorkersDoor> {
  const { repo, label } = opts;
  const profile = opts.profile ?? { kind: "cloud" };
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

  // Which config, environment and D1 name the two workers run from.
  let envArgs: string[] = ["--env", "staging"];
  let d1Name = "parachute-identity-staging";
  if (profile.kind === "personal") {
    // The checkout's own single-owner profile (deploy/personal/render.sh), for a made-up owner. Its rendered files are
    // read and removed; what runs is this door's own copy, so a real rendered profile is never touched.
    const render = join(repo, "deploy", "personal", "render.sh");
    if (!existsSync(render)) throw new Error(`door: ${repo} has no deploy/personal profile`);
    const prefix = `doorrun-${randomBytes(3).toString("hex")}`;
    const profileFile = join(state, "profile.env");
    writeFileSync(profileFile, `ACCOUNT_ID=${"0".repeat(32)}\nPREFIX=${prefix}\nOWNER_PUBKEY=${profile.ownerPubkey}\nADMIN_PUBKEYS=\nOWNER_PLAN=${profile.plan ?? "power"}\n`);
    const rendered = [join(identityDir, "wrangler.personal.gen.toml"), join(vaultDir, "wrangler.personal.gen.toml")];
    if (rendered.some((f) => existsSync(f))) throw new Error("door: this checkout already holds a rendered personal profile; use a checkout of its own");
    const r = Bun.spawnSync(["bash", render, profileFile, "00000000-0000-4000-8000-000000000000", "local"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`door: rendering the personal profile failed: ${r.stderr.toString().slice(-400)}`);
    writeFileSync(join(identityDir, GEN), withoutAi(readFileSync(rendered[0]!, "utf8")));
    writeFileSync(join(vaultDir, GEN), withoutAi(readFileSync(rendered[1]!, "utf8")));
    for (const f of rendered) rmSync(f, { force: true });
    envArgs = [];
    d1Name = `${prefix}-identity`;
  } else {
    for (const d of [identityDir, vaultDir]) writeFileSync(join(d, GEN), withoutAi(readFileSync(join(d, "wrangler.toml"), "utf8")));
  }
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

  const mig = Bun.spawn([...wrangler(identityDir), "d1", "migrations", "apply", d1Name, "--local", ...envArgs, "-c", GEN, "--persist-to", state], {
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
      [...wrangler(dir), "dev", "-c", GEN, ...envArgs, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", state, "--show-interactive-dev-session=false", ...vars(v)],
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

/** A made-up owner key for one run: 32 random bytes, and its public half. */
export async function makeOwnerKey(): Promise<{ secretKey: string; pubkey: string }> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = randomBytes(32);
  return { secretKey: sk.toString("hex"), pubkey: Buffer.from(schnorr.getPublicKey(sk)).toString("hex") };
}

/** NIP-98: the `Authorization` header that proves a key for one request (kind 27235, `u`, `method`, `payload`). */
export async function nostrAuthorization(secretKey: string, url: string, method: string, body?: string, extraTags: string[][] = []): Promise<string> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const { createHash } = await import("node:crypto");
  const sk = Buffer.from(secretKey, "hex");
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  // An event's id is a hash of its fields, and a door accepts each id once. Two sign-ins by one key within the same
  // second would otherwise be the same event; a random tag keeps them apart.
  const tags = [["u", url], ["method", method], ["nonce", randomBytes(8).toString("hex")], ...extraTags];
  if (body) tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  const created_at = Math.floor(Date.now() / 1000);
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, created_at, 27235, tags, ""])).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), sk)).toString("hex");
  return `Nostr ${Buffer.from(JSON.stringify({ id, pubkey, created_at, kind: 27235, tags, content: "", sig })).toString("base64")}`;
}
