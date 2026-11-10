// lifecycle/front-door: 0.9's one command (DESIGN-0.9 §1, §6). Black box: the candidate's own bin/parachute on
// throwaway homes, and HTTP to check what a key can do.
//   - `keys new <name>` makes a key with that name that opens its vault at the level asked and no more; `keys list`
//     names it (and `tokens list` is the same list); `keys revoke <name>` ends it.
//   - An old name still runs as it did, stdout unchanged, and says on stderr (one line, never stdout) what replaced
//     it; the use is counted in the home's run/deprecations.json, the usage log 1.0's removals wait on.
//   - Prism's contract v1 is frozen: on a host-managed (embedded) home the old names print and count nothing.
//   - A home with newer data is refused (exit 6) before an old name is counted: the home stays byte-identical.
//   - `parachute changes --json` is the change map, as data; `changes <old name>` explains one entry.
// Red on 0.8 (no keys, no changes, no notices); green from the 0.9 front door (packages/cli/src/front.ts, keys.ts).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cli, newHome } from "../candidate-lib.ts";
import { diff, embeddedHome, must, snapshot, tail } from "../embedded/_lib.ts";
import { safeFetch, services } from "../lib.ts";

const s = services();
const env = () => {
  const e = { ...(s.cliEnv ?? {}) };
  delete e.PARACHUTE_DEPRECATIONS;
  return e;
};
/** The box's own CLI, on the box's home (where the hub that verifies keys runs). */
async function box(args: string[]) {
  const p = Bun.spawn([...s.cli!, ...args], { env: env(), cwd: s.home.replace(/\/[^/]+$/, ""), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

const NOTICE = /^parachute: '([^']+)' (is now '[^']+'|is going away) \(since 0\.9, gone in [0-9.]+\): parachute changes /;
const noticeLines = (stderr: string) => stderr.split("\n").filter((l) => NOTICE.test(l));
const usage = (home: string) => {
  const p = join(home, "run", "deprecations.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).names : {};
};
const readWith = (token: string) =>
  safeFetch(`${s.vaultViaHub}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
const writeWith = (token: string) =>
  safeFetch(`${s.vaultViaHub}/api/notes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "front door", path: `front-door/${randomBytes(4).toString("hex")}` }),
  }).then((r) => r.status);

