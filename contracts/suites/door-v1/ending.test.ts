// 1.0 grants: how a grant ends (docs/SPEC-1.0-grants.md §3, §2.2 line 5, §7.4). It stops at its date with no one
// acting. A signed revoke stops it on the next request, tokens already held included, and is final: no event under
// that id is in force again, whatever its date or the order the two arrive in, but it bans the id, not the key. Only
// the grant's signer, the owner, or the grantee giving it up may revoke. Only the owner carrying a refused revoke is
// told why; anyone else gets the 401 an unknown vault gives (§7.1).
//
// Red today: no door takes a signed statement, so each contract stops where `granted()` files one. Every body
// starts with a grant that must be taken, so a refusal further down can't pass because nothing is ever taken.
import { describe, expect, test } from "bun:test";
import { KIND, LANE, NO_GRANTS, declareType, file, grantEvent, grantRow, granted, newKey, ownerKey, rec, records, red, revokeEvent, sign, tokenAs, tokenReply, vaultId, type Reply } from "./_grants.ts";

const owner = records("write");

/** The state of one grant in the owner's list (§7.1). */
const state = async (grantId: string): Promise<string | undefined> => (await grantRow(grantId))?.state;

/** A request under a grant that has ended (§7.4). */
function ended(r: Reply) {
  expect(r.status, r.text.slice(0, 200)).toBe(401);
  expect(r.body.error).toBe("grant_ended");
}

describe("setup holds today", () => {
  test("the owner makes a record and reads it; a revoke signs; a key nobody granted gets no token", async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    expect(soup.status).toBe(201);
    expect(rec((await owner.get(soup.body.id)).body).body).toBe("soup");
    // The revoke the contracts file names the grant by its address (§3).
    const g = await grantEvent({ to: await newKey(), types: { [recipe]: ["read"] } });
    const r = await revokeEvent(g);
    expect(r.tags[0]).toEqual(["a", `37440:${(await ownerKey()).pubkey}:${g.grantId}`]);
    expect((await tokenReply(await newKey())).status).toBe(401);
  });
});

describe("by its date", () => {
  red("a grant stops at its date: the token already held and a new one are both refused, and the list says expired", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    // Six seconds: room for the token and the first read on a slow runner before the date passes.
    const g = await granted({ to: key, types: { [recipe]: ["read"] }, endsIn: 6 });
    const bearer = await tokenAs(key);
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
    // Wait out the date, and a second past it, with no one acting.
    const until = (g.created_at + 6 + 1) * 1000 - Date.now();
    if (until > 0) await Bun.sleep(until);
    ended(await records({ bearer }).get(soup.body.id));
    expect((await tokenReply(key)).status).toBe(401);
    expect(await state(g.grantId)).toBe("expired");
  }, 20_000);
});

