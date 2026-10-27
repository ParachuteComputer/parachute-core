// Fix 13: the hub's mint endpoint never issues a pass wider than the pass that asks for it, tags included.
//
// Today `POST /api/auth/mint-token` checks the requested scope strings against the minter's (capability
// attenuation, hub src/api-mint-token.ts:10-30) but copies the request's `permissions` verbatim into the new pass
// (src/api-mint-token.ts:441-452), and never looks at the minter's own `permissions`. So a vault admin limited to
// one tag can mint itself a pass with no tag limit, or with other tags. PLAN §5 fix 13, §7.5 mutant "mint:
// permissions copied". Lane F.
//
// The oracle is what the minted pass can read: "wider" means it reads a note the minter can't. A refusal (4xx)
// passes as well.
import { beforeAll, describe, expect, test } from "bun:test";
import { must, red, rest, runId, services } from "../lib.ts";
import { claims, mintOverHttp, note, scopedAdmin } from "./_lib.ts";

const s = services();
const R = runId("mint").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
let minter: string;
let inScope: string;
let outOfScope: string;

beforeAll(async () => {
  minter = await scopedAdmin([MINE]);
  inScope = await note(`${R}/mine`, "the minter may read this", [MINE]);
  outOfScope = await note(`${R}/other`, "the minter may not read this", [OTHER]);
});

/** Ask the hub for a read pass as the scoped minter; return null if refused, else what the new pass can read. */
async function mintAndRead(permissions?: Record<string, unknown>) {
  const r = await mintOverHttp(minter, { scope: `vault:${s.vaultName}:read`, label: "contracts-attenuated", ...(permissions ? { permissions } : {}) });
  if (r.status >= 400 && r.status < 500) return null;
  must(r.status === 200 && typeof r.body?.token === "string", `mint failed unexpectedly (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  const api = rest(s.vaultViaHub, r.body.token);
  return {
    token: r.body.token as string,
    readsMine: (await api.get(`/notes/${inScope}`)).status === 200,
    readsOther: (await api.get(`/notes/${outOfScope}`)).status === 200,
  };
}

describe("mint never widens (fix 13)", () => {
  test("setup works today: the scoped minter reads its tag only, and may mint over HTTP", async () => {
    const api = rest(s.vaultViaHub, minter);
    expect((await api.get(`/notes/${inScope}`)).status).toBe(200);
    expect((await api.get(`/notes/${outOfScope}`)).status).toBe(404);
    expect(claims(minter).permissions).toEqual({ scoped_tags: [MINE] });
  });

  test("a tag-scoped minter can mint a pass with its own tags, and that pass reads the same notes (positive control)", async () => {
    const got = await mintAndRead({ scoped_tags: [MINE] });
    expect(got).not.toBeNull();
    expect(got!.readsMine).toBe(true);
    expect(got!.readsOther).toBe(false);
  });

  red("a tag-scoped minter can't mint an unscoped pass", { reason: /minted a pass wider than the minter: no tags asked/, lane: "F" }, async () => {
    const got = await mintAndRead();
    must(got === null || !got.readsOther, `minted a pass wider than the minter: no tags asked, and the new pass (permissions ${JSON.stringify(got && claims(got.token).permissions)}) reads a note outside the minter's tags`);
  });

  red("a tag-scoped minter can't mint a pass for other tags", { reason: /minted a pass wider than the minter: other tags asked/, lane: "F" }, async () => {
    const got = await mintAndRead({ scoped_tags: [OTHER] });
    must(got === null || !got.readsOther, `minted a pass wider than the minter: other tags asked, and the new pass reads a note outside the minter's tags`);
  });

  red("a tag-scoped minter can't widen its tags by adding one", { reason: /minted a pass wider than the minter: its tags plus another/, lane: "F" }, async () => {
    const got = await mintAndRead({ scoped_tags: [MINE, OTHER] });
    must(got === null || !got.readsOther, `minted a pass wider than the minter: its tags plus another asked, and the new pass reads a note outside the minter's tags`);
  });
});
