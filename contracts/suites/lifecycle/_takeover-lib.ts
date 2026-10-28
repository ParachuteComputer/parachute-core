// A person's machine, for identity.test.ts and takeover.test.ts: a throwaway user HOME with the old (0.7) programs
// installed globally the way `bun add -g` lays them out, a fake `systemctl` that knows the old units, a stock home
// made by those old programs, and a network of its own.
//
// Why each piece:
//   - The old programs are the stock 0.7 build (candidate-lib oldStockDir(), hash-checked),
//     not the candidate: once the candidate is v0.8 its folder holds core, and the point is old next to new.
//     Today the candidate *is* that build, so this is the brief's "copy the candidate's own lib/hub and lib/vault".
//   - The layout copies what bun did on uni (read-only look, 10-27): ~/.bun/bin/parachute is a relative symlink to
//     ../install/global/node_modules/@openparachute/hub/src/cli.ts, parachute-vault likewise to vault/src/cli.ts,
//     and ~/.bun/install/global/package.json lists both. BUN_INSTALL points at it, so a `bun add -g` by anything
//     under test would land in the tree we hash.
//   - systemd user units are outside our control, so `systemctl` is a shell script first on PATH that answers from
//     a state folder and logs every call (faking an external system; no Parachute code is faked).
//   - Today's hub always puts its vault child on port 1940 (hub src/commands/serve-boot.ts:104), and the suite's own
//     box already holds 1940 in the sandbox. So each machine gets its own network namespace (a holder process), and
//     everything on the machine runs in it via nsenter. A two-hop bridge (TCP in the sandbox → a unix socket → TCP
//     in the machine, same port number on both sides) lets the contracts call the machine's hub at the same origin
//     the hub thinks it has, through lib.ts's rest() and the guard. No packet leaves loopback.
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { Database } from "bun:sqlite";
import { dirname, join, relative, resolve } from "node:path";
import { candidateEnv, loadCandidate, oldStockWant, treeHash, type CandidateInfo } from "../../harness/candidate.ts";
import { allowOrigins, candidate, freePort, oldStockDir, newHome, safeFetch, until } from "../candidate-lib.ts";
import { must, rest } from "../lib.ts";

export { must, treeHash };

// ── the old programs ─────────────────────────────────────────────────────────────────────────────────────────

export interface OldStock {
  dir: string;
  hubVersion: string;
  vaultVersion: string;
}

let oldStockCache: OldStock | null = null;

/** The stock 0.7 build the old global install is copied from, checked against its own CANDIDATE.json hash. */
export async function oldStock(): Promise<OldStock> {
  if (oldStockCache) return oldStockCache;
  const dir = oldStockDir();
  const { manifest } = await loadCandidate(dir, oldStockWant());
  must(manifest.profile === "stock-0.7", `setup: ${dir} is not a stock 0.7 build (profile ${manifest.profile})`);
  const pkg = (p: string) => JSON.parse(readFileSync(join(dir, "lib", p, "package.json"), "utf8"));
  const hub = pkg("hub");
  const vault = pkg("vault");
  must(hub.name === "@openparachute/hub" && vault.name === "@openparachute/vault", "setup: stock lib/hub or lib/vault has an unexpected package name");
  oldStockCache = { dir, hubVersion: hub.version, vaultVersion: vault.version };
  return oldStockCache;
}

/** Lay out `bun add -g @openparachute/hub @openparachute/vault` under `user`, from the stock build. */
async function layOldGlobalInstall(user: string, stock: OldStock): Promise<void> {
  const global = join(user, ".bun", "install", "global");
  const scope = join(global, "node_modules", "@openparachute");
  mkdirSync(scope, { recursive: true });
  mkdirSync(join(user, ".bun", "bin"), { recursive: true });
  for (const p of ["hub", "vault"]) {
    const cp = Bun.spawnSync(["cp", "-a", join(stock.dir, "lib", p), join(scope, p)], { stderr: "pipe" });
    must(cp.exitCode === 0, `setup: copying lib/${p} into the fake global install failed: ${cp.stderr.toString()}`);
  }
  writeFileSync(
    join(global, "package.json"),
    JSON.stringify({ dependencies: { "@openparachute/hub": `^${stock.hubVersion}`, "@openparachute/vault": `^${stock.vaultVersion}` } }, null, 2) + "\n",
  );
  symlinkSync(process.execPath, join(user, ".bun", "bin", "bun"));
  symlinkSync("../install/global/node_modules/@openparachute/hub/src/cli.ts", join(user, ".bun", "bin", "parachute"));
  symlinkSync("../install/global/node_modules/@openparachute/vault/src/cli.ts", join(user, ".bun", "bin", "parachute-vault"));
}

