// The candidate adapter (CONTRACT_TARGET=candidate): run the contracts against a built `parachute`, launched the
// way a user launches it, and prove which bytes were tested.
//
// A candidate is a folder with bin/parachute, bin/parachute-vault and CANDIDATE.json (harness/build-stock-candidate.ts
// builds today's code that way; lane A1's build will write the same shape). The adapter:
//   - refuses a candidate whose files don't hash to the sha256 in CANDIDATE.json, or to CANDIDATE_SHA256 when CI
//     passes the hash its build step produced;
//   - runs only bin/parachute and bin/parachute-vault, with a PATH that holds the candidate, Bun and the system,
//     never ~/.bun/bin or a global install;
//   - starts it inside the sandbox (harness/sandbox.ts), with its own HOME and PARACHUTE_HOME;
//   - checks that every listening socket belongs to a process started from the candidate folder, and reports the
//     process model it saw (one process, or a hub with a vault child);
//   - writes nothing a release would own, except the workarounds a profile names (printed on every run).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { allowOrigins, safeFetch } from "./guard.ts";
import type { Running, Services } from "./services.ts";

export const MANIFEST = "CANDIDATE.json";

export interface CandidateManifest {
  name: string;
  /** "stock-0.7": today's hub + vault; "v0.8": the one program. Decides the launch and its allowed workarounds. */
  profile: "stock-0.7" | "v0.8";
  version: Record<string, string> | string;
  source: Record<string, string> | string;
  core_commit: string;
  /** What the build says it is: "child" (hub + vault child) or "in-process". The run checks what it sees. */
  process_model: "child" | "in-process";
  platform: string;
  sha256: string;
}

/** What a suite needs to start the candidate itself (embedded/, lifecycle/): written to CONTRACT_CANDIDATE. */
export interface CandidateInfo {
  dir: string;
  /** What suites run: a launcher in the scratch folder that records its pid in `launchLog`, then execs
   *  <dir>/bin/parachute (or parachute-vault). The pid stays the same, so the watcher knows what was launched as the
   *  candidate even if it execs into something else (watchAttribution). */
  bin: string;
  vaultBin: string;
  launchLog: string;
  runtimeDir: string; // a folder holding only `bun`, for PATH
  scratch: string; // where suites make throwaway homes
  /** Today's stock 0.7 build, for "the old programs" (takeover, identity, rollback to stock): the candidate itself
   *  while it is stock, else OLD_STOCK_DIR or .cache/candidate-stock. */
  oldStockDir: string;
  profile: CandidateManifest["profile"];
  processModel: CandidateManifest["process_model"];
  sha256: string;
}

/**
 * sha256 over every path in the folder (sorted), its kind, and its bytes or link target. CANDIDATE.json is left out.
 * A symlink that resolves outside the folder is refused: what it points at would run without being hashed.
 */
export async function treeHash(root: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const realRoot = realpathSync(root);
  const walk = async (rel: string) => {
    const abs = join(root, rel);
    const names = readdirSync(abs).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === MANIFEST) continue;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) {
        const target = readlinkSync(join(root, r));
        const lexical = resolve(dirname(join(realRoot, r)), target);
        let real = lexical;
        try {
          real = realpathSync(join(root, r));
        } catch {} // a dangling link is hashed by its target string; it can't run anything
        for (const t of [lexical, real]) {
          if (t !== realRoot && !t.startsWith(realRoot + "/")) throw new Error(`candidate ${root}: ${r} links outside the candidate (${target})`);
        }
        h.update(`L\0${r}\0${target}\0`);
      }
      else if (st.isDirectory()) {
        h.update(`D\0${r}\0`);
        await walk(r);
      } else if (st.isFile()) {
        h.update(`F\0${r}\0${(st.mode & 0o111) ? "x" : "-"}\0`);
        h.update(await Bun.file(join(root, r)).bytes());
        h.update("\0");
      }
    }
  };
  await walk("");
  return h.digest("hex");
}

/**
 * Load a candidate and check its bytes against its manifest, and against `want` (default CANDIDATE_SHA256, the hash
 * CI's build step produced for the candidate under test). The old stock programs are a different build: they pass
 * `oldStockWant()`.
 */
