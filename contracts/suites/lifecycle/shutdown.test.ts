// lifecycle/shutdown: how `parachute serve` stops, on a box install, for every way it can be told to.
//
// What it proves (PLAN §2.2 "one shutdown coordinator", §7.4 `lifecycle/*` row, review finding 5: "the spike left
// a WAL and an instance file behind in every run"). For each fault (SIGTERM, SIGINT, the vault's stop file, parent
// death, a SIGKILLed serve, the vault failing to start after the hub is up, an occupied vault port, ten restarts in
// a row) it checks the oracles that can fail:
//   - acknowledged writes survive: a note that got 201 is there after a restart, including writes in flight when
//     the signal came;
//   - `/api/ready` says ready only when a write goes through, and never while the vault can't start;
//   - the program exits (0 for a clean stop, non-zero for a part that failed to start) within its deadline;
//   - both ports closed and no process left from this home (child path: the vault child; in-process: nothing);
//   - `ready.json` and `hub-instance.json` gone; every database's WAL checkpointed (the `-wal` file absent or 0
//     bytes, which is `PRAGMA wal_checkpoint` with 0 frames left) and `PRAGMA integrity_check` ok, read with
//     bun:sqlite read-only from the stopped home;
//   - a stale `ready.json` from a SIGKILLed run never reads as ready.
// Lane A2 turns the red ones green (the coordinator); `--parent-pid` is lane C's flag (§3).
//
// How it runs. Each scenario is a box install in a fresh home, launched the way a person does it (`parachute-vault
// create`, then `parachute serve`; same sequence as harness/candidate.ts startCandidateBox). A box's vault listens
// on 1940 (§2.1), and the run's own box already holds 1940 in the sandbox, so each scenario gets its own network
// namespace (`unshare --net`, entered with `nsenter`) and is reached from here through a unix-socket bridge on the
// same loopback port number, so the hub's origin is identical inside and out. Nothing here calls the vault port;
// listeners and processes are read from /proc. Note text is made up.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, connect, type Server } from "node:net";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { candidateEnv } from "../../harness/candidate.ts";
import { allowOrigins, candidate, cli, freePort, newHome, safeFetch, until } from "../candidate-lib.ts";
import { must, red, rest } from "../lib.ts";

const VAULT_PORT = 1940; // a box's vault listener (PLAN §2.1)
const NSENTER = Bun.which("nsenter") ?? "/usr/bin/nsenter";
const UNSHARE = Bun.which("unshare") ?? "/usr/bin/unshare";
const SLOW = 240_000;

// ── a box in its own network namespace ─────────────────────────────────────────────────────────────────────

// Runs inside the box's namespace and keeps it alive: forwards a unix socket to the hub's loopback port.
const BRIDGE = `
const net = require("node:net");
const port = Number(process.env.LC_PORT);
net.createServer((c) => {
  const u = net.connect(port, "127.0.0.1");
  c.pipe(u); u.pipe(c);
  c.on("error", () => u.destroy()); u.on("error", () => c.destroy());
  c.on("close", () => u.destroy()); u.on("close", () => c.destroy());
}).listen(process.env.LC_SOCK);
`;

interface Serve {
  proc: ReturnType<typeof Bun.spawn>;
  exited: Promise<number>;
  log(): string;
}

class Box {
  home: string;
  user: string;
  port = 0;
  origin = "";
  vaultName = `life${randomBytes(3).toString("hex")}`;
  token = "";
  private bridgeInside: ReturnType<typeof Bun.spawn> | null = null;
  private bridgeOutside: Server | null = null;
  private extra: ReturnType<typeof Bun.spawn>[] = [];
  private logs = 0;

  constructor(label: string) {
    this.home = newHome(label);
    this.user = dirname(this.home);
  }

  async open(): Promise<void> {
    this.port = await freePort();
    this.origin = `http://127.0.0.1:${this.port}`;
    allowOrigins(this.origin);
    const sock = join(this.user, "hub.sock");
    this.bridgeInside = Bun.spawn([UNSHARE, "--net", "--", "sh", "-c", 'ip link set lo up && exec "$0" -e "$1"', process.execPath, BRIDGE], {
      env: { PATH: "/usr/bin:/bin", LC_PORT: String(this.port), LC_SOCK: sock },
      stdout: "ignore",
      stderr: "inherit",
    });
    must(await until(() => existsSync(sock), 10_000, 50), "setup: the namespace bridge did not start");
    this.bridgeOutside = createServer((c) => {
      const u = connect(sock);
      c.pipe(u);
      u.pipe(c);
      c.on("error", () => u.destroy());
      u.on("error", () => c.destroy());
      c.on("close", () => u.destroy());
      u.on("close", () => c.destroy());
    });
    await new Promise<void>((ok, bad) => this.bridgeOutside!.once("error", bad).listen(this.port, "127.0.0.1", () => ok()));
  }

