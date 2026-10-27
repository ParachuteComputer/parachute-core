// embedded/json (PLAN §3 "Tokens and versions"; Benjamin's E5/E7, as his suite and his server call them:
// prism scripts/parachute-compat/run.mjs:258,416-420, apps/server/src/mcp-token.ts:85-106, vault-provision.ts:31-39).
// A host reads machine output, never human text:
//   - `parachute version --json` → {name, version, schema, bun};
//   - `parachute auth mint-token … --json` → {token, jti, exp, scopes, aud}, matching the token's own claims;
//   - `parachute auth revoke-token <jti> --json` → {revoked: true, jti};
//   - `parachute-vault create <name> --mint --scope write --no-mirror --json` → {name, token, …}, the token signed by
//     the hub with iss = PARACHUTE_HUB_ORIGIN and scoped to that vault.
// Today there is no `version` command and mint/revoke have no --json. Lane B turns these green.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cli, freePort, newHome } from "../candidate-lib.ts";
import { red } from "../lib.ts";
import { NO_EMBEDDED, claims, embeddedHome, json, must, readNotes, tail } from "./_lib.ts";

/** A box-mode home with a first account and an operator token, made with the CLI alone (no server needed). */
async function operatorHome(env?: Record<string, string>) {
  const home = newHome("json");
  const pw = await cli(home, ["auth", "set-password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`], { env });
  must(pw.code === 0, `setup: auth set-password exited ${pw.code}: ${tail(pw.stderr)}`);
  const rot = await cli(home, ["auth", "rotate-operator"], { env });
  must(rot.code === 0, `setup: auth rotate-operator exited ${rot.code}: ${tail(rot.stderr)}`);
  return home;
}

const sortedKeys = (o: object) => Object.keys(o).sort().join(",");

describe("embedded/json", () => {
  test("setup works today: --version answers and mint-token prints a JWT for a fresh operator", async () => {
    const home = await operatorHome();
    const v = await cli(home, ["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    const m = await cli(home, ["auth", "mint-token", "--scope", "vault:default:read", "--ephemeral"]);
    expect(m.code).toBe(0);
    expect(claims(m.stdout.trim().split("\n").pop()!)?.jti).toBeString();
  });

  red("version --json prints {name, version, schema, bun}", { reason: /unknown command "version"/, lane: "B" }, async () => {
    const r = await cli(newHome("json"), ["version", "--json"]);
    must(r.code === 0, `version --json exited ${r.code}: ${tail(r.stderr)}`);
    const j = json(r.stdout);
    must(j && sortedKeys(j) === "bun,name,schema,version", `version --json keys are ${j && sortedKeys(j)}, want bun,name,schema,version`);
    must(j.name === "parachute" && /^\d+\.\d+\.\d+/.test(j.version), `version --json says ${JSON.stringify(j)}`);
    must(Number.isInteger(j.schema) && j.schema > 0, `schema is ${j.schema}, want a positive integer`);
    must(j.bun === Bun.version || /^\d+\.\d+\.\d+/.test(j.bun), `bun is ${j.bun}`);
  });

  red(
    "auth mint-token --json prints {token, jti, exp, scopes, aud}, and they match the token's claims",
    { reason: /mint-token --json exited 1: .*unknown flag "--json"/s, lane: "B" },
    async () => {
      const home = await operatorHome();
      const scope = "vault:default:write";
      const r = await cli(home, ["auth", "mint-token", "--scope", scope, "--expires-in", "3600", "--json"]);
      must(r.code === 0, `mint-token --json exited ${r.code}: ${tail(r.stderr)}`);
      const j = json(r.stdout);
      must(j && sortedKeys(j) === "aud,exp,jti,scopes,token", `mint-token --json keys are ${j && sortedKeys(j)}, want aud,exp,jti,scopes,token`);
      const c = claims(j.token);
      must(c?.jti === j.jti, `jti ${j.jti} is not the token's ${c?.jti}`);
      const scopes = Array.isArray(j.scopes) ? j.scopes : String(j.scopes).split(" ");
      must(scopes.includes(scope), `scopes ${JSON.stringify(j.scopes)} lack ${scope}`);
      must(JSON.stringify(j.aud) === JSON.stringify(c.aud), `aud ${JSON.stringify(j.aud)} is not the token's ${JSON.stringify(c.aud)}`);
      // exp: an ISO time or epoch seconds, but the token's own expiry either way.
      const exp = typeof j.exp === "number" ? j.exp : Date.parse(j.exp) / 1000;
      must(Math.abs(exp - c.exp) <= 1, `exp ${j.exp} is not the token's ${c.exp}`);
    },
  );

  red(
    "auth revoke-token <jti> --json prints {revoked: true, jti}",
    { reason: /revoke-token --json exited 1: .*unexpected flag "--json"/s, lane: "B" },
    async () => {
      const home = await operatorHome();
      const m = await cli(home, ["auth", "mint-token", "--scope", "vault:default:read", "--ephemeral"]);
      must(m.code === 0, `setup: mint-token exited ${m.code}: ${tail(m.stderr)}`);
      const jti = claims(m.stdout.trim().split("\n").pop()!)?.jti;
      const r = await cli(home, ["auth", "revoke-token", jti, "--json"]);
      must(r.code === 0, `revoke-token --json exited ${r.code}: ${tail(r.stderr)}`);
      const j = json(r.stdout);
      must(j?.revoked === true && j?.jti === jti, `revoke-token --json printed ${tail(r.stdout, 200)}, want {revoked: true, jti}`);
    },
  );

  red(
    "parachute-vault create --mint --scope write --no-mirror --json, run while serve --embedded holds the home, prints a write token the vault accepts",
    { reason: NO_EMBEDDED, lane: "B" },
    async () => {
      // Prism provisions vaults this way through PARACHUTE_VAULT_BIN while Parachute runs (vault-provision.ts:31-39).
      const home = newHome("json");
      const origin = `http://127.0.0.1:${await freePort()}`;
      const env = { PARACHUTE_HUB_ORIGIN: origin };
      const e = await embeddedHome(home, { env });
      try {
        const name = `j${randomBytes(3).toString("hex")}`;
        const r = await cli(home, ["create", name, "--mint", "--scope", "write", "--no-mirror", "--json"], { vault: true, env });
        must(r.code === 0, `parachute-vault create --json exited ${r.code}: ${tail(r.stderr)}`);
        const j = json(r.stdout);
        must(j?.name === name, `create --json name is ${j?.name}, want ${name}`);
        must(typeof j.token === "string" && j.token.split(".").length === 3, `create --mint --json printed no token (${tail(String(j.token_guidance ?? ""), 200)})`);
        const c = claims(j.token);
        must(c.iss === origin, `create --mint token iss is ${c.iss}, want ${origin}`);
        must(String(c.scope ?? c.scopes).split(" ").includes(`vault:${name}:write`), `create --mint token scope is ${c.scope}, want vault:${name}:write`);
        const got = await readNotes(e.vault, name, j.token);
        must(got.status === 200, `the new vault refused its own --mint token: HTTP ${got.status} ${got.text}`);
      } finally {
        await e.stop();
      }
    },
  );
});
