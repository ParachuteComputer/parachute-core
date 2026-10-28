// A private network and process namespace for candidate runs.
//
// A candidate is the real `parachute` program, started the way a user starts it. Today's code puts its vault on
// the fixed port 1940 whatever the hub's port is (hub src/commands/serve-boot.ts, reconcilePortToCanonical), and
// a box like uni has its live hub and vault on 1939 and 1940. So a candidate never runs in the host's network: the
// candidate runner re-executes itself under `unshare` with its own network (only loopback, plus a trap interface)
// and its own PID space, so a candidate can neither reach nor signal anything live. The contracts' guard still
// refuses ports 1939-1946 inside (harness/guard.ts).
//
// Files: the sandbox also has its own mounts. Fresh, empty tmpfs hide /run (the systemd and D-Bus sockets, Docker),
// /tmp and the user's home (every Unix socket kept there, and the live ~/.parachute). Only what a run needs is
// bound back, at the same path: this repo and the candidate read-only, and Bun and Node. So a candidate can't reach
// a host daemon through a socket file, nor write anything that outlives the run except through its own scratch.
//
// The trap: a dummy interface holds the default route, and an nftables counter counts every packet that leaves
// by anything but loopback. Nothing it counts can get anywhere (the dummy drops it), and the count is how
// "no outbound connection" is proved rather than sampled (embedded/offline).
import { readFileSync, writeFileSync } from "node:fs";

export const SANDBOX_ENV = "PCORE_SANDBOX";
const TRAP_IF = "pctrap0";

function run(cmd: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

function must(cmd: string[]): string {
  const r = run(cmd);
  if (r.code !== 0) throw new Error(`sandbox: ${cmd.join(" ")} failed (${r.code}): ${r.out.slice(-400)}`);
  return r.out;
}

/** Ports with a listening TCP socket in this network namespace (IPv4 and IPv6). */
export function listeningPorts(): number[] {
  const ports = new Set<number>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "0A") ports.add(parseInt(cols[1]!.split(":").pop()!, 16)); // 0A = LISTEN
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Listening sockets with their local address, e.g. "127.0.0.1:1939" or "0.0.0.0:1939" or "[::]:1939". */
export function listeners(): string[] {
  const out: string[] = [];
  const v4 = (hex: string) => hex.match(/../g)!.reverse().map((b) => parseInt(b, 16)).join(".");
  for (const [f, six] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] !== "0A") continue;
      const [addr, port] = cols[1]!.split(":");
      const p = parseInt(port!, 16);
      if (!six) out.push(`${v4(addr!)}:${p}`);
      else out.push(/^0+$/.test(addr!) ? `[::]:${p}` : addr === "00000000000000000000000001000000" ? `[::1]:${p}` : `[${addr}]:${p}`);
    }
  }
  return out.sort();
}

export function inSandbox(): boolean {
  return process.env[SANDBOX_ENV] === "2";
}

