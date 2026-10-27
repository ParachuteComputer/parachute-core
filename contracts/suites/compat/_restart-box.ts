// Driver for uni.test.ts's restart contract: start a box of the candidate in a fresh home, restart it, and report
// what changed on disk and which processes hold each vault.db. Not a test file; uni.test.ts runs it.
//
// Why a separate process: today's code puts the vault on the fixed port 1940 whatever the hub's port is
// (hub src/commands/serve-boot.ts:104-144, reconcilePortToCanonical), and the shared box the runner started
// already holds 1940 in this sandbox. So uni.test.ts runs this under `unshare --net` (a network namespace of its
// own, inside the sandbox) and reads one JSON line from stdout. It launches the box exactly as the adapter does
// (harness/candidate.ts startCandidateBox), with the adapter's own stock workarounds and none of its own.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startCandidateBox } from "../../harness/candidate.ts";
import { allowOrigins, safeFetch } from "../../harness/guard.ts";
import { candidate, start, until } from "../candidate-lib.ts";

const WATCHED = ["services.json", "vault/config.yaml", "vault/.env"];

function snapshot(home: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of WATCHED) {
    const p = join(home, f);
    out[f] = existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  }
  return out;
}

/** pid → its program (e.g. "lib/vault/src/cli.ts serve"), for every pid dbHolders saw. */
const cmdlines: Record<string, string> = {};

/** Every pid with an open fd on each vault.db under this home (WAL and SHM files counted separately). */
function dbHolders(home: string): Record<string, number[]> {
  const data = join(home, "vault", "data");
  const dbs = existsSync(data) ? readdirSync(data).map((n) => join(data, n, "vault.db")).filter((p) => existsSync(p)) : [];
  const out: Record<string, number[]> = Object.fromEntries(dbs.map((d) => [d.slice(home.length + 1), []]));
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = readlinkSync(`/proc/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      const key = link.startsWith(home + "/") ? link.slice(home.length + 1) : "";
      if (key in out && !out[key]!.includes(Number(name))) out[key]!.push(Number(name));
      if (key in out) cmdlines[name] = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).slice(1, 3).join(" ").replace(/^.*\/lib\//, "lib/");
    }
  }
  return out;
}

const report: Record<string, unknown> = {};
let user = "";
let second: ReturnType<typeof start> | null = null;
try {
  const info = candidate();
  // First boot: the adapter's own launch, in a fresh home, kept so it can be started again.
  const box = await startCandidateBox(info, { keep: true });
  const s = box.services;
  const home = s.home;
  user = dirname(home);
  report.vault = s.vaultName;
  // A live box has a vault/.env; a fresh one doesn't. Give it one (made up) so the restart has one to keep.
  writeFileSync(join(home, "vault", ".env"), "# made up for the contracts\nEMBEDDINGS_ENABLED=false\n", { mode: 0o600 });
  report.firstBoot = snapshot(home);
  report.holdersFirst = dbHolders(home);
  const r1 = await safeFetch(`${s.vaultViaHub}/api/notes`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.operatorToken}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "written before the restart", path: "restart/one" }),
  });
  report.writeBefore = r1.status;
  await box.stop(); // SIGTERM; files kept
  report.afterStop = snapshot(home);

  // Second boot: the same `serve`, the same environment the adapter gave it.
  const env: Record<string, string> = {
    PORT: new URL(s.hub).port,
    PARACHUTE_HUB_ORIGIN: s.hub,
    EMBEDDINGS_ENABLED: "false",
    PARACHUTE_BIND_HOST: "127.0.0.1",
    PARACHUTE_INITIAL_ADMIN_USERNAME: s.admin.username,
    PARACHUTE_INITIAL_ADMIN_PASSWORD: s.admin.password,
  };
  if (info.profile === "stock-0.7") env.PARACHUTE_HUB_JWKS_ORIGIN = s.hub;
  allowOrigins(s.hub);
  second = start(home, ["serve"], { env });
  const up = await until(async () => {
    const r = await safeFetch(`${s.vaultViaHub}/api/notes?path_prefix=restart&limit=5`, { headers: { authorization: `Bearer ${s.operatorToken}` } });
    if (r.status !== 200) return false;
    report.readAfter = ((await r.json()) as any[]).map((n) => n.path);
    return true;
  }, 45_000);
  report.secondUp = up;
  report.secondBoot = snapshot(home);
  report.holdersSecond = dbHolders(home);
  if (!up) report.log = second.log().slice(-2000);
} catch (err) {
  report.error = (err as Error).message.slice(0, 2000);
} finally {
  await second?.stop();
  if (user) rmSync(user, { recursive: true, force: true });
}
report.cmdlines = cmdlines;
console.log(JSON.stringify(report));
process.exit(0);
