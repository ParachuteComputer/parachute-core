// What the embedded/ contracts share: start `serve --embedded` on ports we choose, read its files, hash a home,
// check modes, and run a stock box in a network of its own. Black box only: the candidate's bin/parachute and
// bin/parachute-vault, HTTP, and the files a host is allowed to read (ready.json, embedded.json, the token file).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowOrigins, candidate, cli, oldStockDir, freePort, safeFetch, start, until, type Served } from "../candidate-lib.ts";
import { must } from "../lib.ts";

export { must };

/** The claims of a JWT, without verifying it (the vault does that). */
export function claims(token: string): any {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** A JSON object from a CLI's stdout: the whole of it, or the last line that parses (as Prism's suite reads it). */
export function json(stdout: string): any {
  const s = stdout.trim();
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object") return v;
  } catch {}
  for (const line of s.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return undefined;
}

export const tail = (s: string, n = 600) => s.trim().slice(-n);

/** Distinct free loopback ports (never 1939-1946). */
export async function ports(n: number): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) out.push(await freePort(out));
  return out;
}

export interface Embedded extends Served {
  home: string;
  hub: string; // http://127.0.0.1:<hub port>
  vault: string; // http://127.0.0.1:<vault port>
  hubPort: number;
  vaultPort: number;
}

/**
 * Start `parachute serve --embedded --listen 127.0.0.1:<h> --vault-listen 127.0.0.1:<v>` on `home` and wait until
 * `/api/ready` says 200. If it exits first, fail with its exit code and log, so a red contract can name the cause.
 */
export async function serveEmbedded(
  home: string,
  opts: { hubPort?: number; vaultPort?: number; args?: string[]; env?: Record<string, string>; ready?: boolean; flags?: boolean } = {},
): Promise<Embedded> {
  const [h, v] = await ports(2);
  const hubPort = opts.hubPort ?? h!;
  const vaultPort = opts.vaultPort ?? v!;
  const flags = opts.flags === false ? [] : ["--listen", `127.0.0.1:${hubPort}`, "--vault-listen", `127.0.0.1:${vaultPort}`];
  const hub = `http://127.0.0.1:${hubPort}`;
  const vault = `http://127.0.0.1:${vaultPort}`;
  allowOrigins(hub, vault);
  const served = start(home, ["serve", "--embedded", ...flags, ...(opts.args ?? [])], { env: opts.env });
  const e: Embedded = { ...served, home, hub, vault, hubPort, vaultPort };
  if (opts.ready === false) return e;
  const ok = await until(async () => {
    if (exited(served)) return true;
    return (await safeFetch(`${hub}/api/ready`)).status === 200;
  }, 45_000);
  must(!exited(served), `serve --embedded exited ${served.proc.exitCode} before it was ready: ${tail(served.log())}`);
  if (!ok) {
    await served.stop("SIGKILL", 2000);
    must(false, `serve --embedded never reported /api/ready 200 in 45 s: ${tail(served.log())}`);
  }
  return e;
}

export function exited(s: Served): boolean {
  return s.proc.exitCode !== null || s.proc.signalCode !== null;
}

/** Wait up to `ms` for a process to exit; its exit code, or null if it is still running. */
export async function exitWithin(s: Served, ms: number): Promise<number | null> {
  await Promise.race([s.proc.exited, Bun.sleep(ms)]);
  return exited(s) ? s.proc.exitCode : null;
}

/** `parachute bootstrap --embedded … --json`; returns the exit code and the parsed JSON. */
export async function bootstrap(home: string, args: string[] = [], env?: Record<string, string>) {
  const r = await cli(home, ["bootstrap", "--embedded", ...args, "--json"], { env });
  return { ...r, json: json(r.stdout) };
}