export async function loadCandidate(dir: string, want: string | undefined = process.env.CANDIDATE_SHA256): Promise<{ manifest: CandidateManifest; sha256: string }> {
  const d = resolve(dir);
  if (!existsSync(join(d, MANIFEST))) throw new Error(`${d} is not a candidate (no ${MANIFEST}); build one with \`bun run build:stock\``);
  for (const b of ["bin/parachute", "bin/parachute-vault"]) {
    if (!existsSync(join(d, b))) throw new Error(`candidate ${d} has no ${b}`);
  }
  const manifest = JSON.parse(readFileSync(join(d, MANIFEST), "utf8")) as CandidateManifest;
  const sha256 = await treeHash(d);
  if (sha256 !== manifest.sha256) throw new Error(`candidate ${d}: files hash to ${sha256}, but ${MANIFEST} says ${manifest.sha256}`);
  if (want && want !== sha256) throw new Error(`candidate ${d}: files hash to ${sha256}, but this CI build produced ${want}`);
  return { manifest, sha256 };
}

/** What the old stock build must hash to: OLD_STOCK_SHA256 (CI passes its build:stock step's hash), else its manifest. */
export function oldStockWant(): string | undefined {
  return process.env.OLD_STOCK_SHA256;
}

/** The environment every candidate process gets: nothing from the caller's shell but locale. */
export function candidateEnv(info: CandidateInfo, home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${info.dir}/bin:${info.runtimeDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: dirname(home),
    PARACHUTE_HOME: home,
    TMPDIR: join(dirname(home), "tmp"),
    LANG: "C.UTF-8",
    ...extra,
  };
}

/** A fresh throwaway user home (`<scratch>/<id>/u`) with `.parachute` not yet created. Returns PARACHUTE_HOME. */
export function freshHome(info: CandidateInfo, label = "home"): string {
  const user = mkdtempSync(join(info.scratch, `${label}-`));
  mkdirSync(join(user, "tmp"), { recursive: true });
  return join(user, ".parachute");
}

// ── which processes are listening, and from where ───────────────────────────────────────────────────────────

interface Proc {
  pid: number;
  cmdline: string[];
  listens: string[];
}

function socketInodes(): Map<string, string> {
  const map = new Map<string, string>(); // inode → "addr:port"
  const v4 = (hex: string) => hex.match(/../g)!.reverse().map((b) => parseInt(b, 16)).join(".");
  for (const [f, six] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[3] !== "0A") continue;
      const [a, p] = c[1]!.split(":");
      const addr = six ? (/^0+$/.test(a!) ? "[::]" : a === "00000000000000000000000001000000" ? "[::1]" : `[${a}]`) : v4(a!);
      map.set(c[9]!, `${addr}:${parseInt(p!, 16)}`);
    }
  }
  return map;
}

/** Every process in this PID namespace that holds a listening socket. Only meaningful inside the sandbox. */
export function listeningProcesses(): Proc[] {
  const inodes = socketInodes();
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const listens: string[] = [];
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let link = "";
        try {
          link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && inodes.has(m[1]!)) listens.push(inodes.get(m[1]!)!);
      }
      if (!listens.length) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      out.push({ pid, cmdline, listens: [...new Set(listens)].sort() });
    } catch {}
  }
  return out;
}

/** The parts of a process the attribution looks at (from /proc). */
export interface ProcFacts {
  pid: number;
  exe: string; // realpath of /proc/<pid>/exe
  cmdline: string[];
  cwd: string;
}

/**
 * Why a process is not the candidate, or null if it is. It is the candidate when its executable is inside the
 * candidate folder, or when its executable is the run's Bun (the runtime folder holds only that) and the script Bun
 * runs, its first non-flag argument, resolves inside the candidate folder. A candidate path anywhere else on the
 * command line counts for nothing.
 */
export function notCandidate(p: ProcFacts, info: { dir: string; bun: string }): string | null {
  const dir = realpathSync(info.dir);
  const inside = (f: string) => f === dir || f.startsWith(dir + "/");
  if (inside(p.exe)) return null;
  if (p.exe !== info.bun) return `pid ${p.pid} runs ${p.exe}, neither the candidate nor the run's Bun`;
  const script = p.cmdline.slice(1).find((a) => !a.startsWith("-"));
  if (!script) return `pid ${p.pid} is Bun with no script`;
  let real = resolve(p.cwd, script);
  try {
    real = realpathSync(real);
  } catch {}
  return inside(real) ? null : `pid ${p.pid} is Bun running ${script}, outside the candidate`;
}

function procFacts(pid: number): ProcFacts {
  return {
    pid,
    exe: realpathSync(`/proc/${pid}/exe`),
    cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
    cwd: readlinkSync(`/proc/${pid}/cwd`),
  };
}

