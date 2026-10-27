// A stock box (`parachute serve`, the hub supervising its vault child) for the embedded/ scripts that run in a
// network of their own (_lib.ts inOwnNetwork). Box mode, as a person's install or Prism's stock mode runs it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { candidateEnv, loadCandidate, runCli, type CandidateInfo } from "../../harness/candidate.ts";
import { allowOrigins, candidate, freePort, safeFetch, until } from "../candidate-lib.ts";
import { must, stockDir, tail } from "./_lib.ts";

/** The candidate under test, or (stock: true) the stock 0.7 build, hash-checked, for the rollback leg. */
export async function binaries(stock = false): Promise<CandidateInfo> {
  const c = candidate();
  if (!stock) return c;
  const dir = stockDir();
  const { manifest, sha256 } = await loadCandidate(dir);
  must(manifest.profile === "stock-0.7", `setup: ${dir} is not the stock 0.7 build`);
  return { ...c, dir, bin: `${dir}/bin/parachute`, vaultBin: `${dir}/bin/parachute-vault`, profile: manifest.profile, sha256 };
}

export function run(info: CandidateInfo, home: string, args: string[], env: Record<string, string> = {}, vault = false) {
  return runCli(info, home, args, { bin: vault ? info.vaultBin : info.bin, env });
}

export interface StockBox {
  hub: string;
  port: number;
  stop(): Promise<number | null>;
  log(): string;
}

/** `parachute serve` on a random port with the admin seeded from the environment; waits for the vault route. */
export async function serveBox(info: CandidateInfo, home: string, vaultName: string, env: Record<string, string> = {}): Promise<StockBox> {
  const port = Number(env.PORT ?? (await freePort()));
  const hub = `http://127.0.0.1:${port}`;
  allowOrigins(hub);
  const logPath = `${dirname(home)}/box-${Date.now()}.log`;
  const proc = Bun.spawn([info.bin, "serve"], {
    env: candidateEnv(info, home, {
      PORT: String(port),
      PARACHUTE_BIND_HOST: "127.0.0.1",
      PARACHUTE_INITIAL_ADMIN_USERNAME: "owner",
      PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${randomBytes(12).toString("hex")}`,
      EMBEDDINGS_ENABLED: "false",
      ...env,
    }),
    cwd: dirname(home),
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  const log = () => {
    try {
      return readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>");
    } catch {
      return "";
    }
  };
  const up = await until(async () => {
    const r = await safeFetch(`${hub}/vault/${vaultName}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vaultName}/`);
  }, 45_000);
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
    proc.kill("SIGTERM");
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!done) {
      proc.kill("SIGKILL");
      await proc.exited;
      return null;
    }
    return proc.exitCode;
  };
  if (!up) {
    await stop();
    must(false, `setup: stock serve did not route /vault/${vaultName}: ${tail(log(), 1500)}`);
  }
  return { hub, port, stop, log };
}