// ── the fake systemctl ───────────────────────────────────────────────────────────────────────────────────────

export interface UnitState {
  active: boolean;
  enabled: boolean;
}

const FAKE_SYSTEMCTL = `#!/bin/sh
# Fake systemctl for the contracts (an outside system). Answers from STATE/<unit>.active and STATE/<unit>.enabled,
# changes them on start/stop/enable/disable (with --now), and logs every call to STATE/calls.log.
# - Units the test seeds (the old hub and vault) are bookkeeping only: each test runs the old programs itself.
# - A unit known only by its file in UNITS (one the program under test installs, as systemd knows it after
#   daemon-reload) is run for real: start runs its ExecStart= with its Environment= in a clean environment and a
#   session of its own (no terminal's hang-up reaches it), as
#   STATE/<unit>.pid; stop ends it; is-active says "failed" once its process is gone; show names its MainPID.
# - show prints a unit file's Environment= lines (systemd prints the assignments it would pass).
STATE=__STATE__
UNITS=__UNITS__
echo "$*" >> "$STATE/calls.log"
verb=""; now=""; units=""; props=""
while [ $# -gt 0 ]; do
  case "$1" in
    --now) now=1 ;;
    -p|--property) shift; props="$props,$1" ;;
    --property=*) props="$props,\${1#--property=}" ;;
    -*) ;;
    *) if [ -z "$verb" ]; then verb="$1"; else u="$1"; case "$u" in *.service) ;; *) u="$u.service" ;; esac; units="$units $u"; fi ;;
  esac
  shift
done
seeded() { [ -f "$STATE/$1.seeded" ]; }
known() { seeded "$1" || [ -f "$UNITS/$1" ]; }
alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }
st() {
  if [ "$2" = active ] && [ -f "$STATE/$1.pid" ] && ! alive "$1"; then echo failed; return; fi
  if [ -f "$STATE/$1.$2" ]; then cat "$STATE/$1.$2"; elif [ "$2" = active ]; then echo inactive; else echo disabled; fi
}
run_unit() {
  seeded "$1" && return 0
  alive "$1" && return 0
  f="$UNITS/$1"
  cmd=$(sed -n 's/^ExecStart=//p' "$f" | head -1 | sed 's/%%/%/g')
  (
    exec 0</dev/null >>"$STATE/$1.log" 2>&1
    envs=$(sed -n 's/^Environment=//p' "$f" | sed 's/%%/%/g')
    exec setsid env -i HOME="$HOME" PATH="$PATH" LANG=C.UTF-8 TMPDIR="$TMPDIR" sh -c "
      $(echo "$envs" | while IFS= read -r l; do [ -n "$l" ] && echo "export $l"; done)
      $(sed -n 's/^EnvironmentFile=//p' "$f" | sed 's/^-//' | while IFS= read -r ef; do echo "[ -f '$ef' ] && . '$ef'"; done)
      exec $cmd"
  ) &
  echo $! > "$STATE/$1.pid"
}
stop_unit() {
  alive "$1" || { rm -f "$STATE/$1.pid"; return 0; }
  pid=$(cat "$STATE/$1.pid"); kill -TERM "$pid" 2>/dev/null
  i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  rm -f "$STATE/$1.pid"
}
code=0
case "$verb" in
  daemon-reload) exit 0 ;;
  show-environment) exit 0 ;;
  is-active) for u in $units; do if known "$u"; then s=$(st "$u" active); echo "$s"; [ "$s" = active ] || code=3; else echo inactive; code=3; fi; done; exit $code ;;
  is-enabled) for u in $units; do if known "$u"; then s=$(st "$u" enabled); echo "$s"; [ "$s" = enabled ] || code=1; else echo "Failed to get unit file state for $u: No such file or directory" >&2; code=1; fi; done; exit $code ;;
  start|stop|restart|enable|disable)
    for u in $units; do
      known "$u" || { echo "Unit $u not found." >&2; exit 5; }
      case "$verb" in
        start) echo active > "$STATE/$u.active"; run_unit "$u" ;;
        restart) stop_unit "$u"; echo active > "$STATE/$u.active"; run_unit "$u" ;;
        stop) stop_unit "$u"; echo inactive > "$STATE/$u.active" ;;
        enable) echo enabled > "$STATE/$u.enabled"; if [ -n "$now" ]; then echo active > "$STATE/$u.active"; run_unit "$u"; fi ;;
        disable) echo disabled > "$STATE/$u.enabled"; if [ -n "$now" ]; then stop_unit "$u"; echo inactive > "$STATE/$u.active"; fi ;;
      esac
    done; exit 0 ;;
  show)
    for u in $units; do
      if known "$u"; then a=$(st "$u" active); e=$(st "$u" enabled); l=loaded; else a=inactive; e=""; l=not-found; fi
      pid=0; alive "$u" && pid=$(cat "$STATE/$u.pid")
      echo "Id=$u"; echo "LoadState=$l"; echo "ActiveState=$a"; echo "UnitFileState=$e"; echo "MainPID=$pid"
      if [ -f "$UNITS/$u" ]; then echo "FragmentPath=$UNITS/$u"; fi
      if [ -f "$UNITS/$u" ]; then echo "Environment=$(sed -n 's/^Environment=//p' "$UNITS/$u" | tr '\n' ' ' | sed 's/ $//')"; fi
      echo
    done; exit 0 ;;
  list-unit-files)
    for f in "$STATE"/*.enabled; do [ -f "$f" ] || continue; u=$(basename "$f" .enabled); echo "$u $(cat "$f")"; done; exit 0 ;;
  list-units)
    for f in "$STATE"/*.active; do [ -f "$f" ] || continue; u=$(basename "$f" .active); s=$(cat "$f"); [ "$s" = active ] && echo "$u loaded active running"; done; exit 0 ;;
  *) echo "fake systemctl: '$verb' is not supported by the contracts' fake" >&2; exit 1 ;;
esac
`;