/**
 * Check that whatever listens now was started from the candidate (and not, say, a Bun global install), and say
 * which process model that is. Only meaningful inside the sandbox, where nothing else runs.
 */
export function observeCandidate(info: CandidateInfo): { model: "in-process" | "child"; lines: string[] } {
  const procs = listeningProcesses().filter((p) => p.pid !== process.pid);
  if (!procs.length) throw new Error("candidate check: nothing is listening");
  const bun = realpathSync(join(info.runtimeDir, "bun"));
  const lines: string[] = [];
  const problems: string[] = [];
  for (const p of procs) {
    const f = procFacts(p.pid);
    const why = notCandidate(f, { dir: info.dir, bun });
    if (why) problems.push(why);
    const script = f.exe === bun ? f.cmdline.slice(1).find((a) => !a.startsWith("-")) ?? "" : f.exe;
    lines.push(`pid ${p.pid} ${script.replace(info.dir, "<candidate>")} ${f.cmdline.slice(2).join(" ")} listens ${p.listens.join(" ")}`);
  }
  if (problems.length) throw new Error(`candidate check: listeners not started from the candidate: ${problems.join("; ")}`);
  return { model: procs.length === 1 ? "in-process" : "child", lines };
}

// ── the box launch: a person's install, as `parachute serve` runs it on uni ─────────────────────────────────

async function freePort(taken: number[] = []): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const p = 47000 + Math.floor(Math.random() * 2500);
    if (taken.includes(p)) continue;
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      s.stop(true);
      return p;
    } catch {}
  }
  throw new Error("no free port");
}

