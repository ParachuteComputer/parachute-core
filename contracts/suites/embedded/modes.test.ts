// embedded/modes (PLAN §3 "Files under the home", §5 fix 3; Benjamin's E8, prism run.mjs:520-528): every folder
// under the home is 0700 and every file 0600, the databases' -wal and -shm included, under an ordinary umask (022),
// after serve, bootstrap, vault create and a write; and modes loosened while it was stopped are repaired on open.
// Benjamin's suite checks secrets only; the plan says every file, so this checks every file.
// Before lane B the CLIs created the databases and folders with the umask's 0644/0755. Lane B made the box case green
// (umask 077 for every command, packages/cli/src/dispatch.ts) and repairs modes when serve --embedded starts; the
// embedded cases are green since lane E's bootstrap (with lane C's serve --embedded).
import { describe, expect, test } from "bun:test";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cli, newHome, safeFetch } from "../candidate-lib.ts";
import { embeddedHome, mint, modeProblems, must, serveEmbedded, snapshot, tail } from "./_lib.ts";

describe("embedded/modes", () => {
  test("setup works today: the box CLI makes a home with hub.db and a vault", async () => {
    const home = newHome("modes");
    expect((await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code).toBe(0);
    expect((await cli(home, ["create", "m1", "--no-mirror", "--json"], { vault: true })).code).toBe(0);
    expect([...snapshot(home).keys()]).toContain("hub.db");
  });

  test(
    "box: what the CLI creates (set-password, rotate-operator, vault create) is 0600 in 0700 folders",
    async () => {
      const home = newHome("modes");
      must((await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code === 0, "setup: set-password failed");
      must((await cli(home, ["auth", "rotate-operator"])).code === 0, "setup: rotate-operator failed");
      must((await cli(home, ["create", "m1", "--no-mirror", "--json"], { vault: true })).code === 0, "setup: vault create failed");
      const bad = modeProblems(home);
      must(bad.length === 0, `mode problems: ${bad.slice(0, 10).join(", ")}`);
    },
  );

  test(
    "embedded: after serve, bootstrap, vault create and a write, every folder is 0700 and every file 0600, -wal and -shm included",
    async () => {
      const home = newHome("modes");
      const e = await embeddedHome(home);
      try {
        const made = await cli(home, ["create", "m2", "--no-mirror", "--json"], { vault: true });
        must(made.code === 0, `parachute-vault create exited ${made.code}: ${tail(made.stderr)}`);
        const t = await mint(home, `vault:${e.vaultName}:write`);
        const w = await safeFetch(`${e.vault}/vault/${e.vaultName}/api/notes`, {
          method: "POST",
          headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
          body: JSON.stringify({ content: "made-up note", path: "modes/one" }),
        });
        must(w.status === 201, `a write failed: HTTP ${w.status}`);
        const files = [...snapshot(home).keys()];
        must(files.some((f) => f.endsWith(".db-wal")), `no -wal file while running: ${files.join(", ")}`);
        const bad = modeProblems(home);
        must(bad.length === 0, `mode problems while running: ${bad.slice(0, 10).join(", ")}`);
      } finally {
        await e.stop();
      }
      const bad = modeProblems(home);
      must(bad.length === 0, `mode problems after stop: ${bad.slice(0, 10).join(", ")}`);
    },
  );

  test("embedded: modes loosened while stopped are repaired on the next start", async () => {
    const home = newHome("modes");
    const first = await embeddedHome(home);
    await first.stop();
    // Loosen a database, a token file and a folder, as a careless backup restore would.
    const loosen = [...snapshot(home).values()].filter((x) => (x.kind === "file" && /(\.db|\.token)$/.test(x.rel)) || (x.kind === "dir" && x.rel === "vault"));
    must(loosen.length >= 2, `setup: nothing to loosen in ${readdirSync(home).join(", ")}`);
    for (const x of loosen) chmodSync(join(home, x.rel), x.kind === "dir" ? 0o755 : 0o644);
    const again = await serveEmbedded(home);
    try {
      const bad = modeProblems(home);
      must(bad.length === 0, `not repaired on open: ${bad.slice(0, 10).join(", ")}`);
    } finally {
      await again.stop();
    }
  });
});