function unitFileText(name: string, env: Record<string, string> = {}): string {
  const what = name.startsWith("parachute-vault") ? "parachute-vault serve" : "parachute serve";
  const lines = Object.entries(env).map(([k, v]) => `Environment=${k}=${v}\n`).join("");
  return `[Unit]\nDescription=Parachute (${name}, made-up unit for the contracts)\n\n[Service]\nExecStart=%h/.bun/bin/${what}\n${lines}Restart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}

// ── the machine ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Proc {
  proc: ReturnType<typeof Bun.spawn>;
  log(): string;
  stop(signal?: NodeJS.Signals, ms?: number): Promise<number | null>;
}

export interface Machine {
  info: CandidateInfo;
  user: string; // the user's HOME
  home: string; // PARACHUTE_HOME
  bunDir: string; // ~/.bun
  npmPrefix: string; // NPM_CONFIG_PREFIX, an empty npm global prefix that must stay so
  unitDir: string; // ~/.config/systemd/user
  units: string[];
  /** The environment a person's shell gives: fake systemctl, ~/.bun/bin, Bun, the system. Never the candidate's bin. */
  env(extra?: Record<string, string>): Record<string, string>;
  /** Run a command on the machine (in its network) to completion. argv[0] is looked up on the machine's PATH. */
  run(argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; stdin?: string }): Promise<Ran>;
  /** Start a long-running command on the machine, output to a log file. */
  spawn(argv: string[], opts?: { env?: Record<string, string> }): Proc;
  /** Make the machine's 127.0.0.1:<port> callable from the contracts at the same origin; returns the origin. */
  expose(port: number): Promise<string>;
  /** The fake systemctl's state for a unit, and every call it has had. */
  unit(name: string): UnitState;
  systemctlCalls(): string[];
  dispose(): Promise<void>;
}

export async function newMachine(
  label: string,
  opts: { oldInstall?: boolean; units?: Record<string, UnitState> } = {},
): Promise<Machine> {
  const info = candidate();
  const stock = await oldStock();
  const home = newHome(label);
  const user = dirname(home);
  if (opts.oldInstall !== false) await layOldGlobalInstall(user, stock);
  else mkdirSync(join(user, ".bun", "bin"), { recursive: true });

  const npmPrefix = join(user, ".npm-global");
  mkdirSync(join(npmPrefix, "lib", "node_modules"), { recursive: true });
  mkdirSync(join(npmPrefix, "bin"), { recursive: true });

  const fakeBin = join(user, ".fake", "bin");
  const state = join(user, ".fake", "systemd");
  const unitDir = join(user, ".config", "systemd", "user");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(fakeBin, "systemctl"), FAKE_SYSTEMCTL.replace("__STATE__", JSON.stringify(state)).replace("__UNITS__", JSON.stringify(unitDir)), { mode: 0o755 });
  writeFileSync(join(state, "calls.log"), "");
  const units = opts.units ?? {};
  for (const [name, s] of Object.entries(units)) {
    writeFileSync(join(unitDir, name), unitFileText(name));
    writeFileSync(join(state, `${name}.active`), s.active ? "active\n" : "inactive\n");
    writeFileSync(join(state, `${name}.seeded`), "");
    writeFileSync(join(state, `${name}.enabled`), s.enabled ? "enabled\n" : "disabled\n");
  }

  // The machine's own network: a holder process in a new network namespace with loopback up.
  const holder = Bun.spawn(["unshare", "--net", "--", "sh", "-c", "ip link set lo up && exec sleep 100000"], { stdout: "ignore", stderr: "pipe" });
  const netns = `/proc/${holder.pid}/ns/net`;
  must(await until(() => Bun.spawnSync(["nsenter", `--net=${netns}`, "--", "ip", "-o", "addr", "show", "lo"]).stdout.toString().includes("127.0.0.1"), 5000, 50), "setup: the machine's network did not come up");

  const PATH = `${fakeBin}:${join(user, ".bun", "bin")}:${info.runtimeDir}:/usr/local/bin:/usr/bin:/bin`;
  const env = (extra: Record<string, string> = {}) =>
    candidateEnv(info, home, { PATH, BUN_INSTALL: join(user, ".bun"), NPM_CONFIG_PREFIX: npmPrefix, EMBEDDINGS_ENABLED: "false", ...extra });
  const procs: Proc[] = [];
  const servers: Server[] = [];
  const nsenter = Bun.which("nsenter")!;
  const inNet = (argv: string[]) => [nsenter, `--net=${netns}`, "--", ...argv];

  const machine: Machine = {
    info,
    user,
    home,
    bunDir: join(user, ".bun"),
    npmPrefix,
    unitDir,
    units: Object.keys(units),
    env,
    async run(argv, o = {}) {
      const e = env(o.env);
      const p = Bun.spawn(inNet(argv), {
        env: e,
        cwd: user,
        stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 90_000);
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      return { code, stdout, stderr };
    },
    spawn(argv, o = {}) {
      const logPath = join(user, `${argv.map((a) => a.split("/").pop()).join("-").slice(0, 40)}-${Date.now()}.log`);
      const proc = Bun.spawn(inNet(argv), { env: env(o.env), cwd: user, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
      const handle: Proc = {
        proc,
        log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : ""),
        async stop(signal = "SIGTERM", ms = 15_000) {
          if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
          proc.kill(signal);
          const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
          if (!done) {
            proc.kill("SIGKILL");
            await proc.exited;
            return null;
          }
          return proc.exitCode;
        },
      };
      procs.push(handle);
      return handle;
    },
    async expose(port) {
      const sock = join(user, `.fake`, `net-${port}.sock`);
      // Inside the machine: unix socket → 127.0.0.1:<port>.
      const inner = `const net=require("node:net");net.createServer((c)=>{const t=net.connect(${port},"127.0.0.1");c.pipe(t);t.pipe(c);c.on("error",()=>t.destroy());t.on("error",()=>c.destroy());}).listen(${JSON.stringify(sock)});`;
      machine.spawn([process.execPath, "-e", inner]);
      must(await until(() => existsSync(sock), 5000, 50), "setup: the machine's bridge did not come up");
      // In the sandbox: 127.0.0.1:<port> → the unix socket.
      const outer = createServer((c) => {
        const t = connect(sock);
        c.pipe(t);
        t.pipe(c);
        c.on("error", () => t.destroy());
        t.on("error", () => c.destroy());
      });
      await new Promise<void>((ok, fail) => outer.once("error", fail).listen(port, "127.0.0.1", () => ok()));
      servers.push(outer);
      const origin = `http://127.0.0.1:${port}`;
      allowOrigins(origin);
      return origin;
    },
    unit(name) {
      return {
        active: readFileSync(join(state, `${name}.active`), "utf8").trim() === "active",
        enabled: readFileSync(join(state, `${name}.enabled`), "utf8").trim() === "enabled",
      };
    },
    systemctlCalls() {
      return readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean);
    },
    async dispose() {
      // Units the fake systemctl started (parachute-core.service after a takeover).
      for (const f of readdirSync(state).filter((n) => n.endsWith(".pid"))) {
        try {
          process.kill(Number(readFileSync(join(state, f), "utf8")), "SIGKILL");
        } catch {}
      }
      for (const p of procs.reverse()) await p.stop("SIGTERM", 10_000);
      for (const s of servers) s.close();
      holder.kill("SIGKILL");
      await holder.exited;
      if (process.env.KEEP_MACHINES !== "1") rmSync(user, { recursive: true, force: true });
    },
  };
  return machine;
}

