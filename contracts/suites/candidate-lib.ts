// What the suites that start the candidate themselves share (embedded/, lifecycle/, some of compat/ and safety/).
// They only run under `bun run candidate` (harness/run-candidate.ts), inside the sandbox, and they only ever run
// the candidate's own bin/parachute and bin/parachute-vault. Nothing here imports vault or hub code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateEnv, freshHome, listeningProcesses, runCli, type CandidateInfo } from "../harness/candidate.ts";
import { listeners, listeningPorts, outboundPackets } from "../harness/sandbox.ts";
import { allowOrigins, safeFetch } from "../harness/guard.ts";

export { listeners, listeningPorts, listeningProcesses, outboundPackets, safeFetch, allowOrigins };

export function candidate(): CandidateInfo {
  const path = process.env.CONTRACT_CANDIDATE;
  if (!path) throw new Error("CONTRACT_CANDIDATE is not set: run these with `bun run candidate` (harness/run-candidate.ts)");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A fresh, empty throwaway PARACHUTE_HOME (not yet created) in a fresh throwaway user home. */
export function newHome(label = "home"): string {
  return freshHome(candidate(), label);
}

/** Run `parachute <args>` (or `parachute-vault` with `vault: true`) to completion. */
export function cli(
  home: string,
  args: string[],
  opts: { vault?: boolean; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
) {
  const c = candidate();
  return runCli(c, home, args, { bin: opts.vault ? c.vaultBin : c.bin, env: opts.env, stdin: opts.stdin, timeoutMs: opts.timeoutMs });
}

export interface Served {
  proc: ReturnType<typeof Bun.spawn>;
  log(): string;
  /** Send a signal and wait (up to `ms`) for exit; returns the exit code, or null if it didn't exit. */
  stop(signal?: NodeJS.Signals, ms?: number): Promise<number | null>;
}

/** Start a long-running candidate command (e.g. `serve --embedded`) with its output in a log file. */
export function start(
  home: string,
  args: string[],
  opts: { vault?: boolean; env?: Record<string, string> } = {},
): Served {
  const c = candidate();
  const logPath = join(dirname(home), `${args[0] ?? "run"}-${Date.now()}.log`);
  const out = Bun.file(logPath);
  const proc = Bun.spawn([opts.vault ? c.vaultBin : c.bin, ...args], {
    env: candidateEnv(c, home, opts.env),
    cwd: dirname(home),
    stdout: out,
    stderr: out,
  });
  return {
    proc,
    log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : ""),
    async stop(signal = "SIGTERM", ms = 10_000) {
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
}

/** A free loopback port outside 1939-1946 (the guard refuses those). */
export async function freePort(taken: number[] = []): Promise<number> {
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

/** Poll until `ok` or the deadline; returns whether it became true. */
export async function until(ok: () => Promise<boolean> | boolean, ms = 30_000, every = 200): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await ok()) return true;
    } catch {}
    await Bun.sleep(every);
  }
  return false;
}