  /** The command, run inside this box's network namespace. */
  private inside(cmd: string[]): string[] {
    return [NSENTER, `--net=/proc/${this.bridgeInside!.pid}/ns/net`, "--", ...cmd];
  }

  private env(extra: Record<string, string> = {}): Record<string, string> {
    return { PORT: String(this.port), PARACHUTE_HUB_ORIGIN: this.origin, EMBEDDINGS_ENABLED: "false", ...extra };
  }

  /** `parachute <args>` (or `parachute-vault` with vault: true), to completion, inside the box. */
  async run(args: string[], opts: { vault?: boolean } = {}) {
    const c = candidate();
    const p = Bun.spawn(this.inside([opts.vault ? c.vaultBin : c.bin, ...args]), {
      env: candidateEnv(c, this.home, this.env()),
      cwd: this.user,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  }

  /** `parachute-vault create`, as a person does it first. */
  async create(): Promise<void> {
    const r = await this.run(["create", this.vaultName, "--no-mirror", "--json"], { vault: true });
    must(r.code === 0, `setup: parachute-vault create failed (${r.code}): ${r.stderr.slice(-400)}`);
    if (candidate().profile === "stock-0.7") {
      // stock-0.7 workaround (fix 1, embedded/issuer): today's CLI signs with the issuer from hub/run/hub.port and
      // falls back to :1939, and `serve` doesn't write that file. A v0.8 candidate gets no such help.
      mkdirSync(join(this.home, "hub", "run"), { recursive: true });
      writeFileSync(join(this.home, "hub", "run", "hub.port"), `${this.port}\n`);
    }
  }

  /** Start `parachute serve` (optionally under a parent that passes `--parent-pid`). */
  serve(opts: { parent?: boolean } = {}): Serve {
    const c = candidate();
    const extra: Record<string, string> = {
      PARACHUTE_BIND_HOST: "127.0.0.1",
      PARACHUTE_INITIAL_ADMIN_USERNAME: "owner",
      PARACHUTE_INITIAL_ADMIN_PASSWORD: "pw-made-up-lifecycle-0001",
    };
    // stock-0.7 workaround (fix 1): the vault child fetches the hub's keys from :1939 unless told otherwise.
    if (c.profile === "stock-0.7") extra.PARACHUTE_HUB_JWKS_ORIGIN = this.origin;
    const logPath = join(this.user, `serve-${++this.logs}.log`);
    const cmd = this.inside([c.bin, "serve"]);
    const proc = opts.parent
      ? // A parent that starts serve, tells it its own pid, and waits: SIGKILL it and serve's parent is gone.
        Bun.spawn(["sh", "-c", '"$@" --parent-pid $$ >"$LC_LOG" 2>&1 & wait', "sh", ...cmd], {
          env: { ...candidateEnv(c, this.home, this.env(extra)), LC_LOG: logPath },
          cwd: this.user,
          stdout: "ignore",
          stderr: "ignore",
        })
      : Bun.spawn(cmd, { env: candidateEnv(c, this.home, this.env(extra)), cwd: this.user, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
    return {
      proc,
      exited: proc.exited,
      log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>") : ""),
    };
  }

  /** A process inside the box holding a TCP port (not a Parachute process). */
  async occupy(port: number): Promise<void> {
    const p = Bun.spawn(this.inside([process.execPath, "-e", `require("node:net").createServer((c) => c.destroy()).listen(${port}, "127.0.0.1")`]), {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "inherit",
    });
    this.extra.push(p);
    must(await until(() => this.listening().includes(port), 10_000, 50), `setup: could not occupy port ${port}`);
  }

  /** Mint a read+write pass with the real CLI (after the first start). */
  async mint(): Promise<void> {
    const rot = await this.run(["auth", "rotate-operator"]);
    must(rot.code === 0, `setup: auth rotate-operator failed (${rot.code}): ${rot.stderr.slice(-400)}`);
    const scope = ["read", "write"].map((l) => `vault:${this.vaultName}:${l}`).join(" ");
    const m = await this.run(["auth", "mint-token", "--scope", scope, "--label", "lifecycle"]);
    this.token = m.stdout.trim().split("\n").pop()!.trim();
    must(m.code === 0 && this.token.split(".").length === 3, `setup: auth mint-token failed (${m.code}): ${m.stderr.slice(-400)}`);
  }

  api() {
    return rest(`${this.origin}/vault/${this.vaultName}`, this.token);
  }

  /** TCP ports listening in this box's network namespace. */
  listening(): number[] {
    const ports = new Set<number>();
    for (const f of ["tcp", "tcp6"]) {
      let text = "";
      try {
        text = readFileSync(`/proc/${this.bridgeInside!.pid}/net/${f}`, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c[3] === "0A") ports.add(parseInt(c[1]!.split(":").pop()!, 16));
      }
    }
    return [...ports].sort((a, b) => a - b);
  }

  /** Live processes started for this home (PARACHUTE_HOME in their environment). Zombies don't count. */
  processes(): { pid: number; cmd: string }[] {
    const out: { pid: number; cmd: string }[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${name}/stat`, "utf8"))) continue;
        const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
        if (!env.includes(`PARACHUTE_HOME=${this.home}`)) continue;
        const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
        out.push({ pid: Number(name), cmd: cmd.replace(candidate().dir, "<candidate>") });
      } catch {}
    }
    return out;
  }

  async close(): Promise<void> {
    for (const p of this.processes()) process.kill(p.pid, "SIGKILL");
    for (const p of this.extra) p.kill("SIGKILL");
    this.bridgeInside?.kill("SIGKILL");
    await new Promise<void>((ok) => (this.bridgeOutside ? this.bridgeOutside.close(() => ok()) : ok()));
    rmSync(this.user, { recursive: true, force: true });
  }
}

// ── oracles ────────────────────────────────────────────────────────────────────────────────────────────────

async function isReady(box: Box): Promise<boolean> {
  try {
    const r = await safeFetch(`${box.origin}/api/ready`, { headers: { accept: "application/json" } });
    if (r.status !== 200) return false;
    const body: any = await r.json().catch(() => ({}));
    return body?.ready !== false;
  } catch {
    return false;
  }
}

let noteSeq = 0;
/** One made-up note; returns its id when the write was acknowledged (201), else null. */
async function write(box: Box): Promise<{ id: string; content: string } | null> {
  const n = ++noteSeq;
  const content = `Made-up lifecycle note ${n}: the heron counted ${n * 7} pebbles by the ${randomBytes(2).toString("hex")} pond.`;
  try {
    const r = await box.api().post("/notes", { content, path: `lifecycle/${box.vaultName}/n${n}` });
    return r.status === 201 && typeof r.body?.id === "string" ? { id: r.body.id, content } : null;
  } catch {
    return null;
  }
}

/**
 * Wait until serve is usable: a write gets 201. Each round asks `/api/ready` first and then writes at once, so
 * "ready, but the write right after was refused" is caught (an early-ready problem). A write while not ready is
 * allowed, and is how usable is found without waiting on the ready probe.
 */
const earlyReady: string[] = []; // every start in this file adds to it; one test reads it at the end
let watchedStarts = 0;
async function untilUsable(box: Box, s: Serve, ms = 45_000): Promise<{ id: string; content: string }> {
  const deadline = Date.now() + ms;
  watchedStarts++;
  while (Date.now() < deadline) {
    if (s.proc.exitCode !== null || s.proc.signalCode !== null) {
      throw new Error(`setup: serve exited (${s.proc.exitCode ?? s.proc.signalCode}) before it was usable: ${s.log().slice(-1500)}`);
    }
    const ready = await isReady(box);
    const w = await write(box);
    if (w) return w;
    if (ready) earlyReady.push(`${box.vaultName}: /api/ready said ready but a write right after was refused`);
    await Bun.sleep(100);
  }
  throw new Error(`setup: serve not usable after ${ms / 1000} s: ${s.log().slice(-1500)}`);
}

/** First start of a fresh box: wait for the hub, then mint a pass with the CLI. */
async function firstStart(box: Box, opts: { parent?: boolean } = {}): Promise<Serve> {
  const s = box.serve(opts);
  const up = await until(async () => {
    if (s.proc.exitCode !== null) return true;
    const r = await safeFetch(`${box.origin}/vault/${box.vaultName}/mcp`);
    return r.status === 401;
  }, 45_000);
  if (opts.parent) {
    await Bun.sleep(300); // the parent's child (serve) exits at once on an unknown flag
    const left = box.processes().find((p) => / serve\b/.test(p.cmd));
    must(left, `serve --parent-pid did not start: ${s.log().trim().split("\n").slice(-3).join(" | ")}`);
  } else must(up && s.proc.exitCode === null, `setup: serve did not come up: ${s.log().slice(-1500)}`);
  await box.mint();
  return s;
}

/** How serve ended: its exit code, the signal that killed it (it had no handler), or null if still running. */
type Exit = number | NodeJS.Signals | null;

/** Wait up to `ms` for serve to end. */
async function exitWithin(s: Serve, ms: number): Promise<Exit> {
  const done = await Promise.race([s.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  return done ? (s.proc.exitCode ?? s.proc.signalCode ?? "SIGKILL") : null;
}

/** A clean stop exits 0 by itself; dying of the signal means nothing ran (no coordinator, no handler yet). */
function exitProblem(exit: Exit): string | null {
  if (exit === null || exit === 0) return null;
  return typeof exit === "string" ? `serve died of ${exit} instead of stopping` : `exit code ${exit}, not 0`;
}

/** Every file under `dir` whose name passes `want`. */
function files(dir: string, want: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && want(name)) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** What a stopped box leaves running: listeners in its namespace and processes from its home. */
async function leftRunning(box: Box, opts: { allowListen?: number[] } = {}): Promise<string[]> {
  const allow = new Set(opts.allowListen ?? []);
  const look = () => [
    ...box.listening().filter((p) => !allow.has(p)).map((p) => `still listening: 127.0.0.1:${p}${p === box.port ? " (hub)" : p === VAULT_PORT ? " (vault)" : ""}`),
    ...box.processes().map((p) => `process left: pid ${p.pid} ${p.cmd}`),
  ];
  await until(() => look().length === 0, 1_500, 100); // children get a moment to be reaped
  return look();
}

/** What a stopped box leaves on disk: instance files, un-checkpointed WALs, damaged databases. */
function leftOnDisk(box: Box, opts: { skipDbs?: string[] } = {}): string[] {
  const out: string[] = [];
  for (const f of files(box.home, (n) => n === "ready.json" || n === "hub-instance.json")) out.push(`left behind: ${relative(box.home, f)}`);
  for (const db of files(box.home, (n) => n.endsWith(".db"))) {
    if (opts.skipDbs?.includes(db)) continue;
    const wal = `${db}-wal`;
    const size = existsSync(wal) ? statSync(wal).size : 0;
    if (size > 0) out.push(`WAL left: ${relative(box.home, wal)} ${size} bytes`);
    try {
      const d = new Database(db, { readonly: true });
      const rows = d.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
      d.close();
      const verdict = rows.map((r) => r.integrity_check).join(", ");
      if (verdict !== "ok") out.push(`integrity_check on ${relative(box.home, db)}: ${verdict.slice(0, 200)}`);
    } catch (e) {
      out.push(`could not open ${relative(box.home, db)} read-only: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Start again on the same home and read every acknowledged note; returns what's missing or changed. */
async function readBack(box: Box, acked: { id: string; content: string }[]): Promise<string[]> {
  const s = box.serve();
  try {
    await untilUsable(box, s);
    const lost: string[] = [];
    for (const n of acked) {
      const r = await box.api().get(`/notes/${n.id}`);
      if (r.status !== 200 || r.body?.content !== n.content) lost.push(`${n.id} (${r.status})`);
    }
    return lost;
  } finally {
    s.proc.kill("SIGTERM");
    if ((await exitWithin(s, 10_000)) === null) s.proc.kill("SIGKILL");
  }
}

// ── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────

interface Outcome {
  exit: Exit;
  acked: number;
  lost: string[]; // acknowledged notes missing after a restart
  running: string[]; // listeners and processes left after the stop
  disk: string[]; // files and databases left after the stop
}

/** Run a scenario once, however many tests read its outcome. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

/**
 * A box takes writes, then is stopped by `fault` while a burst of writes is in flight. Records how it stopped and
 * what it left, then restarts it and reads every acknowledged note back.
 */
function stopScenario(label: string, fault: (box: Box, s: Serve) => Promise<void>, opts: { parent?: boolean; deadline?: number } = {}) {
  return once(async (): Promise<Outcome> => {
    const box = new Box(label);
    try {
      await box.open();
      await box.create();
      const s = await firstStart(box, opts);
      const acked = [await untilUsable(box, s)];
      for (let i = 0; i < 5; i++) acked.push((await write(box))!);
      must(acked.every(Boolean), "setup: a write before the fault was refused");
      // In flight when the fault comes: whichever of these get 201 must survive too.
      const burst = Array.from({ length: 20 }, () => write(box));
      await Bun.sleep(5);
      await fault(box, s);
      for (const w of await Promise.all(burst)) if (w) acked.push(w);
      // Under a parent, `s` is the parent (now dead): serve's exit is seen as its processes going away.
      const exit = opts.parent
        ? (await until(() => box.processes().length === 0, opts.deadline ?? 10_000, 100)) ? 0 : null
        : await exitWithin(s, opts.deadline ?? 10_000);
      const running = exit === null ? [`serve still running ${(opts.deadline ?? 10_000) / 1000} s after ${label}`] : await leftRunning(box);
      const disk = exit === null ? [] : leftOnDisk(box);
      for (const p of box.processes()) process.kill(p.pid, "SIGKILL"); // whatever is left, so the restart is fair
      await until(() => box.processes().length === 0 && !box.listening().length, 5_000, 100);
      const lost = await readBack(box, acked);
      console.log(`[lifecycle] ${label}: exit ${exit}, ${acked.length} writes acknowledged (${acked.length - 6} of 20 in flight), ${lost.length} lost, ${running.length + disk.length} problems`);
      return { exit, acked: acked.length, lost, running, disk };
    } finally {
      await box.close();
    }
  });
}

/** Assert a clean stop: exit 0, nothing left running. */
function stoppedAndGone(o: Outcome) {
  const problems = [...o.running];
  const bad = exitProblem(o.exit);
  if (bad) problems.unshift(bad);
  must(problems.length === 0, problems.join("; "));
}

function cleanOnDisk(o: Outcome) {
  must(o.exit !== null, `serve did not stop, so its home was never left: ${o.running.join("; ")}`);
  must(o.disk.length === 0, o.disk.join("; "));
}

function nothingLost(o: Outcome) {
  must(o.acked >= 6, `setup: only ${o.acked} writes acknowledged`);
  must(o.lost.length === 0, `acknowledged writes lost: ${o.lost.join(", ")}`);
}

// ── the contracts ──────────────────────────────────────────────────────────────────────────────────────────

const setup = once(async () => {
  const box = new Box("life-setup");
  try {
    await box.open();
    await box.create();
    const s = await firstStart(box);
    const first = await untilUsable(box, s);
    const usableAt = Date.now();
    const got = await box.api().get(`/notes/${first.id}`);
    // What the stop oracles look at, seen while it runs: they must see something to see it go.
    const listening = box.listening();
    const procs = box.processes().length;
    // How long after the first write went through does /api/ready say so (§3: ready once usable)?
    const readyAfter = (await until(() => isReady(box), 40_000, 100)) ? Date.now() - usableAt : null;
    s.proc.kill("SIGTERM");
    const exit = await exitWithin(s, 10_000);
    return { got, first, exit, listening, procs, readyAfter, port: box.port };
  } finally {
    await box.close();
  }
});

describe("lifecycle: shutdown", () => {
  test("setup works today: a box in its own namespace starts, takes a write through the hub, and stops", async () => {
    const r = await setup();
    expect(r.got.status).toBe(200);
    expect(r.got.body.content).toBe(r.first.content);
    expect(r.exit).not.toBeNull();
    // The oracles can see what they check: both ports in the box's namespace, and the home's processes.
    expect(r.listening).toContain(r.port);
    expect(r.listening).toContain(VAULT_PORT);
    expect(r.procs).toBeGreaterThan(0);
  }, SLOW);

  // Today the hub reports a supervised module "transient" for a 30 s boot window after it starts (hub
  // src/proxy-state.ts:52, src/api-ready.ts), so a usable box says not-ready for 30 s. A host polling /api/ready
  // (Prism's installer, §3) waits on that.
  red(
    "/api/ready says ready within 5 s of the first write going through",
    { reason: /\/api\/ready said ready only (\d{2,}|[6-9]) s after a write went through/, lane: "C" },
    async () => {
      const r = await setup();
      must(r.readyAfter !== null, "/api/ready never said ready within 40 s of a write going through");
      const sec = Math.round(r.readyAfter / 1000);
      must(r.readyAfter <= 5_000, `/api/ready said ready only ${sec} s after a write went through`);
    },
    SLOW,
  );

  // SIGTERM and SIGINT: the coordinator's steps, in order, then exit 0 within 10 s (§2.2, §3).
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const run = stopScenario(sig, async (_box, s) => void s.proc.kill(sig));

    test(`${sig}: acknowledged writes survive, including ones in flight when it came`, async () => nothingLost(await run()), SLOW);

    test(`${sig}: serve exits 0 within 10 s, both ports closed, no process left`, async () => stoppedAndGone(await run()), SLOW);

    // Green today for a steady-state stop; the same oracles fail for a stop during start-up (below).
    test(
      `${sig}: the home is left clean: every WAL checkpointed, integrity ok, no ready.json or hub-instance.json`,
      async () => cleanOnDisk(await run()),
      SLOW,
    );
  }

  // The stop file (vault src/server.ts:740-758): `parachute-vault stop` writes vault/stop.signal; the server polls
  // for it. In one program it is one more way into the same coordinator, so the whole serve stops.
  const stopFile = stopScenario(
    "the stop file",
    async (box) => {
      const r = await box.run(["stop"], { vault: true });
      must(r.code === 0 || /did not stop/.test(r.stderr), `parachute-vault stop failed (${r.code}): ${r.stderr.slice(-300)}`);
    },
    { deadline: 15_000 },
  );

  test("the stop file: acknowledged writes survive", async () => nothingLost(await stopFile()), SLOW);

  red(
    "the stop file: the whole serve stops (exit 0 within 15 s), both ports closed, no process left",
    { reason: /serve still running 15 s after the stop file/, lane: "A2" },
    async () => stoppedAndGone(await stopFile()),
    SLOW,
  );

  red(
    "the stop file: the home is left clean",
    { reason: /serve did not stop, so its home was never left/, lane: "A2" },
    async () => cleanOnDisk(await stopFile()),
    SLOW,
  );

  // Parent death: `--parent-pid` (§3) names the process serve lives for. A box under systemd or `nohup` passes
  // none, and must not die with its shell; with it, a SIGKILLed parent is a stop like SIGTERM.
  red(
    "parent death: serve --parent-pid stops cleanly within 10 s of its parent's SIGKILL",
    { reason: /serve --parent-pid did not start: .*unexpected argument "--parent-pid"/, lane: "C" },
    async () => {
      const o = await stopScenario("its parent died", async (_box, s) => void s.proc.kill("SIGKILL"), { parent: true })();
      stoppedAndGone(o);
      cleanOnDisk(o);
      nothingLost(o);
    },
    SLOW,
  );

  // SIGKILL: nothing can run, so the oracles are what's left and what the next start makes of it.
  const killed = once(async () => {
    const box = new Box("life-kill");
    try {
      await box.open();
      await box.create();
      const s = await firstStart(box);
      const acked = [await untilUsable(box, s)];
      for (let i = 0; i < 5; i++) acked.push((await write(box))!);
      const pid = s.proc.pid;
      s.proc.kill("SIGKILL");
      await s.exited;
      // A child whose parent was SIGKILLed is a parent death too: it must notice and go.
      await until(() => box.processes().length === 0, 5_000, 100);
      const orphans = box.processes().map((p) => `process left 5 s after serve was SIGKILLed: pid ${p.pid} ${p.cmd}`);
      for (const p of box.processes()) process.kill(p.pid, "SIGKILL");
      await until(() => box.processes().length === 0 && !box.listening().length, 5_000, 100);

      // The run's ready.json, if it wrote one, must name the dead pid so a reader can tell. If it wrote none, plant
      // one where v0.8 writes it (run/ready.json, §3), as a killed v0.8 run would leave it.
      let stale = files(box.home, (n) => n === "ready.json");
      const staleProblems: string[] = [];
      for (const f of stale) {
        let j: any = {};
        try {
          j = JSON.parse(readFileSync(f, "utf8"));
        } catch {}
        if (j.pid !== undefined && j.pid !== pid) staleProblems.push(`${relative(box.home, f)} names pid ${j.pid}, not the killed serve ${pid}`);
      }
      if (!stale.length) {
        const f = join(box.home, "run", "ready.json");
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ ready: true, pid, hub_listen: `127.0.0.1:${box.port}`, vault_listen: `127.0.0.1:${VAULT_PORT}`, issuer: box.origin }) + "\n");
        stale = [f];
      }
      const staleBytes = new Map(stale.map((f) => [f, readFileSync(f, "utf8")]));
      const stillStale = (f: string) => `stale ${relative(box.home, f)} still there after the restart's hub answered`;
      const saysReady = (text: string) => {
        try {
          return JSON.parse(text).ready !== false;
        } catch {
          return false; // half-written: not a claim of anything
        }
      };

      // Start again. Once the hub answers, no stale ready.json may still be there; and until /api/ready says
      // ready, no ready.json may say ready for the new serve.
      const s2 = box.serve();
      const seen = new Set<string>();
      let hubUp = false;
      let usable = false;
      const watch = (async () => {
        while (s2.proc.exitCode === null && !usable) {
          for (const f of files(box.home, (n) => n === "ready.json")) {
            let text = "";
            try {
              text = readFileSync(f, "utf8");
            } catch {
              continue; // removed between the listing and the read
            }
            if (hubUp && staleBytes.get(f) === text) seen.add(stillStale(f));
            else if (staleBytes.get(f) !== text && saysReady(text) && !(await isReady(box))) {
              seen.add(`${relative(box.home, f)} said ready before /api/ready did`);
            }
          }
          try {
            hubUp ||= (await safeFetch(`${box.origin}/health`)).ok;
          } catch {}
          await Bun.sleep(25);
        }
      })();
      await untilUsable(box, s2).finally(() => (usable = true));
      await watch;
      for (const [f, bytes] of staleBytes) if (existsSync(f) && readFileSync(f, "utf8") === bytes) seen.add(stillStale(f));
      const lost: string[] = [];
      for (const n of acked) {
        const r = await box.api().get(`/notes/${n.id}`);
        if (r.status !== 200 || r.body?.content !== n.content) lost.push(n.id);
      }
      const instance = join(box.home, "hub-instance.json");
      const instanceNow = existsSync(instance) ? JSON.parse(readFileSync(instance, "utf8")) : null;
      s2.proc.kill("SIGTERM");
      await exitWithin(s2, 10_000);
      return { orphans, staleProblems, seen: [...seen], lost, instanceNow, oldPid: pid };
    } finally {
      await box.close();
    }
  });

  test("SIGKILL: acknowledged writes survive a SIGKILLed serve", async () => {
    const o = await killed();
    must(o.lost.length === 0, `acknowledged writes lost: ${o.lost.join(", ")}`);
  }, SLOW);

  red(
    "SIGKILL: a SIGKILLed serve leaves no process behind (its vault notices its parent died)",
    { reason: /process left 5 s after serve was SIGKILLed: pid \d+ .*vault.*serve/, lane: "A2" },
    async () => {
      const o = await killed();
      must(o.orphans.length === 0, o.orphans.join("; "));
    },
    SLOW,
  );

  red(
    "SIGKILL: a stale ready.json from the killed run never reads as ready",
    { reason: /stale run\/ready\.json still there after the restart's hub answered/, lane: "A2" },
    async () => {
      const o = await killed();
      const problems = [...o.staleProblems, ...o.seen];
      must(problems.length === 0, problems.join("; "));
    },
    SLOW,
  );

  test("SIGKILL: after a restart, hub-instance.json (if any) names the new serve, not the killed one", async () => {
    const o = await killed();
    if (o.instanceNow) expect(o.instanceNow.pid).not.toBe(o.oldPid);
  }, SLOW);

  // A part that fails to start: the vault can't open its database, or can't bind its port, after the hub is up.
  // `/api/ready` must never say ready, and the program stops itself, non-zero (§3: 75), and clean (§2.2).
  function startFailure(label: string, breakIt: (box: Box) => Promise<{ skipDbs?: string[]; allowListen?: number[] }>) {
    return once(async () => {
      const box = new Box(label);
      try {
        await box.open();
        await box.create();
        const opts = await breakIt(box);
        const s = box.serve();
        const readyWhileBroken: string[] = [];
        const window = Date.now() + 20_000;
        while (Date.now() < window && s.proc.exitCode === null) {
          if (await isReady(box)) {
            readyWhileBroken.push(`/api/ready said ready while ${label}`);
            break;
          }
          await Bun.sleep(100);
        }
        const exit = await exitWithin(s, Math.max(0, window - Date.now()));
        const problems: string[] = [];
        if (exit === null) problems.push(`serve still running 20 s after ${label}`);
        else {
          if (exit === 0) problems.push(`serve exited 0 after ${label}`);
          if (typeof exit === "string") problems.push(`serve died of ${exit} after ${label}`);
          problems.push(...(await leftRunning(box, opts)), ...leftOnDisk(box, opts));
        }
        s.proc.kill("SIGKILL");
        return { readyWhileBroken, problems, occupierAlive: box.listening().includes(VAULT_PORT) };
      } finally {
        await box.close();
      }
    });
  }

  const brokenDb = startFailure("the vault failed to start", async (box) => {
    const db = join(box.home, "vault", "data", box.vaultName, "vault.db");
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, "Made-up bytes that are not a database: the heron's pebble ledger, page one.\n".repeat(200));
    return { skipDbs: [db] };
  });

  test("vault start failure: /api/ready never says ready", async () => {
    const o = await brokenDb();
    expect(o.readyWhileBroken).toEqual([]);
  }, SLOW);

  red(
    "vault start failure: serve stops itself, non-zero, cleanly",
    { reason: /serve still running 20 s after the vault failed to start/, lane: "A2" },
    async () => {
      const o = await brokenDb();
      must(o.problems.length === 0, o.problems.join("; "));
    },
    SLOW,
  );

  const occupied = startFailure("the vault port was taken", async (box) => {
    await box.occupy(VAULT_PORT);
    return { allowListen: [VAULT_PORT] };
  });

  test("occupied vault port: /api/ready never says ready, and the port's holder is left alone", async () => {
    const o = await occupied();
    expect(o.readyWhileBroken).toEqual([]);
    must(o.occupierAlive, "the process holding the vault port was killed");
  }, SLOW);

  red(
    "occupied vault port: serve stops itself, non-zero, cleanly",
    { reason: /serve still running 20 s after the vault port was taken/, lane: "A2" },
    async () => {
      const o = await occupied();
      must(o.problems.length === 0, o.problems.join("; "));
    },
    SLOW,
  );

  // A stop can come at any moment, including in the middle of start-up (systemd restarting a unit, a person
  // pressing Ctrl-C). Here it comes the moment the vault's port opens. Today `parachute serve` installs its
  // signal handlers only after start-up finishes (hub src/cli.ts:1016-1024, after `await mod.serve()`, which awaits
  // the module boot), so the signal kills the hub outright and its vault child is left running.
  const duringStartup = once(async () => {
    const box = new Box("life-early");
    try {
      await box.open();
      await box.create();
      const s1 = await firstStart(box);
      const acked = [await untilUsable(box, s1)];
      s1.proc.kill("SIGTERM");
      if ((await exitWithin(s1, 10_000)) === null) s1.proc.kill("SIGKILL");
      for (const p of box.processes()) process.kill(p.pid, "SIGKILL");
      await until(() => box.processes().length === 0 && !box.listening().length, 5_000, 100);

      const s = box.serve();
      const opened = await until(() => box.listening().includes(VAULT_PORT) || s.proc.exitCode !== null, 45_000, 10);
      must(opened && s.proc.exitCode === null, `setup: the vault port never opened on restart: ${s.log().slice(-800)}`);
      s.proc.kill("SIGTERM");
      const exit = await exitWithin(s, 10_000);
      const problems: string[] = [];
      if (exit === null) problems.push("serve still running 10 s after SIGTERM during start-up");
      else {
        const bad = exitProblem(exit);
        if (bad) problems.push(bad);
        problems.push(...(await leftRunning(box)), ...leftOnDisk(box));
      }
      for (const p of box.processes()) process.kill(p.pid, "SIGKILL");
      if (exit === null) s.proc.kill("SIGKILL");
      await until(() => box.processes().length === 0 && !box.listening().length, 5_000, 100);
      const lost = await readBack(box, acked);
      return { problems, lost };
    } finally {
      await box.close();
    }
  });

  test("SIGTERM during start-up: acknowledged writes from before survive", async () => {
    const o = await duringStartup();
    must(o.lost.length === 0, `acknowledged writes lost: ${o.lost.join(", ")}`);
  }, SLOW);

  red(
    "SIGTERM during start-up: serve still stops cleanly (exit 0, nothing left, home clean)",
    { reason: /serve died of SIGTERM instead of stopping.*process left: pid \d+ .*vault.*serve/, lane: "A2" },
    async () => {
      const o = await duringStartup();
      must(o.problems.length === 0, o.problems.join("; "));
    },
    SLOW,
  );

  // Ten restarts in a row, one acknowledged write each, SIGTERM each time.
  const restarts = once(async () => {
    const box = new Box("life-ten");
    try {
      await box.open();
      await box.create();
      const acked: { id: string; content: string }[] = [];
      const unclean: string[] = [];
      const t0 = Date.now();
      for (let i = 1; i <= 10; i++) {
        const s = i === 1 ? await firstStart(box) : box.serve();
        acked.push(await untilUsable(box, s));
        // A moment to settle: a stop in the middle of start-up is its own contract (below).
        await Bun.sleep(1_000);
        s.proc.kill("SIGTERM");
        const exit = await exitWithin(s, 10_000);
        if (exit === null) {
          unclean.push(`restart ${i}: serve still running 10 s after SIGTERM`);
          s.proc.kill("SIGKILL");
          await s.exited;
        } else if (exitProblem(exit)) unclean.push(`restart ${i}: ${exitProblem(exit)}`);
        for (const p of await leftRunning(box)) unclean.push(`restart ${i}: ${p}`);
        for (const p of leftOnDisk(box)) unclean.push(`restart ${i}: ${p}`);
        for (const p of box.processes()) process.kill(p.pid, "SIGKILL");
      }
      const seconds = Math.round((Date.now() - t0) / 1000);
      const lost = await readBack(box, acked);
      console.log(`[lifecycle] ten restarts: ${seconds} s, ${acked.length} writes acknowledged, ${lost.length} lost, ${unclean.length} problems`);
      return { acked, unclean, lost, seconds };
    } finally {
      await box.close();
    }
  });

  test("ten restarts in a row: every start is usable, no acknowledged write is lost", async () => {
    const o = await restarts();
    expect(o.acked.length).toBe(10);
    must(o.lost.length === 0, `acknowledged writes lost: ${o.lost.join(", ")}`);
    expect(o.seconds).toBeLessThan(120);
  }, SLOW);

  test("ten restarts in a row: every stop is clean (exit 0, nothing left, home clean)", async () => {
    const o = await restarts();
    must(o.unclean.length === 0, o.unclean.join("; "));
  }, SLOW);

  // Watched on every start in this file, so it runs last. Restarts are where it bites: they are watched from the
  // first instant (a first start waits for the CLI's mint before writing).
  test("/api/ready says ready only once a write goes through (every start in this file)", async () => {
    await restarts();
    must(watchedStarts >= 10, `setup: only ${watchedStarts} starts watched`);
    expect(earlyReady).toEqual([]);
  }, SLOW);
});