export async function runCli(
  info: CandidateInfo,
  home: string,
  args: string[],
  opts: { bin?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([opts.bin ?? info.bin, ...args], {
    env: candidateEnv(info, home, opts.env),
    cwd: dirname(home),
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function waitFor(url: string, ok: (r: Response) => boolean, what: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if (ok(await safeFetch(url))) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`${what} did not come up at ${url}\n--- log tail ---\n${log().slice(-2500)}`);
}

export interface CandidateRunning extends Running {
  info: CandidateInfo;
  workarounds: string[];
  observed: { model: "in-process" | "child"; lines: string[] };
}

/**
 * Start the candidate as a box install: create a vault, then `parachute serve` on a random port with the hub
 * supervising the vault, an admin seeded from the environment, an operator token rotated, and an admin pass minted
 * with the real CLI. Everything else the contracts do goes through HTTP and MCP.
 */
export async function startCandidateBox(info: CandidateInfo, opts: { keep?: boolean } = {}): Promise<CandidateRunning> {
  const home = freshHome(info, "box");
  const user = dirname(home);
  const log = join(user, "serve.log");
  const workarounds: string[] = [];
  let hub: ReturnType<typeof Bun.spawn> | null = null;
  const stop = async () => {
    if (hub && hub.exitCode === null && hub.signalCode === null) {
      hub.kill("SIGTERM");
      const done = await Promise.race([hub.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      if (!done) hub.kill("SIGKILL");
    }
    if (!opts.keep) rmSync(user, { recursive: true, force: true });
  };
  try {
    const hubPort = await freePort();
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    allowOrigins(hubOrigin);
    const vaultName = `cand${randomBytes(3).toString("hex")}`;
    const admin = { username: "owner", password: `pw-${randomBytes(12).toString("hex")}` };
    const env = { PORT: String(hubPort), PARACHUTE_HUB_ORIGIN: hubOrigin, EMBEDDINGS_ENABLED: "false" };

    // 1. A vault, the way `parachute-vault create` makes one (registers it in services.json for the hub).
    const create = await runCli(info, home, ["create", vaultName, "--no-mirror", "--json"], { bin: info.vaultBin, env });
    if (create.code !== 0) throw new Error(`parachute-vault create failed (${create.code}): ${create.stderr.slice(-600)}`);

    // 2. The hub. Today's `serve` binds every interface unless told (fix 2, safety/loopback); a box sets it.
    const serveEnv: Record<string, string> = {};
    if (info.profile === "stock-0.7") {
      // Today's CLI signs passes with the issuer from hub/run/hub.port, falling back to :1939, and `serve` doesn't
      // write that file (fix 1, embedded/issuer). Prism's suite writes it too. A v0.8 candidate gets no such help.
      mkdirSync(join(home, "hub", "run"), { recursive: true });
      writeFileSync(join(home, "hub", "run", "hub.port"), `${hubPort}\n`);
      workarounds.push("hub/run/hub.port written (fix 1)");
      // The vault the hub starts fetches the hub's signing keys from :1939 unless PARACHUTE_HUB_JWKS_ORIGIN says
      // otherwise (vault src/hub-jwt.ts), so on any other port no pass verifies. Same family as fix 1.
      serveEnv.PARACHUTE_HUB_JWKS_ORIGIN = hubOrigin;
      workarounds.push("PARACHUTE_HUB_JWKS_ORIGIN set for the vault child (fix 1)");
    }
    const out = Bun.file(log);
    hub = Bun.spawn([info.bin, "serve"], {
      env: candidateEnv(info, home, {
        ...env,
        ...serveEnv,
        PARACHUTE_BIND_HOST: "127.0.0.1",
        PARACHUTE_INITIAL_ADMIN_USERNAME: admin.username,
        PARACHUTE_INITIAL_ADMIN_PASSWORD: admin.password,
      }),
      cwd: user,
      stdout: out,
      stderr: out,
    });
    const tail = () => (existsSync(log) ? readFileSync(log, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : "(no log)");
    await waitFor(`${hubOrigin}/health`, (r) => r.ok, "hub", tail);
    await waitFor(
      `${hubOrigin}/vault/${vaultName}/mcp`,
      (r) => r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vaultName}/`),
      "hub → vault route",
      tail,
    );

    // 3. The operator: rotate the operator token, then mint an admin pass with the real CLI.
    const rot = await runCli(info, home, ["auth", "rotate-operator"], { env });
    if (rot.code !== 0) throw new Error(`auth rotate-operator failed (${rot.code}): ${rot.stderr.slice(-600)}`);
    const scope = ["read", "write", "admin"].map((l) => `vault:${vaultName}:${l}`).join(" ");
    const mint = await runCli(info, home, ["auth", "mint-token", "--scope", scope, "--label", "contracts-operator"], { env });
    const operatorToken = mint.stdout.trim().split("\n").pop()!.trim();
    if (mint.code !== 0 || operatorToken.split(".").length !== 3) throw new Error(`auth mint-token failed (${mint.code}): ${mint.stderr.slice(-600)}`);

    const observed = observeCandidate(info);
    const services: Services = {
      hub: hubOrigin,
      vaultName,
      // The vault's own port is a box detail (today: 1940, inside the sandbox). Contracts use the hub; the guard
      // refuses 1939-1946 anyway.
      vaultDirect: `http://127.0.0.1:1940/vault/${vaultName}`,
      vaultViaHub: `${hubOrigin}/vault/${vaultName}`,
      operatorToken,
      operatorActor: JSON.parse(Buffer.from(operatorToken.split(".")[1]!, "base64url").toString()).sub,
      admin,
      hubRepo: "",
      home,
      cli: [info.bin],
      cliEnv: candidateEnv(info, home, env),
    };
    return {
      services,
      provenance: `candidate ${info.sha256.slice(0, 16)} (${info.profile})`,
      info,
      workarounds,
      observed,
      stop,
      logs: async () => tail(),
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Launchers for bin/parachute and bin/parachute-vault that record their pid before exec (see CandidateInfo.bin). */
export function makeLaunchers(dir: string, scratch: string): { bin: string; vaultBin: string; launchLog: string } {
  const launchDir = join(scratch, "launch");
  mkdirSync(launchDir, { recursive: true });
  const launchLog = join(scratch, "launches");
  writeFileSync(launchLog, "");
  const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  const make = (name: string) => {
    const at = join(launchDir, name);
    writeFileSync(at, `#!/bin/sh\necho $$ >> ${q(launchLog)}\nexec ${q(join(dir, "bin", name))} "$@"\n`, { mode: 0o755 });
    return at;
  };
  return { bin: make("parachute"), vaultBin: make("parachute-vault"), launchLog };
}

/** Make the CandidateInfo for a loaded candidate: a scratch folder and a runtime folder holding only Bun. */
export function prepareInfo(dir: string, manifest: CandidateManifest, sha256: string): CandidateInfo {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pcore-candidate-"));
  const runtimeDir = join(scratch, "runtime");
  mkdirSync(runtimeDir);
  // Only Bun: the folder it usually lives in (~/.bun/bin) also holds a globally installed `parachute`.
  symlinkSync(process.execPath, join(runtimeDir, "bun"));
  const d = resolve(dir);
  const launch = makeLaunchers(d, scratch);
  return {
    dir: d,
    ...launch,
    runtimeDir,
    scratch,
    oldStockDir: resolve(process.env.OLD_STOCK_DIR ?? (manifest.profile === "stock-0.7" ? d : join(import.meta.dir, "..", ".cache", "candidate-stock"))),
    profile: manifest.profile,
    processModel: manifest.process_model,
    sha256,
  };
}

// ── attribution for every launch, not only the box's ─────────────────────────────────────────────────────────

/** Listening socket inodes in the network namespace `pid` lives in (suites start boxes in nested namespaces). */
function listeningInodesOf(pid: number, cache: Map<string, Set<string>>): Set<string> {
  let ns = "";
  try {
    ns = readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return new Set();
  }
  const hit = cache.get(ns);
  if (hit) return hit;
  const set = new Set<string>();
  for (const f of ["tcp", "tcp6"]) {
    try {
      for (const line of readFileSync(`/proc/${pid}/net/${f}`, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c[3] === "0A") set.add(c[9]!);
      }
    } catch {}
  }
  cache.set(ns, set);
  return set;
}

/**
 * Watches the sandbox while the suites run. Any process that holds a listening socket and comes from a launch of the
 * candidate must itself be the candidate (`notCandidate`). A launch is a pid the launchers recorded (so a launch that
 * execs into other code, with whatever environment, is still known), a process run from the candidate folder, one
 * running in the candidate's environment (its bin/ on PATH, as candidateEnv() sets and children inherit), or a
 * descendant of any of these seen while its parent lived. What it can't see: a launch that forks, exits, and leaves
 * a child with a cleaned environment before the first sample; the sandbox, not this watcher, is the safety boundary. So a candidate that hands its work to code outside its folder (a global install found
 * on PATH, say) is caught whichever suite started it. It samples every 250 ms, so a listener that lives for less than
 * that can go unseen.
 */
export function watchAttribution(info: CandidateInfo): { stop(): string[] } {
  const dir = realpathSync(info.dir);
  const bun = realpathSync(join(info.runtimeDir, "bun"));
  const inside = (f: string) => f === dir || f.startsWith(dir + "/");
  const problems = new Set<string>();
  const launches = new Set<number>(); // remembered across samples: a launcher may exec into something else
  const registered = () => {
    try {
      for (const l of readFileSync(info.launchLog, "utf8").split("\n")) if (/^\d+$/.test(l)) launches.add(Number(l));
    } catch {}
  };
  const candidatePath = (pid: number) => {
    try {
      const path = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith("PATH="));
      return !!path && path.slice(5).split(":").some((d) => d === `${info.dir}/bin` || d === `${dir}/bin`);
    } catch {
      return false;
    }
  };
  const scan = () => {
    registered();
    const procs = new Map<number, { ppid: number; launch: boolean; facts: ProcFacts | null }>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const facts = procFacts(pid);
        const launch = inside(facts.exe) || facts.cmdline.slice(0, 2).some((a) => {
          try {
            return inside(realpathSync(resolve(facts.cwd, a)));
          } catch {
            return inside(resolve(facts.cwd, a));
          }
        });
        if (launch || candidatePath(pid)) launches.add(pid);
        procs.set(pid, { ppid, launch: launches.has(pid), facts });
      } catch {}
    }
    const nets = new Map<string, Set<string>>();
    for (const [pid, p] of procs) {
      if (pid === process.pid || !p.facts) continue;
      const listening = listeningInodesOf(pid, nets);
      if (!listening.size) continue;
      let holds = false;
      try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
          if (m && listening.has(m[1]!)) holds = true;
        }
      } catch {}
      if (!holds) continue;
      let fromCandidate = false;
      for (let q: number | undefined = pid, hops = 0; q && hops < 64; q = procs.get(q)?.ppid, hops++) {
        if (procs.get(q)?.launch) fromCandidate = true;
      }
      if (!fromCandidate) continue;
      const why = notCandidate(p.facts, { dir, bun });
      if (why) problems.add(`${why} (${p.facts.cmdline.join(" ").replace(dir, "<candidate>").slice(0, 200)})`);
    }
  };
  const timer = setInterval(scan, 250);
  scan();
  return {
    stop() {
      clearInterval(timer);
      scan();
      return [...problems];
    },
  };
}