/** The units a box like uni or Adam's has: the hub running and enabled, a leftover vault unit off and disabled. */
export const OLD_UNITS: Record<string, UnitState> = {
  "parachute-hub.service": { active: true, enabled: true },
  "parachute-vault.service": { active: false, enabled: false },
};

// ── the stock home and the old box ───────────────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  path: string;
  content: string;
  updatedAt: string;
}

export interface StockHome {
  vaultName: string;
  port: number;
  origin: string;
  /** What the old box was started with; core gets the same port and origin, as a swapped ExecStart would. */
  serveEnv: Record<string, string>;
  writePass: string;
  /** A read pass the old hub minted before any takeover; it must still verify afterwards. */
  readPass: string;
  notes: Note[];
}

const MADE_UP = [
  { path: "garden/tomatoes", content: "Stake the tomatoes before the July heat. Try the yellow pear variety next year." },
  { path: "garden/compost", content: "Turn the compost every two weeks; it smells sweet when it is ready." },
  { path: "kitchen/bread", content: "Rye starter: feed at 1:5:5, bake when it doubles in six hours." },
];

/** Start the old `parachute serve` (from the user's PATH, i.e. the global install) on the home; waits for the vault. */
export async function startOldBox(m: Machine, s: Pick<StockHome, "vaultName" | "origin" | "serveEnv">): Promise<Proc> {
  const box = settling(m, m.spawn(["parachute", "serve"], { env: s.serveEnv }));
  await waitVault(s.origin, s.vaultName, box, "the old parachute serve");
  return box;
}

