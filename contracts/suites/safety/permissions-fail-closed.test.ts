// Fix 14: restrictions fail closed. A permission key nobody enforces is refused, never silently ignored.
//
// Today the CLI's own help suggests `--permissions '{"vault":{"default":{"write_tags":["health"]}}}'` (hub
// src/commands/auth.ts:260, and the error text at :1242), but nothing reads `write_tags`: the mint copies the object
// verbatim (src/api-mint-token.ts:441-452), scope-guard passes it through untouched (packages/scope-guard/src/
// validate.ts:682-688), and the vault reads only `scoped_tags` and `principal_pubkey` (vault src/auth.ts:543,570).
// So the operator gets a pass they think is limited and it is whole-vault. PLAN §5 fix 14, §7.5 mutant
// "fail-closed: unknown keys ignored". Lane F.
//
// The vault half needs a pass that carries an unknown key even after the mint refuses to issue one (passes minted
// before the fix live until they expire). The file signs one with the box's own key (suites/safety/_lib.ts resign);
// a plain test proves the vault accepts such a re-signed pass when its keys are known.
import { beforeAll, describe, expect, test } from "bun:test";
import { hubCli, mintToken } from "../../harness/services.ts";
import { must, red, rest, runId, services } from "../lib.ts";
import { claims, mintOverHttp, note, pass, resign } from "./_lib.ts";

const s = services();
const R = runId("pfc").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const ADVERTISED = { vault: { [s.vaultName]: { write_tags: [MINE] } } }; // the shape the CLI help gives
let admin: string; // an unscoped vault admin of the box's admin account: a minter
let plainRead: string;
let inScope: string;
let outOfScope: string;

beforeAll(async () => {
  admin = await mintToken(s, {
    scope: ["read", "write", "admin"].map((l) => `vault:${s.vaultName}:${l}`).join(" "),
    label: "contracts-minter",
    user: s.admin.username,
  });
  plainRead = await pass({ level: "read" });
  inScope = await note(`${R}/mine`, "in scope", [MINE]);
  outOfScope = await note(`${R}/other`, "out of scope", [OTHER]);
});

/** What a pass gets from the vault for the in-scope and the out-of-scope note. */
async function reads(token: string) {
  const api = rest(s.vaultViaHub, token);
  return { mine: (await api.get(`/notes/${inScope}`)).status, other: (await api.get(`/notes/${outOfScope}`)).status };
}

describe("the mint refuses permission keys nobody enforces (fix 14)", () => {
  test("the mint accepts the keys the vault enforces: scoped_tags over HTTP and in the CLI (positive control)", async () => {
    const r = await mintOverHttp(admin, { scope: `vault:${s.vaultName}:read`, permissions: { scoped_tags: [MINE] } });
    expect(r.status).toBe(200);
    expect(await reads(r.body.token)).toEqual({ mine: 200, other: 404 });
    expect(claims(await pass({ level: "read", tags: [MINE] })).permissions).toEqual({ scoped_tags: [MINE] });
  });

  red("the mint endpoint refuses an unknown permission key (write_tags, as the CLI help suggests)", { reason: /mint endpoint issued a pass with unknown permission keys/, lane: "F" }, async () => {
    for (const permissions of [ADVERTISED, { write_tags: [MINE] }, { scoped_tags: [MINE], write_tags: [MINE] }]) {
      const r = await mintOverHttp(admin, { scope: `vault:${s.vaultName}:read vault:${s.vaultName}:write`, permissions });
      must(r.status === 400, `the mint endpoint issued a pass with unknown permission keys ${JSON.stringify(permissions)} (status ${r.status})`);
    }
  });

  red("`parachute auth mint-token` refuses an unknown permission key", { reason: /the CLI issued a pass with unknown permission keys/, lane: "F" }, async () => {
    let out = "";
    try {
      out = await hubCli(s, ["auth", "mint-token", "--scope", `vault:${s.vaultName}:write`, "--ephemeral", "--label", "contracts-advertised", "--permissions", JSON.stringify(ADVERTISED)]);
    } catch (e) {
      // Refused, as it should be: it must say which key, so the operator learns why.
      expect((e as Error).message).toMatch(/write_tags|unknown/i);
      return;
    }
    must(false, `the CLI issued a pass with unknown permission keys (${out.trim().split(".").length === 3 ? "a JWT" : "output"} printed)`);
  });
});

describe("the vault refuses passes with permission keys it doesn't enforce (fix 14)", () => {
  test("setup works today: a re-signed pass with only known keys is accepted, and its tags are enforced", async () => {
    expect(await reads(resign(plainRead, { scoped_tags: [MINE] }))).toEqual({ mine: 200, other: 404 });
    expect(await reads(resign(plainRead, { principal_pubkey: "ab".repeat(32) }))).toEqual({ mine: 200, other: 200 });
  });

  red("the vault answers 401 to a pass whose permissions carry an unknown key", { reason: /the vault accepted a pass with unknown permission keys/, lane: "F" }, async () => {
    for (const permissions of [ADVERTISED, { write_tags: [MINE] }, { scoped_tags: [MINE], write_tags: [MINE] }]) {
      const got = await reads(resign(plainRead, permissions));
      must(got.mine === 401 && got.other === 401, `the vault accepted a pass with unknown permission keys ${JSON.stringify(permissions)}: ${JSON.stringify(got)}`);
    }
  });
});
