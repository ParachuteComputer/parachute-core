// embedded/newer-data (PLAN §3 exit codes, §5 fix 4; Benjamin's E7; G/RISKS.md): a binary refuses a home whose
// vault.db or hub.db was written by a newer schema. It exits 6 and leaves the home byte-identical (every file's
// bytes and mode, and no file added or removed), embedded or not.
// The newer home is made with today's CLI, then the schema marker both databases use (a `schema_version` table:
// vault core/src/schema.ts:421,762, SCHEMA_VERSION 32; hub src/hub-db.ts:939-955, 24 migrations) gets one more
// row, on the throwaway copy. Before lane B nothing checked it: the vault re-stamped its own version and carried on.
// The home is always compared, whatever the exit.
// Lane B made these green: every command (packages/cli/src/dispatch.ts) reads each database's schema stamp, without
// opening it for writing, before it parses its own arguments, so the embedded cases hold before serve --embedded and
// bootstrap exist (lanes C, E), and must keep holding once they do.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { cli, freePort, newHome, start } from "../candidate-lib.ts";
import { diff, exitWithin, must, ports, snapshot, tail } from "./_lib.ts";

const VAULT = "older";

/** Add a `schema_version` row one above the highest; returns the new version. */
function raiseSchema(dbPath: string): number {
  const db = new Database(dbPath);
  const top = (db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
  db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [top + 1, new Date(Date.now() + 60_000).toISOString()]);
  db.close();
  return top + 1;
}

/** A box-mode home made by today's CLI: a first account (hub.db) and, optionally, a vault (vault.db). */
async function makeHome(withVault: boolean) {
  const home = newHome("newer");
  const pw = await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]);
  must(pw.code === 0, `setup: auth set-password exited ${pw.code}: ${tail(pw.stderr)}`);
  if (withVault) {
    const v = await cli(home, ["create", VAULT, "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } });
    must(v.code === 0, `setup: parachute-vault create exited ${v.code}: ${tail(v.stderr)}`);
  }
  return home;
}

const vaultDb = (home: string) => join(home, "vault", "data", VAULT, "vault.db");

/**
 * Run a command against the home; it must exit 6 within 20 s and change nothing under the home. The home is always
 * compared, whatever the exit, and a changed home fails first with its own message ("the home changed"), so a
 * process that both misbehaves and corrupts the home can't pass as a known exit failure.
 */
async function refuses(home: string, label: string, args: string[], opts: { vault?: boolean; env?: Record<string, string> } = {}) {
  const before = snapshot(home);
  const s = start(home, args, opts);
  const code = await exitWithin(s, 20_000);
  await s.stop("SIGKILL", 2000);
  const exit = code === null ? "still running after 20 s" : `exit ${code}`;
  const changed = diff(before, snapshot(home));
  must(changed.length === 0, `${label}: the home changed (${exit}): ${changed.slice(0, 8).join(", ")}`);
  must(code === 6, `${label}: ${exit}, want 6: ${tail(s.log(), 400)}`);
}

describe("embedded/newer-data", () => {
  test("setup works today: a home's vault.db and hub.db carry a schema_version that can be raised", async () => {
    const home = await makeHome(true);
    expect(await Bun.file(vaultDb(home)).exists()).toBe(true);
    expect(raiseSchema(vaultDb(home))).toBeGreaterThan(1);
    expect(raiseSchema(join(home, "hub.db"))).toBeGreaterThan(1);
  });

  test(
    "serve --embedded on a newer vault.db exits 6 and leaves the home byte-identical",
    async () => {
      const home = await makeHome(true);
      raiseSchema(vaultDb(home));
      const [h, v] = await ports(2);
      await refuses(home, "serve --embedded", ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    },
  );

  test(
    "bootstrap --embedded on a newer vault.db exits 6 and leaves the home byte-identical",
    async () => {
      const home = await makeHome(true);
      raiseSchema(vaultDb(home));
      await refuses(home, "bootstrap --embedded", ["bootstrap", "--embedded", "--vault", VAULT, "--json"]);
    },
  );

  test(
    "serve --embedded on a newer hub.db exits 6 and leaves the home byte-identical",
    async () => {
      const home = await makeHome(true);
      raiseSchema(join(home, "hub.db"));
      const [h, v] = await ports(2);
      await refuses(home, "serve --embedded", ["serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`]);
    },
  );

  // Before lane B the vault carried on serving the newer vault.db and wrote its WAL files.
  test(
    "box: parachute-vault serve on a newer vault.db exits 6 and leaves the home byte-identical",
    async () => {
      const home = await makeHome(true);
      raiseSchema(vaultDb(home));
      await refuses(home, "parachute-vault serve", ["serve"], { vault: true, env: { PORT: String(await freePort()), EMBEDDINGS_ENABLED: "false" } });
    },
  );

  // Before lane B the hub carried on serving the newer hub.db and wrote hub-instance.json, its WAL and well-known/.
  test(
    "box: parachute serve on a newer hub.db exits 6 and leaves the home byte-identical",
    async () => {
      const home = await makeHome(false); // no vault row, so the hub supervises nothing
      raiseSchema(join(home, "hub.db"));
      await refuses(home, "parachute serve", ["serve"], { env: { PORT: String(await freePort()), PARACHUTE_BIND_HOST: "127.0.0.1" } });
    },
  );
});