/**
 * The v0.8 that parachute-core.service runs after a takeover (the fake systemctl runs units the program installs):
 * waits until it serves the vault; `stop()` stops the unit, as `systemctl --user stop` would, and waits until nothing
 * holds the home's databases.
 */
export async function coreUnit(m: Machine, s: Pick<StockHome, "vaultName" | "origin">): Promise<{ stop(): Promise<void>; log(): string }> {
  const log = () => (existsSync(join(m.user, ".fake", "systemd", "parachute-core.service.log")) ? readFileSync(join(m.user, ".fake", "systemd", "parachute-core.service.log"), "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : "");
  const up = await until(async () => {
    const r = await safeFetch(`${s.origin}/vault/${s.vaultName}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${s.vaultName}/`);
  }, 60_000);
  must(up, `parachute-core.service is not serving vault ${s.vaultName} after takeover:\n${log().slice(-2000)}`);
  return {
    log,
    async stop() {
      await m.run(["systemctl", "--user", "stop", "parachute-core.service"]);
      await until(() => dbHolders(m.home).length === 0, 15_000, 100);
    },
  };
}

/** Start the candidate's `parachute-core serve` on the home, with the old box's port and origin. */
export async function startCore(m: Machine, s: Pick<StockHome, "vaultName" | "origin" | "serveEnv">): Promise<Proc> {
  const box = settling(m, m.spawn([requireCore(m.info), "serve"], { env: s.serveEnv }));
  await waitVault(s.origin, s.vaultName, box, "parachute-core serve");
  return box;
}

/**
 * Make `stop()` also wait until nothing holds the home's databases. Today's hub can exit before its vault child
 * does (seen 10-27: the child still held vault.db after the hub's exit), and these tests need a home that is
 * really at rest before the next step. Whether a stop leaves a child behind is lifecycle/shutdown's contract, not
 * this file's, so a leftover is waited for, then stopped.
 */
function settling(m: Machine, box: Proc): Proc {
  const stop = box.stop;
  box.stop = async (signal, ms) => {
    const code = await stop(signal, ms);
    if (!(await until(() => dbHolders(m.home).length === 0, 15_000, 100))) {
      for (const h of dbHolders(m.home)) process.kill(h.pid, "SIGTERM");
      if (!(await until(() => dbHolders(m.home).length === 0, 10_000, 100))) for (const h of dbHolders(m.home)) process.kill(h.pid, "SIGKILL");
    }
    return code;
  };
  return box;
}

async function waitVault(origin: string, vaultName: string, box: Proc, what: string): Promise<void> {
  const up = await until(async () => {
    if (box.proc.exitCode !== null) return true;
    const r = await safeFetch(`${origin}/vault/${vaultName}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vaultName}/`);
  }, 60_000);
  must(up && box.proc.exitCode === null, `${what} did not come up serving vault ${vaultName} (exit ${box.proc.exitCode}):\n${box.log().slice(-2000)}`);
}

/**
 * Make a stock home the way a person did: `parachute-vault create`, then `parachute serve`, an operator pass from
 * the real CLI, a few made-up notes written over REST, then a clean stop. All with the old programs on PATH.
 */
export async function makeStockHome(m: Machine): Promise<StockHome> {
  const vaultName = `old${randomBytes(3).toString("hex")}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const base = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin };
  const create = await m.run(["parachute-vault", "create", vaultName, "--no-mirror", "--json"], { env: base });
  must(create.code === 0, `setup: old parachute-vault create failed (${create.code}): ${create.stderr.slice(-800)}`);
  // Today's CLI signs with the issuer from hub/run/hub.port (else :1939), and its vault child fetches keys from :1939
  // unless told (fix 1). The same workarounds the candidate box uses (harness/candidate.ts); a unit on uni sets them.
  mkdirSync(join(m.home, "hub", "run"), { recursive: true });
  writeFileSync(join(m.home, "hub", "run", "hub.port"), `${port}\n`);
  const serveEnv = {
    ...base,
    PARACHUTE_HUB_JWKS_ORIGIN: origin,
    PARACHUTE_BIND_HOST: "127.0.0.1",
    PARACHUTE_INITIAL_ADMIN_USERNAME: "owner",
    PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${randomBytes(12).toString("hex")}`,
  };
  // The old units carry what the old box runs with, as an install's unit (or its drop-in) does; no password.
  const unitEnv = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin, PARACHUTE_HUB_JWKS_ORIGIN: origin, PARACHUTE_BIND_HOST: "127.0.0.1" };
  for (const u of m.units) writeFileSync(join(m.unitDir, u), unitFileText(u, unitEnv));
  await m.expose(port);
  const box = await startOldBox(m, { vaultName, origin, serveEnv });
  try {
    const rot = await m.run(["parachute", "auth", "rotate-operator"], { env: base });
    must(rot.code === 0, `setup: old parachute auth rotate-operator failed (${rot.code}): ${rot.stderr.slice(-600)}`);
    const mint = async (levels: string[], label: string) => {
      const r = await m.run(["parachute", "auth", "mint-token", "--scope", levels.map((l) => `vault:${vaultName}:${l}`).join(" "), "--label", label], { env: base });
      const t = r.stdout.trim().split("\n").pop()!.trim();
      must(r.code === 0 && t.split(".").length === 3, `setup: old parachute auth mint-token failed (${r.code}): ${r.stderr.slice(-600)}`);
      return t;
    };
    const writePass = await mint(["read", "write"], "takeover-writer");
    const readPass = await mint(["read"], "takeover-reader");
    const api = rest(`${origin}/vault/${vaultName}`, writePass);
    const notes: Note[] = [];
    for (const n of MADE_UP) {
      const r = await api.post("/notes", { path: n.path, content: n.content, tags: ["made-up"] });
      must(r.status === 201, `setup: writing a note through the old box gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      notes.push({ id: r.body.id, path: r.body.path, content: r.body.content, updatedAt: r.body.updatedAt });
    }
    return { vaultName, port, origin, serveEnv, writePass, readPass, notes };
  } finally {
    const code = await box.stop();
    must(code === 0 || code === 143, `setup: the old box did not stop cleanly (exit ${code}):\n${box.log().slice(-1500)}`);
  }
}

/** Every note in the vault, read through the hub with `token`, sorted by path. */
export async function readNotes(origin: string, vaultName: string, token: string): Promise<{ status: number; notes: Note[] }> {
  const r = await rest(`${origin}/vault/${vaultName}`, token).get(`/notes?limit=500&include_content=true`);
  const list: any[] = Array.isArray(r.body) ? r.body : (r.body?.notes ?? []);
  const notes = list.map((n) => ({ id: n.id, path: n.path, content: n.content, updatedAt: n.updatedAt })).sort((a, b) => a.path.localeCompare(b.path));
  return { status: r.status, notes };
}

// ── core ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** bin/parachute-core in the candidate, or a failure that names its absence (red today). */
export function requireCore(info: CandidateInfo): string {
  const p = join(info.dir, "bin", "parachute-core");
  must(existsSync(p), `no bin/parachute-core in the candidate (it ships ${readdirSync(join(info.dir, "bin")).map((b) => `bin/${b}`).join(", ")})`);
  return p;
}

/** Run `parachute-core <args>` on the machine. */
export function core(m: Machine, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return m.run([requireCore(m.info), ...args], { env });
}

/** Parse a --json reply, or fail saying what came back. */
export function json(r: Ran, what: string): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}: stdout is not JSON (exit ${r.code}): ${r.stdout.slice(0, 400)} ${r.stderr.slice(-400)}`);
  }
}

/**
 * The old global packages, as one string to compare: the tree of ~/.bun/install/global and what
 * ~/.bun/bin/parachute and parachute-vault are. Not the rest of ~/.bun: every Bun program, stock included, writes
 * Bun's transpiler cache to ~/.bun/install/cache when BUN_INSTALL is ~/.bun (seen on the stock build, 10-27).
 */
export async function oldInstallHash(m: Machine): Promise<string> {
  const bins = ["parachute", "parachute-vault"].map((b) => {
    const p = join(m.bunDir, "bin", b);
    if (!existsSync(p) && !isLink(p)) return `${b}: missing`;
    return isLink(p) ? `${b} -> ${readlinkSync(p)}` : `${b}: file ${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  });
  return `${await treeHash(join(m.bunDir, "install", "global"))} | ${bins.join(" | ")}`;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── files, databases, processes ──────────────────────────────────────────────────────────────────────────────

/** sha256 of every regular file under `root`, by path relative to it. */
export function fileHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.set(relative(root, abs), createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

/** Every file named `name` under `root`. */
export function findFiles(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (n === name) out.push(abs);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * The highest version in a SQLite file's schema_version table (vault and hub both keep one). Read from a copy, so
 * opening it can't create a -shm file or touch the home.
 */
export function schemaOf(db: string): number {
  const scratch = join(candidate().scratch, `schema-${randomBytes(4).toString("hex")}`);
  mkdirSync(scratch);
  try {
    for (const suffix of ["", "-wal"]) if (existsSync(db + suffix)) copyFileSync(db + suffix, join(scratch, `x.db${suffix}`));
    const d = new Database(join(scratch, "x.db"));
    const row = d.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    d.close();
    return row.v;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Processes holding any SQLite file (`*.db`, `-wal`, `-shm`) under `home`. */
export function dbHolders(home: string): { pid: number; cmd: string }[] {
  return holders((link) => link.startsWith(home + "/") && /\.db(-wal|-shm)?$/.test(link));
}

/** Processes (pid, command line) that have `file` open (a path, or a test on the open file's path). */
export function holders(file: string | ((link: string) => boolean)): { pid: number; cmd: string }[] {
  const match = typeof file === "string" ? (l: string) => l === file : file;
  const out: { pid: number; cmd: string }[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      for (const fd of readdirSync(`/proc/${name}/fd`)) {
        let link = "";
        try {
          link = readlinkSync(`/proc/${name}/fd/${fd}`);
        } catch {
          continue;
        }
        if (match(link)) {
          out.push({ pid: Number(name), cmd: readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" ").trim() });
          break;
        }
      }
    } catch {}
  }
  return out;
}
