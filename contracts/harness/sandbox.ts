// A private network and process namespace for candidate runs.
//
// A candidate is the real `parachute` program, started the way a user starts it. Today's code puts its vault on
// the fixed port 1940 whatever the hub's port is (hub src/commands/serve-boot.ts, reconcilePortToCanonical), and
// a box like uni has its live hub and vault on 1939 and 1940. So a candidate never runs in the host's network: the
// candidate runner re-executes itself under `unshare` with its own network (only loopback, plus a trap interface)
// and its own PID space, so a candidate can neither reach nor signal anything live. The contracts' guard still
// refuses ports 1939-1946 inside (harness/guard.ts).
//
// The trap: a dummy interface holds the default route, and an nftables counter counts every packet that leaves
// by anything but loopback. Nothing it counts can get anywhere (the dummy drops it), and the count is how
// "no outbound connection" is proved rather than sampled (embedded/offline).
import { readFileSync } from "node:fs";

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
  return process.env[SANDBOX_ENV] === "1";
}

/** Network interfaces in this namespace. */
function links(): string[] {
  return must(["ip", "-o", "link", "show"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(":")[1]!.trim().split("@")[0]!);
}

/**
 * Called first by anything that starts a candidate. Outside the sandbox it re-executes the current command inside
 * one and exits with its code; inside, it checks the namespace really is private and sets up loopback and the trap.
 */
export async function enterSandbox(): Promise<void> {
  if (!inSandbox()) {
    const unshare = Bun.which("unshare");
    if (!unshare) throw new Error("sandbox: `unshare` (util-linux) is needed to run a candidate");
    const p = Bun.spawn(
      [unshare, "--user", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child", "--", process.execPath, ...process.argv.slice(1)],
      { env: { ...process.env, [SANDBOX_ENV]: "1" }, stdio: ["inherit", "inherit", "inherit"] },
    );
    const forward = (sig: NodeJS.Signals) => () => p.kill(sig);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    // If unshare can't start (e.g. AppArmor's user-namespace restriction on Ubuntu 24.04), it says why on stderr.
    process.exit(await p.exited);
  }
  // Inside: the namespace must be new and empty. The only interfaces are loopback and, once made, the trap.
  const have = links();
  const unexpected = have.filter((l) => l !== "lo" && l !== TRAP_IF);
  if (unexpected.length) throw new Error(`sandbox: not a private network namespace (interfaces: ${have.join(", ")})`);
  if (!have.includes(TRAP_IF)) {
    must(["ip", "link", "set", "lo", "up"]);
    const live = listeningPorts();
    if (live.length) throw new Error(`sandbox: fresh namespace already has listeners on ${live.join(", ")}`);
    must(["ip", "link", "add", TRAP_IF, "type", "dummy"]);
    must(["ip", "addr", "add", "198.18.0.1/15", "dev", TRAP_IF]);
    must(["ip", "link", "set", TRAP_IF, "up"]);
    must(["ip", "route", "add", "default", "dev", TRAP_IF]);
    must(["ip", "-6", "route", "add", "default", "dev", TRAP_IF]);
    must(["nft", "add", "table", "inet", "pctrap"]);
    must(["nft", "add", "chain", "inet", "pctrap", "out", "{ type filter hook output priority 0; }"]);
    must(["nft", "add", "rule", "inet", "pctrap", "out", "oifname", "!=", "lo", "counter"]);
  }
}

/** Packets that tried to leave by anything but loopback since the sandbox started (or since `mark`). */
export function outboundPackets(): number {
  const m = must(["nft", "list", "table", "inet", "pctrap"]).match(/counter packets (\d+)/);
  if (!m) throw new Error("sandbox: trap counter missing");
  return Number(m[1]);
}
