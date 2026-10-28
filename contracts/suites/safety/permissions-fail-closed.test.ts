// Fix 14: restrictions fail closed. A permission key nobody enforces is refused, never silently ignored.
//
// Before the fix (hub 53d327b, vault 42fbf93) the CLI's own help suggested
// `--permissions '{"vault":{"default":{"write_tags":["health"]}}}'` (hub src/commands/auth.ts:260, and the error text
// at :1242), but nothing read `write_tags`: the mint copied the object verbatim (src/api-mint-token.ts:441-452),
// scope-guard passes it through untouched (packages/scope-guard/src/validate.ts:682-688), and the vault reads only
// `scoped_tags` and `principal_pubkey` (vault src/auth.ts:543,570). So the operator got a pass they thought limited
// and it was whole-vault. Fixed by lane F in packages/hub (src/api-mint-token.ts, src/permissions-claim.ts, src/commands/auth.ts) (both mint
// doors) and packages/vault (src/auth.ts) (the vault); mutants "mint-unknown-keys-ignored",
// "cli-unknown-keys-ignored" and "vault-unknown-keys-ignored" put each back. PLAN §5 fix 14, §7.5.
//
// The vault half needs a pass that carries an unknown key even after the mint refuses to issue one (passes minted
// before the fix live until they expire). The file signs one with the box's own key (suites/safety/_lib.ts resign);
// a plain test proves the vault accepts such a re-signed pass when its keys are known.
import { beforeAll, describe, expect, test } from "bun:test";
import { hubCli, mintToken } from "../../harness/services.ts";
import { must, rest, runId, services } from "../lib.ts";
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

/** Whether the vault served the in-scope note to this pass: 200 and the note's own content, not just a status. */
async function served(token: string): Promise<boolean> {
  const r = await rest(s.vaultViaHub, token).get(`/notes/${inScope}`);
  return r.status === 200 && r.body?.content === "in scope";
}

/** Whether a pass's claims carry the unknown key `write_tags` anywhere in its permissions. */
const carriesWriteTags = (token: string) => JSON.stringify(claims(token).permissions ?? null).includes('"write_tags"');

// Each test below passes only on a refusal. The bug (a usable pass carrying the unknown key was issued, or the vault
// served a note to such a pass) and anything else (a 5xx, a crash, an answer that is neither) fail with different
// reasons, so a failure says which.

describe("the mint refuses permission keys nobody enforces (fix 14)", () => {
  test("the mint accepts the keys the vault enforces: scoped_tags over HTTP and in the CLI (positive control)", async () => {
    const r = await mintOverHttp(admin, { scope: `vault:${s.vaultName}:read`, permissions: { scoped_tags: [MINE] } });
    expect(r.status).toBe(200);
    expect(await reads(r.body.token)).toEqual({ mine: 200, other: 404 });
    expect(claims(await pass({ level: "read", tags: [MINE] })).permissions).toEqual({ scoped_tags: [MINE] });
  });

  test("the mint endpoint refuses an unknown permission key (write_tags, as the CLI help suggests)", async () => {
    for (const permissions of [ADVERTISED, { write_tags: [MINE] }, { scoped_tags: [MINE], write_tags: [MINE] }]) {
      const r = await mintOverHttp(admin, { scope: `vault:${s.vaultName}:read vault:${s.vaultName}:write`, permissions });
      if (r.status === 400) continue; // refused, as it should be
      const token = r.body?.token;
      const issued = r.status >= 200 && r.status < 300 && typeof token === "string" && token.split(".").length === 3;
      must(issued, `unexpected mint answer for ${JSON.stringify(permissions)}: status ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      must(carriesWriteTags(token) && (await served(token)), `unexpected mint answer for ${JSON.stringify(permissions)}: a pass whose claims are ${JSON.stringify(claims(token).permissions)}, or which the vault doesn't serve`);
      must(false, `the mint endpoint issued a pass with unknown permission keys ${JSON.stringify(permissions)} (status ${r.status}; its claims carry them and the vault accepts it)`);
    }
  });

  test("`parachute auth mint-token` refuses an unknown permission key", async () => {
    let out = "";
    try {
      out = await hubCli(s, ["auth", "mint-token", "--scope", `vault:${s.vaultName}:write`, "--ephemeral", "--label", "contracts-advertised", "--permissions", JSON.stringify(ADVERTISED)]);
    } catch (e) {
      // Refused, as it should be: it must say which key, so the operator learns why.
      expect((e as Error).message).toMatch(/write_tags|unknown/i);
      return;
    }
    const token = out.trim().split("\n").pop()!.trim();
    must(token.split(".").length === 3, `unexpected CLI output: exit 0 but no pass printed: ${out.slice(-300)}`);
    must(carriesWriteTags(token) && (await served(token)), `unexpected CLI output: a pass whose claims are ${JSON.stringify(claims(token).permissions)}`);
    must(false, `the CLI issued a pass with unknown permission keys (its claims carry them and the vault accepts it)`);
  });
});

describe("the vault refuses passes with permission keys it doesn't enforce (fix 14)", () => {
  test("setup works today: a re-signed pass with only known keys is accepted, and its tags are enforced", async () => {
    expect(await reads(resign(plainRead, { scoped_tags: [MINE] }))).toEqual({ mine: 200, other: 404 });
    expect(await reads(resign(plainRead, { principal_pubkey: "ab".repeat(32) }))).toEqual({ mine: 200, other: 200 });
  });

  test("the vault answers 401 to a pass whose permissions carry an unknown key", async () => {
    for (const permissions of [ADVERTISED, { write_tags: [MINE] }, { scoped_tags: [MINE], write_tags: [MINE] }]) {
      const token = resign(plainRead, permissions);
      const got = await reads(token);
      if (got.mine === 401 && got.other === 401) continue; // refused, as it should be
      must(await served(token), `unexpected vault answer to a pass with unknown permission keys ${JSON.stringify(permissions)}: ${JSON.stringify(got)}`);
      must(false, `the vault accepted a pass with unknown permission keys ${JSON.stringify(permissions)}: ${JSON.stringify(got)}`);
    }
  });
});

// Codex round 1: a pass minted before the fix may still carry an unknown key. The vault refuses it (above); the
// mint must refuse it as a minter too, or it can trade itself for a clean pass that drops the restriction.
describe("a pass carrying unknown permission keys can't mint (fix 14)", () => {
  test("a vault admin pass re-signed with write_tags can't mint a read pass over HTTP", async () => {
    const legacy = resign(admin, { write_tags: [MINE] });
    const r = await mintOverHttp(legacy, { scope: `vault:${s.vaultName}:read`, label: "contracts-laundered" });
    if (r.status === 401 || r.status === 403) return; // refused, as it should be
    must(r.status === 200 && typeof r.body?.token === "string", `unexpected mint answer: status ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    must(false, `a pass carrying unknown permission keys minted a new pass (claims ${JSON.stringify(claims(r.body.token).permissions ?? null)}; reads ${JSON.stringify(await reads(r.body.token))})`);
  });

  test("the same admin pass without the unknown key still mints (positive control)", async () => {
    const r = await mintOverHttp(resign(admin, { scoped_tags: [MINE] }), { scope: `vault:${s.vaultName}:read`, permissions: { scoped_tags: [MINE] } });
    expect(r.status).toBe(200);
    expect(await reads(r.body.token)).toEqual({ mine: 200, other: 404 });
  });
});