describe("by a signed revoke", () => {
  red("a revoke stops the grant on the next request, for a token already held", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    const g = await granted({ to: key, types: { [recipe]: ["read"] } });
    const bearer = await tokenAs(key);
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
    const r = await file(await revokeEvent(g));
    expect(r.status).toBe(201);
    ended(await records({ bearer }).get(soup.body.id));
    expect((await tokenReply(key)).status).toBe(401);
    expect(await state(g.grantId)).toBe("revoked");
  });

  red("a revoke is final: the same grant again, or a newer or future-dated one under its id, is refused", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const key = await newKey();
    const g = await granted({ to: key, types: { [recipe]: ["read"] } });
    expect((await file(await revokeEvent(g))).status).toBe(201);
    for (const e of [g, await grantEvent({ id: g.grantId, to: key, types: { [recipe]: ["read"] }, created_at: g.created_at + 1 }), await grantEvent({ id: g.grantId, to: key, types: { [recipe]: ["read"] }, created_at: g.created_at + 300 })]) {
      const r = await file(e);
      expect(r.status, `created_at ${e.created_at}`).toBe(409);
      expect(r.body.error).toBe("revoked");
    }
    expect((await tokenReply(key)).status).toBe(401);
    expect(await state(g.grantId)).toBe("revoked");
  });

  red("a revoke needs no order: filed before the grant it names, it still wins", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    // The route takes grants at all ...
    await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    // ... and this one arrives after its own revoke, which is kept (201) though it names nothing on file yet.
    const key = await newKey();
    const g = await grantEvent({ to: key, types: { [recipe]: ["read"] } });
    const early = await file(await revokeEvent(g));
    expect(early.status, early.text.slice(0, 200)).toBe(201);
    const r = await file(g);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("revoked");
    expect((await tokenReply(key)).status).toBe(401);
  });

  red("a stranger's revoke is refused and changes nothing, and only the owner carrying it is told why; the grantee may give its own grant up", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    const g = await granted({ to: key, types: { [recipe]: ["read"] } });
    const bearer = await tokenAs(key);
    const stranger = await newKey();
    const theirs = await revokeEvent(g, { signer: stranger });
    // Carried by the owner's own sign-in: the signature is what counts, and the owner is told why.
    const told = await file(theirs);
    expect(told.status, told.text.slice(0, 200)).toBe(403);
    expect(told.body.error).toBe("no_standing");
    // Carried by the stranger: the answer an unknown vault gives, so the route says nothing about this vault.
    const unknown = await file(theirs, { as: stranger, vault: "no-such-vault-here" });
    const carried = await file(theirs, { as: stranger });
    expect(carried.status).toBe(401);
    expect(carried.body).toEqual(unknown.body);
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
    expect(await state(g.grantId)).toBe("in_force");
    // The grantee's own signed revoke, carried by the grantee, is taken.
    expect((await file(await revokeEvent(g, { signer: key }), { as: key })).status).toBe(201);
    ended(await records({ bearer }).get(soup.body.id));
    expect(await state(g.grantId)).toBe("revoked");
  });

  red("a revoke ends one exact address, and only its owner, its signer or its grantee may sign it", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const [k1, k2] = [await newKey(), await newKey()];
    const a = await granted({ to: k1, types: { [recipe]: ["read"] } });
    await granted({ to: k2, types: { [recipe]: ["read"] } });
    const bearer = await tokenAs(k1);
    const vault = await vaultId();
    const revokeOf = (address: string) => sign(k2, { kind: KIND.revoke, tags: [["a", address], ["vault", vault]], content: "I end this grant." });
    // K2 holds a grant of its own, but A is neither its address nor its grant: refused, told only to the owner.
    const real = await revokeOf(`${KIND.grant}:${a.pubkey}:${a.grantId}`);
    const told = await file(real);
    expect(told.status, told.text.slice(0, 200)).toBe(403);
    expect(told.body.error).toBe("no_standing");
    expect((await file(real, { as: k2 })).status).toBe(401);
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
    // K2's own key in the address names some other grant, not the owner's A. K2 isn't an owner or a member, so its
    // early revoke isn't kept, and A's id isn't burned.
    const own = await file(await revokeOf(`${KIND.grant}:${k2.pubkey}:${a.grantId}`));
    expect(own.status, own.text.slice(0, 200)).toBe(403);
    expect(own.body.error).toBe("no_standing");
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
    expect(await state(a.grantId)).toBe("in_force");
    const newer = await grantEvent({ id: a.grantId, to: k1, types: { [recipe]: ["read"] }, created_at: a.created_at + 1 });
    expect((await file(newer)).status).toBe(201);
    expect((await records({ bearer }).get(soup.body.id)).status).toBe(200);
  });

  red("revoking an id doesn't ban the key: a new id for the same key works", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    const first = await granted({ to: key, types: { [recipe]: ["read"] } });
    expect((await file(await revokeEvent(first))).status).toBe(201);
    expect((await tokenReply(key)).status).toBe(401);
    const second = await granted({ to: key, types: { [recipe]: ["read"] } });
    expect(second.grantId).not.toBe(first.grantId);
    expect((await records({ bearer: await tokenAs(key) }).get(soup.body.id)).status).toBe(200);
    expect(await state(first.grantId)).toBe("revoked");
    expect(await state(second.grantId)).toBe("in_force");
  });
});
