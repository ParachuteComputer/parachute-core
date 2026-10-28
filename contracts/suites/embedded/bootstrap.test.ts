// embedded/bootstrap (PLAN §3 "Bootstrap", §3.1 R3; Benjamin's E4): a host sets Parachute up with one
// non-interactive, idempotent command, `parachute bootstrap --embedded … --json`, in both shapes Prism uses:
//   - its installer: no flags but --json, before anything runs (prism packaging/host/cli/setup.ts:411,429);
//   - its suite: --username compat --password-file <f> --vault compat, while serve --embedded runs (run.mjs:334).
// --vault defaults to `default`, --username to `owner`; a second run says created:false and changes nothing; the
// operator token goes to a 0600 file returned by path and is never printed; no git mirror is made.
// Green since lane E (packages/cli/src/bootstrap.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { cli, newHome } from "../candidate-lib.ts";
import { bootstrap, claims, diff, json, mint, must, readNotes, serveEmbedded, snapshot, tail } from "./_lib.ts";

/** The checks every successful first bootstrap must pass. */
function checkFirstRun(home: string, b: Awaited<ReturnType<typeof bootstrap>>, want: { admin: string; vault: string }) {
  must(b.code === 0, `bootstrap --embedded exited ${b.code}: ${tail(b.stderr || b.stdout)}`);
  const j = b.json;
  must(j, `bootstrap --embedded --json printed no JSON: ${tail(b.stdout)}`);
  must(j.created === true, `created is ${j.created}, want true on a fresh home`);
  must(j.vault === want.vault, `vault is ${j.vault}, want ${want.vault}`);
  must(j.admin === want.admin, `admin is ${j.admin}, want ${want.admin}`);
  const file = j.operator_token_file;
  must(typeof file === "string" && isAbsolute(file) && existsSync(file), `operator_token_file ${file} is not an absolute path to a file`);
  must(file.startsWith(home + "/"), `operator_token_file ${file} is outside the home`);
  must((statSync(file).mode & 0o777) === 0o600, `operator token file mode is ${(statSync(file).mode & 0o777).toString(8)}, want 600`);
  const token = readFileSync(file, "utf8").trim();
  must(claims(token)?.iss, "the operator token file holds no signed token");
  must(!b.stdout.includes(token) && !b.stderr.includes(token), "bootstrap printed the operator token");
  const git = [...snapshot(home).keys()].filter((p) => p === ".git" || p.endsWith("/.git"));
  must(git.length === 0, `bootstrap made a git mirror: ${git.join(", ")}`);
}

describe("embedded/bootstrap", () => {
  test("setup works today: the candidate's CLI runs in a fresh throwaway home", async () => {
    expect((await cli(newHome("boot"), ["--version"])).code).toBe(0);
  });

  test(
    "Prism's installer: bootstrap --embedded --json with no password, before serve, makes owner and vault `default`; serve then serves it",
    async () => {
      const home = newHome("boot");
      const b = await bootstrap(home);
      checkFirstRun(home, b, { admin: "owner", vault: "default" });
      const e = await serveEmbedded(home);
      try {
        const t = await mint(home, "vault:default:write");
        const got = await readNotes(e.vault, "default", t.token);
        must(got.status === 200, `vault default refused a fresh token: HTTP ${got.status} ${got.text}`);
        // Prism's server then provisions vaults with the operator token bootstrap wrote before serve chose its
        // port (prism apps/server/src/vault-provision.ts): that token must still be good to the running hub.
        const p = await cli(home, ["create", "prov", "--mint", "--scope", "write", "--no-mirror", "--json"], { vault: true });
        const pj = json(p.stdout);
        must(p.code === 0 && typeof pj?.token === "string" && pj.token.split(".").length === 3, `provisioning with the operator token from before serve minted nothing: ${tail(String(pj?.token_guidance ?? p.stderr), 300)}`);
        const prov = await readNotes(e.vault, "prov", pj.token);
        must(prov.status === 200, `the provisioned vault refused its token: HTTP ${prov.status} ${prov.text}`);
      } finally {
        await e.stop();
      }
    },
  );

  test(
    "Prism's suite: bootstrap --embedded --username --password-file --vault --json, while serve runs, makes that account and vault",
    async () => {
      const home = newHome("boot");
      const e = await serveEmbedded(home);
      try {
        const pwFile = join(home, "..", "admin-password");
        writeFileSync(pwFile, `pw-${randomBytes(12).toString("hex")}`, { mode: 0o600 });
        const b = await bootstrap(home, ["--username", "compat", "--password-file", pwFile, "--vault", "compat"]);
        checkFirstRun(home, b, { admin: "compat", vault: "compat" });
        const users = await cli(home, ["auth", "list-users"]);
        must(users.code === 0 && /compat/.test(users.stdout), `auth list-users doesn't show compat: ${tail(users.stdout || users.stderr)}`);
        const t = await mint(home, "vault:compat:write");
        const got = await readNotes(e.vault, "compat", t.token);
        must(got.status === 200, `the running vault doesn't serve the bootstrapped vault: HTTP ${got.status} ${got.text}`);
      } finally {
        await e.stop();
      }
    },
  );

  test(
    "a second bootstrap reports created:false, keeps the operator token, and changes nothing in the home",
    async () => {
      const home = newHome("boot");
      const first = await bootstrap(home);
      checkFirstRun(home, first, { admin: "owner", vault: "default" });
      const token = readFileSync(first.json.operator_token_file, "utf8");
      const before = snapshot(home);
      const again = await bootstrap(home);
      must(again.code === 0, `second bootstrap exited ${again.code}: ${tail(again.stderr || again.stdout)}`);
      must(again.json?.created === false, `second bootstrap says created:${again.json?.created}, want false`);
      must(again.json?.operator_token_file === first.json.operator_token_file, "second bootstrap names another token file");
      must(readFileSync(first.json.operator_token_file, "utf8") === token, "second bootstrap rotated the operator token");
      const changed = diff(before, snapshot(home));
      must(changed.length === 0, `second bootstrap changed the home: ${changed.slice(0, 8).join(", ")}`);
    },
  );
});