/** Network interfaces in this namespace. */
function links(): string[] {
  return must(["ip", "-o", "link", "show"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(":")[1]!.trim().split("@")[0]!);
}

/** On a macOS CI runner there are no namespaces: the run happens on the runner itself, a throwaway VM. */
export function onMacRunner(): boolean {
  return process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true";
}

/**
 * Called first by anything that starts a candidate. Outside the sandbox it re-executes the current command inside
 * one and exits with its code; inside, it checks the namespace really is private and sets up loopback and the trap.
 */
export async function enterSandbox(): Promise<void> {
  const level = process.env[SANDBOX_ENV];
  if (level === "2") return; // already inside, unprivileged
  if (process.platform === "darwin") {
    // macOS has no network or PID namespaces. The bundle's signed-tree runs (PLAN §7.3) happen only on GitHub's
    // macos-14 runners, where nothing else listens; never on a person's Mac, which may run a live Parachute.
    if (!onMacRunner()) throw new Error("sandbox: on macOS a candidate runs only on a CI runner (GITHUB_ACTIONS=true); there is no network namespace here");
    console.log("[sandbox] macOS CI runner: no namespaces, the run uses the runner itself");
    return;
  }
  if (!level) {
    // Host → level 1: new user, network, PID and mount namespaces, root inside them.
    const unshare = Bun.which("unshare");
    if (!unshare) throw new Error("sandbox: `unshare` (util-linux) is needed to run a candidate");
    const keep = keepPaths(); // before the env is copied: it records PCORE_NODE_BIN
    const p = Bun.spawn(
      [unshare, "--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child", "--", process.execPath, ...process.argv.slice(1)],
      {
        env: { ...process.env, [SANDBOX_ENV]: "1", PCORE_SANDBOX_KEEP: JSON.stringify(keep), PCORE_HOST_UID: String(process.getuid?.() ?? "") },
        stdio: ["inherit", "inherit", "inherit"],
      },
    );
    const forward = (sig: NodeJS.Signals) => () => p.kill(sig);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    // If unshare can't start (e.g. AppArmor's user-namespace restriction on Ubuntu 24.04), it says why on stderr.
    process.exit(await p.exited);
  }
  // Level 1 (root of the new namespaces): set up files and network, then run everything else one level down.
  const cwd = process.cwd();
  process.chdir("/"); // so nothing here keeps a handle on the host tree under the covers
  hideHostFiles(JSON.parse(process.env.PCORE_SANDBOX_KEEP ?? "[]"));
  setUpNetwork();
  process.chdir(cwd);
  // The trap counter needs CAP_NET_ADMIN over this network, which level 2 doesn't have: serve it from here.
  const trap = Bun.listen({ unix: TRAP_SOCKET, socket: { open: (sock) => void sock.end(String(outboundPackets())), data() {} } });
  // Level 2: a nested user and mount namespace. Mounts made above arrive locked: nothing at level 2 (the harness,
  // the suites, the candidate) can unmount a cover to see what is under it, or make a read-only path writable.
  const p = Bun.spawn(["unshare", "--user", "--map-root-user", "--mount", "--fork", "--kill-child", "--", process.execPath, ...process.argv.slice(1)], {
    env: { ...cleanEnv(), [SANDBOX_ENV]: "2" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const forward = (sig: NodeJS.Signals) => () => p.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  const code = await p.exited;
  trap.stop(true);
  process.exit(code);
}

const TRAP_SOCKET = "/run/pcore-trap.sock";

/** The environment for level 2: without the host session's sockets (gone with /run and /tmp anyway) or the setup. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const drop = new Set(["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "WAYLAND_DISPLAY", "DISPLAY", "TMUX", "PCORE_SANDBOX_KEEP"]);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) env[k] = v;
  return env;
}

/** Level 1: the namespace must be new and empty; bring up loopback and the trap. */
function setUpNetwork(): void {
  const have = links();
  const unexpected = have.filter((l) => l !== "lo");
  if (unexpected.length) throw new Error(`sandbox: not a private network namespace (interfaces: ${have.join(", ")})`);
  must(["ip", "link", "set", "lo", "up"]);
  const live = listeningPorts();
  if (live.length) throw new Error(`sandbox: fresh namespace already has listeners on ${live.join(", ")}`);
  must(["ip", "link", "add", TRAP_IF, "type", "dummy"]);
  // No router solicitations or duplicate-address checks of the kernel's own (suites/embedded/_lib.ts report()).
  for (const k of ["router_solicitations", "dad_transmits"]) writeFileSync(`/proc/sys/net/ipv6/conf/${TRAP_IF}/${k}`, "0");
  must(["ip", "addr", "add", "198.18.0.1/15", "dev", TRAP_IF]);
  must(["ip", "link", "set", TRAP_IF, "up"]);
  must(["ip", "route", "add", "default", "dev", TRAP_IF]);
  must(["ip", "-6", "route", "add", "default", "dev", TRAP_IF]);
  must(["nft", "add", "table", "inet", "pctrap"]);
  must(["nft", "add", "chain", "inet", "pctrap", "out", "{ type filter hook output priority 0; }"]);
  must(["nft", "add", "rule", "inet", "pctrap", "out", "oifname", "!=", "lo", "counter"]);
}

/** The sandbox-wide trap count, asked of level 1 (from level 2, where the suites and the candidate run). */
export async function sandboxOutboundPackets(): Promise<number> {
  const text = await new Promise<string>((done, fail) => {
    let buf = "";
    Bun.connect({ unix: TRAP_SOCKET, socket: { data: (_s, d) => void (buf += d.toString()), close: () => done(buf), error: (_s, e) => fail(e) } }).catch(fail);
  });
  const n = Number(text);
  if (!Number.isFinite(n) || text === "") throw new Error(`sandbox: trap answered ${JSON.stringify(text)}`);
  return n;
}

/** The real Node binary on the host, or null. Inside the sandbox, PCORE_NODE_BIN carries it. */
export function hostNode(): string | null {
  if (process.env.PCORE_NODE_BIN) return process.env.PCORE_NODE_BIN;
  const which = Bun.which("node");
  if (!which) return null;
  const r = Bun.spawnSync([which, "-e", "process.stdout.write(process.execPath)"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** What a run needs from the host filesystem, besides the system (/usr, /etc): this repo, the candidate and old stock
 *  build when they live elsewhere, Bun, and Node (Benjamin's suite). Computed outside, before the mounts. */
function keepPaths(): { path: string; rw: boolean }[] {
  const { realpathSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, resolve } = require("node:path") as typeof import("node:path");
  const repo = resolve(import.meta.dir, "..", "..");
  const keep: { path: string; rw: boolean }[] = [{ path: repo, rw: false }];
  // NPM_INSTALL_DIR: the scratch npm and bun installs of the npm package (harness/npm-package.ts).
  for (const k of ["CANDIDATE_DIR", "OLD_STOCK_DIR", "NPM_INSTALL_DIR"]) if (process.env[k]) keep.push({ path: resolve(process.env[k]!), rw: false });
  // The tarball and its SHA256SUMS (embedded/bundle checks them against the tree).
  if (process.env.CANDIDATE_TARBALL) keep.push({ path: dirname(resolve(process.env.CANDIDATE_TARBALL)), rw: false });
  keep.push({ path: realpathSync(process.execPath), rw: false });
  if (process.execPath !== realpathSync(process.execPath)) keep.push({ path: process.execPath, rw: false });
  // Node's real binary, asked of Node itself: a version manager's shim (mise, nvm) needs config the sandbox hides.
  const node = hostNode();
  if (node) {
    keep.push({ path: dirname(dirname(node)), rw: false }); // the install, so its lib/ comes along
    process.env.PCORE_NODE_BIN = node;
  }
  return keep.filter((k) => existsSync(k.path));
}

/** Inside the new mount namespace: tmpfs over /run, /tmp and $HOME, then bind back what `keep` names. */
function hideHostFiles(keep: { path: string; rw: boolean }[]): void {
  const { mkdirSync, statSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const home = process.env.HOME ?? "";
  must(["mount", "--make-rprivate", "/"]);
  // Stage the paths to keep somewhere the tmpfs won't cover, then cover, then put them back at the same path.
  must(["mount", "-t", "tmpfs", "-o", "mode=0755", "pcore-run", "/run"]);
  const stage = "/run/pcore-stage";
  mkdirSync(stage);
  const staged = keep.map((k, i) => {
    const dir = statSync(k.path).isDirectory();
    const at = join(stage, String(i));
    if (dir) mkdirSync(at);
    else writeFileSync(at, "");
    must(["mount", "--rbind", k.path, at]);
    return { ...k, at, dir };
  });
  must(["mount", "-t", "tmpfs", "-o", "mode=1777", "pcore-tmp", "/tmp"]);
  if (home && home !== "/") must(["mount", "-t", "tmpfs", "-o", "mode=0755", "pcore-home", home]);
  // Shortest first, so a path inside another kept path lands on top of it.
  for (const k of staged.sort((a, b) => a.path.length - b.path.length)) {
    if (k.dir) mkdirSync(k.path, { recursive: true });
    else {
      mkdirSync(dirname(k.path), { recursive: true });
      writeFileSync(k.path, "", { flag: "a" });
    }
    must(["mount", "--rbind", k.at, k.path]);
    if (!k.rw) must(["mount", "-o", "remount,bind,ro", k.path]);
  }
  // The staging binds are writable aliases of the kept paths: take them away.
  for (const k of staged) must(["umount", "-R", k.at]);
  must(["rm", "-rf", stage]);
  if (home) mkdirSync(home, { recursive: true });
}

/** Packets that tried to leave by anything but loopback since the sandbox started (or since `mark`). */
export function outboundPackets(): number {
  const m = must(["nft", "list", "table", "inet", "pctrap"]).match(/counter packets (\d+)/);
  if (!m) throw new Error("sandbox: trap counter missing");
  return Number(m[1]);
}
