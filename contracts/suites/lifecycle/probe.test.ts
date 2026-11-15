// A box probe (audit L6-03): `parachute probe` checks that one vault on a running box really opens and answers,
// below the router, the way a systemd timer or a person on the tailnet would run it (docs/probe/).
//
// A hub `/health` is green while a vault can't open: the probe goes through the hub with a read-only pass for one
// vault and checks, in order, the hub's /health (step `health`), the vault's /api/health (`vault-health`), a REST
// read that opens the vault's database (`read`, or one named note with --note), and MCP initialize + tools/list
// (`mcp-initialize`, `mcp-tools-list`). It prints one line: `probe ok vault=<name> <step>=<n>ms … tools=<n>` and
// exits 0, or `probe FAIL vault=<name> step=<step>: <status or reason> (…)` and exits 1. A setup error exits 2.
// The pass comes from PARACHUTE_PROBE_TOKEN or --token-file, never an argument (arguments show in `ps`). The line
// never holds note content or the pass. It is a client: it touches no Parachute home.
//
// Runs on the box `bun run candidate` starts (inside the sandbox). The probe itself runs from a fresh, empty home.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli, freePort, newHome, safeFetch } from "../candidate-lib.ts";
import { hubCli } from "../../harness/services.ts";
import { operator, pass, runId, services } from "../lib.ts";

const s = services();
const R = runId("probe").replace(/-/g, "");
const CANARY = `${R}/canary`;
const SECRET_BODY = `made up canary body ${R} that must never be printed`;
const home = newHome("probe");

/** A file holding `token`, readable by its owner only. */
function tokenFile(token: string): string {
  const dir = mkdtempSync(join(dirname(home), "tok-"));
  const f = join(dir, "token");
  writeFileSync(f, `${token}\n`, { mode: 0o600 });
  return f;
}

async function probe(args: string[], env: Record<string, string> = {}) {
  const r = await cli(home, ["probe", ...args], { env });
  const out = r.stdout + r.stderr;
  return { ...r, out, lines: out.split("\n").filter(Boolean) };
}

/** A read-only pass for a vault, minted with the real CLI. */
async function readPass(vault: string): Promise<string> {
  const out = await hubCli(s, ["auth", "mint-token", "--scope", `vault:${vault}:read`, "--ephemeral", "--label", "contracts-probe", "--json"]);
  return JSON.parse(out.trim().split("\n").pop()!).token as string;
}

const created = await operator().post("/notes", { path: CANARY, content: SECRET_BODY, tags: [`${R}t`] });
if (created.status !== 201) throw new Error(`setup: creating the canary note gave ${created.status}`);
const token = await pass({ level: "read" });
const tokFile = tokenFile(token);
const base = ["--url", s.hub, "--vault", s.vaultName];

describe("a healthy vault", () => {
  test("every step passes: one ok line on stdout, exit 0, no note content, no pass", async () => {
    const r = await probe([...base, "--token-file", tokFile, "--note", CANARY]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(
      new RegExp(`^probe ok vault=${s.vaultName} health=\\d+ms vault-health=\\d+ms read=\\d+ms mcp-initialize=\\d+ms mcp-tools-list=\\d+ms tools=[1-9]\\d* total=\\d+ms$`),
    );
    expect(r.out).not.toContain(R);
    expect(r.out).not.toContain(token);
  });

  test("the pass and the box can come from the environment (a systemd EnvironmentFile)", async () => {
    const r = await probe([], { PARACHUTE_PROBE_TOKEN: token, PARACHUTE_PROBE_URL: s.hub, PARACHUTE_PROBE_VAULT: s.vaultName });
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toStartWith(`probe ok vault=${s.vaultName} `);
  });

  test("it touches no Parachute home", () => {
    expect(existsSync(home)).toBe(false);
  });
});

describe("a broken vault fails at a named step, exit 1", () => {
  test("the vault's database can't open: the hub's /health is green, the probe is not", async () => {
    const name = `${R}broken`;
    await hubCli(s, ["vault", "create", name, "--no-mirror", "--json"]);
    const db = join(s.home, "vault", "data", name, "vault.db");
    expect(existsSync(db)).toBe(true);
    // Made-up bytes where the database was: what a disk fault or a bad restore leaves.
    writeFileSync(db, Buffer.alloc(8192, "not a database "));
    const health = await safeFetch(`${s.hub}/health`);
    expect(health.status).toBe(200);
    const r = await probe(["--url", s.hub, "--vault", name, "--token-file", tokenFile(await readPass(name))]);
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(new RegExp(`^probe FAIL vault=${name} step=(vault-health|read): status 5\\d\\d \\(health=\\d+ms `));
  });

  test("a vault the box doesn't have", async () => {
    const r = await probe(["--url", s.hub, "--vault", `${R}missing`, "--token-file", tokFile]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(new RegExp(`^probe FAIL vault=${R}missing step=vault-health: status 404 `))]);
  });

  test("a pass for another vault", async () => {
    const other = `${R}other`;
    await hubCli(s, ["vault", "create", other, "--no-mirror", "--json"]);
    const r = await probe([...base, "--token-file", tokenFile(await readPass(other))]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(/^probe FAIL vault=\S+ step=vault-health: status 40[13] /)]);
  });

  test("a canary note that isn't there", async () => {
    const r = await probe([...base, "--token-file", tokFile, "--note", `${R}/gone`]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(/^probe FAIL vault=\S+ step=read: status 404 /)]);
  });

  test("nothing listening at the url", async () => {
    const port = await freePort();
    const r = await probe(["--url", `http://127.0.0.1:${port}`, "--vault", s.vaultName, "--token-file", tokFile, "--timeout", "3000"]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([expect.stringMatching(/^probe FAIL vault=\S+ step=health: unreachable /)]);
  });
});

describe("set up wrong: exit 2, before any request", () => {
  test("a pass on the command line is refused, and not printed", async () => {
    for (const args of [["--token", token], [`--token=${token}`]]) {
      const r = await probe([...base, ...args]);
      expect(r.code).toBe(2);
      expect(r.lines).toHaveLength(1);
      expect(r.out).toContain("ps");
      expect(r.out).not.toContain(token);
    }
  });

  test("no pass, a missing token file, no vault", async () => {
    for (const args of [base, [...base, "--token-file", join(dirname(home), "no-such-file")], ["--url", s.hub, "--token-file", tokFile]]) {
      const r = await probe(args);
      expect(r.code).toBe(2);
      expect(r.lines).toEqual([expect.stringMatching(/^parachute probe: /)]);
    }
  });
});