/** `$PARACHUTE_HOME/run/ready.json`, or undefined. */
export function readyJson(home: string): any {
  const p = join(home, "run", "ready.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

/** `$PARACHUTE_HOME/embedded.json`, or undefined. */
export function embeddedJson(home: string): any {
  const p = join(home, "embedded.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

// ── homes as data ────────────────────────────────────────────────────────────────────────────────────────

export interface Entry {
  rel: string;
  kind: "dir" | "file" | "link" | "other";
  mode: number;
  sha256?: string;
}

/** Every path under `root` with its kind, mode and (for files) a hash of its bytes. Symlinks are not followed. */
export function snapshot(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!existsSync(root)) return out;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      const mode = st.mode & 0o777;
      if (st.isSymbolicLink()) out.set(r, { rel: r, kind: "link", mode });
      else if (st.isDirectory()) {
        out.set(r, { rel: r, kind: "dir", mode });
        walk(r);
      } else if (st.isFile()) {
        out.set(r, { rel: r, kind: "file", mode, sha256: createHash("sha256").update(readFileSync(join(root, r))).digest("hex") });
      } else out.set(r, { rel: r, kind: "other", mode });
    }
  };
  walk("");
  return out;
}

/** What differs between two snapshots, as plain lines (empty when byte-identical). */
export function diff(before: Map<string, Entry>, after: Map<string, Entry>): string[] {
  const lines: string[] = [];
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) lines.push(`+ ${k}`);
    else if (b.kind !== a.kind || b.mode !== a.mode || b.sha256 !== a.sha256) lines.push(`~ ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) lines.push(`- ${k}`);
  return lines;
}

const octal = (m: number) => "0" + m.toString(8).padStart(3, "0");

/** Every folder under the home that isn't 0700 and every file that isn't 0600 (the home itself included). */
export function modeProblems(home: string): string[] {
  const out: string[] = [];
  const top = lstatSync(home).mode & 0o777;
  if (top !== 0o700) out.push(`./ ${octal(top)}`);
  for (const e of snapshot(home).values()) {
    if (e.kind === "dir" && e.mode !== 0o700) out.push(`${e.rel}/ ${octal(e.mode)}`);
    if (e.kind === "file" && e.mode !== 0o600) out.push(`${e.rel} ${octal(e.mode)}`);
  }
  return out;
}

// ── a stock box in a network of its own ─────────────────────────────────────────────────────────────────

/**
 * Run `<this folder>/<script>` in a fresh network namespace nested in the sandbox, and return what it printed as
 * its result. Used where a stock box must run its vault child on the fixed port 1940, which the suite's own box
 * already holds in the sandbox (hub src/commands/serve-boot.ts, reconcilePortToCanonical). The script ends with
 * `report()` (below); a thrown error comes back as an Error with the same message, so a red contract can match it.
 */
export async function inOwnNetwork(script: string, input: unknown = {}, timeoutMs = 240_000): Promise<any> {
  const path = resolve(import.meta.dir, script);
  const p = Bun.spawn(["unshare", "--user", "--map-root-user", "--net", "--fork", "--kill-child", "--", process.execPath, path], {
    env: { ...process.env, EMBEDDED_INPUT: JSON.stringify(input) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  const line = out.split("\n").find((l) => l.startsWith("@@RESULT ")) ?? out.split("\n").find((l) => l.startsWith("@@ERROR "));
  if (!line) throw new Error(`${script}: no result (exit ${code}): ${tail(out + err, 1500)}`);
  if (line.startsWith("@@ERROR ")) throw new Error(JSON.parse(line.slice(8)));
  return JSON.parse(line.slice(9));
}

/**
 * An interface that comes up sends the kernel's own IPv6 discovery (router solicitations, the duplicate-address check)
 * at its own times; CI saw one such packet land inside a test. Both are switched off on the trap before it comes up,
 * and the trap waits until its counter has been still for 2 s (at most 15 s) before the script runs. Nothing is
 * exempt from the count: a program that makes the kernel send anything off the machine (an IPv6 multicast join's
 * MLD report included) is counted, which offline.test.ts proves.
 */
const TRAP_SYSCTLS = ["router_solicitations", "dad_transmits"];

async function settleTrap(): Promise<void> {
  const count = () => Number(/counter packets (\d+)/.exec(Bun.spawnSync(["nft", "list", "table", "inet", "pctrap"]).stdout.toString())?.[1]);
  let last = count();
  let still = 0;
  for (let waited = 0; waited < 15_000 && still < 2_000; waited += 250) {
    await Bun.sleep(250);
    const now = count();
    still = now === last ? still + 250 : 0;
    last = now;
  }
}

/** The body of an `inOwnNetwork` script: bring loopback up, run `fn`, print its result (or its error). */
export async function report(fn: (input: any) => Promise<unknown>, opts: { trap?: boolean } = {}): Promise<void> {
  // The same trap as harness/sandbox.ts, so candidate-lib outboundPackets() reads this network's own counter and
  // nothing the suite's box does elsewhere in the sandbox can move it.
  const steps = [["ip", "link", "set", "lo", "up"]];
  if (opts.trap) {
    steps.push(
      ["ip", "link", "add", "pctrap0", "type", "dummy"],
      ...TRAP_SYSCTLS.map((k) => ["sh", "-c", `echo 0 > /proc/sys/net/ipv6/conf/pctrap0/${k}`]),
      ["ip", "addr", "add", "198.18.0.1/15", "dev", "pctrap0"],
      ["ip", "link", "set", "pctrap0", "up"],
      ["ip", "route", "add", "default", "dev", "pctrap0"],
      ["ip", "-6", "route", "add", "default", "dev", "pctrap0"],
      ["nft", "add", "table", "inet", "pctrap"],
      ["nft", "add", "chain", "inet", "pctrap", "out", "{ type filter hook output priority 0; }"],
      ["nft", "add", "rule", "inet", "pctrap", "out", "oifname", "!=", "lo", "counter"],
    );
  }
  for (const cmd of steps) {
    const r = Bun.spawnSync(cmd, { stderr: "pipe" });
    if (r.exitCode !== 0) {
      console.log(`@@ERROR ${JSON.stringify(`setup: ${cmd.join(" ")} failed: ${r.stderr.toString()}`)}`);
      process.exit(1);
    }
  }
  if (opts.trap) await settleTrap();
  try {
    const result = await fn(JSON.parse(process.env.EMBEDDED_INPUT ?? "{}"));
    console.log(`@@RESULT ${JSON.stringify(result ?? null)}`);
    process.exit(0);
  } catch (e) {
    console.log(`@@ERROR ${JSON.stringify(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  }
}

/** The stock 0.7 build, for the rollback leg: today's hub 0.7.19 and vault 0.7.9 (candidate-lib oldStockDir()). */
export function stockDir(): string {
  return oldStockDir();
}

export { candidate };

// ── an embedded home with a vault and an operator ────────────────────────────────────────────────────────

/** `serve --embedded`, then `bootstrap --embedded --vault <vault> --json` (Prism's installer: no password). */
export async function embeddedHome(
  home: string,
  opts: { vault?: string; hubPort?: number; vaultPort?: number; env?: Record<string, string>; args?: string[] } = {},
) {
  const e = await serveEmbedded(home, opts);
  const vault = opts.vault ?? "default";
  const b = await bootstrap(home, ["--vault", vault], opts.env);
  if (b.code !== 0 || !b.json) {
    await e.stop();
    must(false, `bootstrap --embedded exited ${b.code}: ${tail(b.stderr || b.stdout)}`);
  }
  return { ...e, vaultName: vault, boot: b.json };
}

/** `auth mint-token --scope <scope> --json` → the parsed `{token, jti, exp, scopes, aud}`. */
export async function mint(home: string, scope: string, extra: string[] = [], env?: Record<string, string>) {
  const r = await cli(home, ["auth", "mint-token", "--scope", scope, ...extra, "--json"], { env });
  const j = json(r.stdout);
  must(r.code === 0 && typeof j?.token === "string", `auth mint-token --json exited ${r.code}: ${tail(r.stderr || r.stdout)}`);
  return j as { token: string; jti: string; exp: unknown; scopes: unknown; aud: unknown };
}

/**
 * `auth mint-token --scope <scope>` without --json: the JWT on the last line of stdout, the way Benjamin's suite
 * reads it when --json isn't advertised (run.mjs parseMint). For lane C's contracts, so they don't wait on lane B's
 * `--json` (embedded/json holds that).
 */
export async function mintJwt(home: string, scope: string, extra: string[] = [], env?: Record<string, string>) {
  const r = await cli(home, ["auth", "mint-token", "--scope", scope, ...extra], { env });
  const token = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  must(r.code === 0 && token.split(".").length === 3, `auth mint-token exited ${r.code}: ${tail(r.stderr || r.stdout)}`);
  return { token };
}

/** GET a vault's notes with a token, straight at the vault listener. */
export async function readNotes(vaultOrigin: string, vaultName: string, token: string) {
  const r = await safeFetch(`${vaultOrigin}/vault/${vaultName}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, text: (await r.text()).slice(0, 300) };
}

/**
 * Sign in at the hub's /login form with a username and password, as a person does in the browser (the same posts as
 * suites/oauth.ts). True when the hub answers with a session cookie.
 */
export async function signIn(hub: string, username: string, password: string): Promise<boolean> {
  const cookie = (r: Response, name: string) => {
    for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
  };
  const page = await safeFetch(`${hub}/login`, { redirect: "manual" });
  const csrf = cookie(page, "parachute_hub_csrf");
  const field = (await page.text()).match(/name="__csrf"\s+value="([^"]+)"/)?.[1];
  const login = await safeFetch(`${hub}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf}` },
    body: new URLSearchParams({ __csrf: field ?? csrf ?? "", username, password }),
  });
  return cookie(login, "parachute_hub_session") !== undefined;
}
