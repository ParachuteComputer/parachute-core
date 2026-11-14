// doctor --fix (T-463, 0.9.3, PR 10): `parachute doctor` names two kinds of housekeeping it can repair, and
// `parachute doctor --fix --yes` repairs them, the two commands the change map folds in:
//   - a vault whose history compaction hints are stale (`history rebuild-state` did this), finding `history-state:<vault>`;
//   - OAuth clients nothing uses, registered over 30 days ago (`auth reap-clients` did this), finding `oauth-clients`.
// `--fix` without `--yes` in a shell with no terminal prints what it would do and changes nothing. After `--fix --yes`
// a second `parachute doctor` is clean for both, and the vault's data is byte-equal except the repaired hints.
//
// Runs on the candidate (`TMPDIR=/tmp bun run candidate -- suites/lifecycle/doctor-fix.test.ts`), made-up data only.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { candidate, cli, newHome } from "../candidate-lib.ts";
import { candidateEnv } from "../../harness/candidate.ts";

const tail = (s: string) => s.trim().slice(-600);

/** A home with one vault (notes with history), a hub account, one old unused OAuth client and one new one. */
async function home(label: string) {
  const h = newHome(label);
  const name = `d${randomBytes(3).toString("hex")}`;
  const made = await cli(h, ["create", name, "--no-mirror", "--json"], { vault: true });
  expect(made.code, tail(made.stderr)).toBe(0);
  const user = await cli(h, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]);
  expect(user.code, tail(user.stderr)).toBe(0);
  const c = candidate();
  const seed = Bun.spawnSync([join(c.runtimeDir, "bun"), join(import.meta.dir, "_doctor-fix-seed.ts"), c.dir, h, name], {
    env: candidateEnv(c, h, { EMBEDDINGS_ENABLED: "false" }),
  });
  expect(seed.exitCode, tail(seed.stderr.toString())).toBe(0);
  const hints = JSON.parse(seed.stdout.toString().trim().split("\n").pop()!);
  expect(hints.length).toBe(2);
  return { h, name, hints, vaultDb: join(h, "vault", "data", name, "vault.db"), hubDb: join(h, "hub.db") };
}

/** A digest of every table of a database (read-only), except the named ones. Virtual tables and their shadows are left out. */
function digest(path: string, except: string[] = []): Record<string, string> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = (db.query("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string; sql: string }[])
      .filter((t) => !/VIRTUAL/i.test(t.sql ?? "") && !/_(fts|data|idx|content|docsize|config)\b/.test(t.name) && !except.includes(t.name));
    const out: Record<string, string> = {};
    for (const t of tables) {
      const rows = db.query(`SELECT * FROM "${t.name}"`).all().map((r) => JSON.stringify(r)).sort();
      out[t.name] = createHash("sha256").update(rows.join("\n")).digest("hex");
    }
    return out;
  } finally {
    db.close();
  }
}

function clients(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT client_name FROM clients ORDER BY client_name").all() as { client_name: string }[]).map((r) => r.client_name);
  } finally {
    db.close();
  }
}

async function doctorJson(h: string) {
  const r = await cli(h, ["doctor", "--json"], { timeoutMs: 120_000 });
  // The box isn't running, so doctor exits 1 for the hub; the report is on stdout all the same.
  const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  const by = (n: string) => report.checks.find((c: { name: string }) => c.name === n);
  return { report, by, r };
}

describe("doctor --fix repairs stale history hints and unused OAuth clients", () => {
  test("a healthy home reports both as fine and --fix has nothing to do", async () => {
    const { h, name, hubDb, vaultDb } = await home("fix-clean");
    // Clean it of the unused client first, so the home is genuinely healthy.
    const reap = await cli(h, ["auth", "reap-clients", "--apply"]);
    expect(reap.code, tail(reap.stderr)).toBe(0);
    const { by } = await doctorJson(h);
    expect(by(`history-state:${name}`)?.status, "history-state check missing or not pass").toBe("pass");
    expect(by("oauth-clients")?.status, "oauth-clients check missing or not pass").toBe("pass");
    const before = [digest(vaultDb), digest(hubDb)];
    const fix = await cli(h, ["doctor", "--fix"], { timeoutMs: 120_000 });
    expect(fix.code, tail(fix.stdout + fix.stderr)).toBe(0);
    expect([digest(vaultDb), digest(hubDb)]).toEqual(before);
  }, 240_000);

  test("stale hints and an unused client: named in the report, untouched without --yes, repaired with it, clean after", async () => {
    const { h, name, hints, vaultDb, hubDb } = await home("fix-broken");
    // Break the hints the way a missed history write does: the stored sizes are wrong and a refusal is stuck on.
    const w = new Database(vaultDb);
    w.exec("UPDATE history_compact_state SET stored = stored + 999, refused = 1");
    w.close();

    // 1. The report names both.
    const { by } = await doctorJson(h);
    expect(by(`history-state:${name}`)?.status, "no warn finding for the stale hints").toBe("warn");
    expect(by(`history-state:${name}`)?.fix).toContain("doctor --fix");
    expect(by("oauth-clients")?.status, "no warn finding for the unused client").toBe("warn");
    expect(by("oauth-clients")?.detail).toContain("1");

    // 2. --fix with no terminal and no --yes says what it would do and changes nothing.
    const brokenVault = digest(vaultDb);
    const brokenHub = digest(hubDb);
    const dry = await cli(h, ["doctor", "--fix"], { timeoutMs: 120_000 });
    const said = dry.stdout + dry.stderr;
    expect(dry.code, tail(said)).not.toBe(0);
    expect(said).toContain("--yes");
    expect(said).toContain(name);
    expect(said).toContain("Made-up old client");
    expect(digest(vaultDb)).toEqual(brokenVault);
    expect(digest(hubDb)).toEqual(brokenHub);
    expect(clients(hubDb)).toEqual(["Made-up new client", "Made-up old client"]);

    // 3. --fix --yes repairs both and nothing else.
    const fix = await cli(h, ["doctor", "--fix", "--yes"], { timeoutMs: 120_000 });
    expect(fix.code, tail(fix.stdout + fix.stderr)).toBe(0);
    const r = new Database(vaultDb, { readonly: true });
    expect(r.query("SELECT note_id, versions, stored, live FROM history_compact_state ORDER BY note_id").all()).toEqual(hints);
    expect(r.query("SELECT COUNT(*) AS n FROM history_compact_state WHERE refused = 1").get()).toEqual({ n: 0 });
    r.close();
    const afterVault = digest(vaultDb, ["history_compact_state"]);
    const { history_compact_state: _, ...brokenRest } = brokenVault;
    expect(afterVault).toEqual(brokenRest);
    expect(clients(hubDb)).toEqual(["Made-up new client"]);
    const { history_compact_state: _h, clients: _c, ...hubRest } = digest(hubDb);
    const { history_compact_state: _h2, clients: _c2, ...brokenHubRest } = brokenHub as Record<string, string>;
    expect(hubRest).toEqual(brokenHubRest);

    // 4. A second doctor is clean for both.
    const again = await doctorJson(h);
    expect(again.by(`history-state:${name}`)?.status).toBe("pass");
    expect(again.by("oauth-clients")?.status).toBe("pass");
    const second = await cli(h, ["doctor", "--fix"], { timeoutMs: 120_000 });
    expect(second.code, tail(second.stdout + second.stderr)).toBe(0);
  }, 300_000);
});