describe("lifecycle/front-door", () => {
  test("keys new makes a named key that reads its vault and can't write; keys list and tokens list name it; keys revoke ends it", async () => {
    const name = `fd-${randomBytes(3).toString("hex")}`;
    const made = await box(["keys", "new", name, "--vault", s.vaultName, "--can", "read", "--expires-in", "600"]);
    must(made.code === 0, `keys new exited ${made.code}: ${tail(made.stderr)}`);
    const token = made.stdout.trim().split("\n").pop()!.trim();
    must(token.split(".").length === 3, `keys new printed no key on its last line: ${tail(made.stdout)}`);
    expect(noticeLines(made.stderr)).toEqual([]); // the new name is not an old name

    expect(await readWith(token)).toBe(200);
    expect(await writeWith(token)).toBe(403);

    const listed = await box(["keys", "list", "--json"]);
    must(listed.code === 0, `keys list exited ${listed.code}: ${tail(listed.stderr)}`);
    const key = JSON.parse(listed.stdout).find((k: any) => k.name === name);
    must(key, `keys list doesn't name ${name}: ${tail(listed.stdout)}`);
    expect(key.levels).toEqual({ [s.vaultName]: "read" });
    expect(key.status).toBe("active");
    expect(key.owner_kind).toBe("person");
    const alias = await box(["tokens", "list", "--json"]);
    expect(JSON.parse(alias.stdout)).toEqual(JSON.parse(listed.stdout));

    const again = await box(["keys", "new", name, "--vault", s.vaultName]);
    expect(again.code).toBe(1); // a name is one key: no silent `-2`
    // Two at once with one new name: one key, and the other refused (not `<name>-2`).
    const twin = `fd-${randomBytes(3).toString("hex")}`;
    const both = await Promise.all([0, 1].map(() => box(["keys", "new", twin, "--vault", s.vaultName, "--ephemeral"])));
    expect(both.map((b) => b.code).sort()).toEqual([0, 1]);
    const named = JSON.parse((await box(["keys", "list", "--json"])).stdout).map((k: any) => k.name).filter((n: string) => n.startsWith(twin));
    expect(named).toEqual([twin]);

    const revoked = await box(["keys", "revoke", name]);
    must(revoked.code === 0, `keys revoke exited ${revoked.code}: ${tail(revoked.stderr)}`);
    // The revocation list names its token at once (the vault converges on it within 60 s; compat/prism holds that).
    const jti = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).jti;
    const list = await (await safeFetch(`${s.hub}/.well-known/parachute-revocation.json`)).json();
    expect(list.jtis).toContain(jti);
    const after = JSON.parse((await box(["keys", "list", "--all", "--json"])).stdout).find((k: any) => k.name === name);
    expect(after?.status).toBe("revoked");
    expect(JSON.parse((await box(["keys", "list", "--json"])).stdout).some((k: any) => k.name === name)).toBe(false);
  });

  test("keys new refuses what this build can't hold to: --types, --deny (0.9.1), and a level that isn't one", async () => {
    for (const extra of [["--types", "task"], ["--deny", "private"], ["--can", "owner"]]) {
      const r = await box(["keys", "new", `fd-${randomBytes(3).toString("hex")}`, "--vault", s.vaultName, ...extra]);
      expect({ extra, code: r.code, printedKey: r.stdout.includes(".") }).toEqual({ extra, code: 2, printedKey: false });
    }
  });

  test("an old name runs as before, stdout unchanged, with one notice on stderr, counted in the home's usage log", async () => {
    const before = usage(s.home)["auth mint-token"]?.count ?? 0;
    const r = await box(["auth", "mint-token", "--scope", `vault:${s.vaultName}:read`, "--ephemeral", "--label", "fd-old-name"]);
    must(r.code === 0, `auth mint-token exited ${r.code}: ${tail(r.stderr)}`);
    const token = r.stdout.trim().split("\n").pop()!.trim();
    expect(await readWith(token)).toBe(200);
    expect(r.stdout).not.toMatch(/parachute: '/);
    expect(noticeLines(r.stderr)).toEqual([
      "parachute: 'auth mint-token' is now 'keys new <name>' (since 0.9, gone in 1.0): parachute changes auth mint-token",
    ]);
    expect(usage(s.home)["auth mint-token"].count).toBe(before + 1);

    const help = await box(["auth", "mint-token", "--help"]);
    expect(noticeLines(help.stderr)).toEqual([]); // asking about an old name is not using it
  });

  test("an old name whose replacement is not built yet runs silently", async () => {
    const r = await box(["auth", "list-grants"]);
    expect(noticeLines(r.stderr)).toEqual([]);
  });

  test("Prism's contract v1: on an embedded home, old names print nothing and count nothing", async () => {
    const home = newHome("fd-embedded");
    const e = await embeddedHome(home);
    try {
      const minted = await cli(home, ["auth", "mint-token", "--scope", `vault:${e.vaultName}:write`, "--expires-in", "3600", "--json"]);
      must(minted.code === 0, `auth mint-token exited ${minted.code}: ${tail(minted.stderr)}`);
      expect(JSON.parse(minted.stdout).token.split(".").length).toBe(3);
      const users = await cli(home, ["auth", "list-users"]);
      expect(users.code).toBe(0);
      expect([...noticeLines(minted.stderr), ...noticeLines(users.stderr)]).toEqual([]);
      expect(existsSync(join(home, "run", "deprecations.json"))).toBe(false);
    } finally {
      await e.stop();
    }
  });

  test("a home with newer data is refused (exit 6) before an old name is counted: the home stays byte-identical", async () => {
    const home = newHome("fd-newer");
    const pw = await cli(home, ["user", "password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]);
    must(pw.code === 0, `user password exited ${pw.code}: ${tail(pw.stderr)}`);
    const db = new Database(join(home, "hub.db"));
    const top = (db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
    db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [top + 1, new Date().toISOString()]);
    db.close();
    const before = snapshot(home);
    const r = await cli(home, ["auth", "list-users"]);
    expect(r.code).toBe(6);
    expect((await cli(home, ["help"])).code).toBe(6); // help is behind the check too, as 0.8's was
    expect(diff(before, snapshot(home))).toEqual([]);
  });

  test("an old name on a box home: the notice, and the usage log, which `parachute changes` reports", async () => {
    const home = newHome("fd-box");
    const pw = await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`]);
    must(pw.code === 0, `auth set-password exited ${pw.code}: ${tail(pw.stderr)}`);
    expect(noticeLines(pw.stderr).map((l) => l.match(NOTICE)![1])).toEqual(["auth set-password"]);
    for (let i = 0; i < 2; i++) await cli(home, ["auth", "list-users"]);
    expect(usage(home)["auth list-users"].count).toBe(2);
    const ch = await cli(home, ["changes"]);
    expect(ch.code).toBe(0);
    expect(ch.stdout).toMatch(/auth list-users: 2, last /);
  });

  test("parachute changes --json is the change map; changes <old name> explains it; help shows the front door", async () => {
    const home = newHome("fd-changes");
    const j = await cli(home, ["changes", "--json"]);
    expect(j.code).toBe(0);
    const map = JSON.parse(j.stdout);
    expect({ schema: map.schema, from: map.from, to: map.to }).toEqual({ schema: 1, from: "0.8", to: "0.9" });
    const mint = map.changes.find((c: any) => c.old === "parachute auth mint-token");
    expect(mint).toMatchObject({ kind: "command", new: "parachute keys new <name>", action: "rename", removed_in: "1.0", state: "live" });
    for (const c of map.changes) expect(["live", "planned"]).toContain(c.state);
    const tools = JSON.parse((await cli(home, ["changes", "--json", "--kind", "mcp-tool"])).stdout).changes;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((c: any) => c.kind === "mcp-tool")).toBe(true);
    const one = await cli(home, ["changes", "auth", "mint-token"]);
    expect(one.stdout).toContain("keys new");
    expect((await cli(home, ["changes", "no-such-command"])).code).toBe(1);
    expect((await cli(home, ["changes", "--since", "0.6"])).code).toBe(2);
    expect(existsSync(home)).toBe(false); // changes reads nothing it would have to create

    const help = await cli(home, ["help"]);
    expect(help.code).toBe(0);
    for (const verb of ["status", "keys", "vault", "setup", "serve", "backup", "doctor", "user", "changes", "upgrade"]) {
      expect(help.stdout).toMatch(new RegExp(`^  ${verb}\\b`, "m"));
    }
    expect((await cli(home, ["help", "--all"])).stdout).toContain("auth");
  });
});
