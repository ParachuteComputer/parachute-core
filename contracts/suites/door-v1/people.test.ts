// 1.0 grants: who a write is for (docs/SPEC-1.0-grants.md §5.1, §5.2). A member writes as themselves. An agent writes
// for its person. A member may sign for their own agent, under their own grant: that agent never reaches past the
// member and ends with them.
//
// Red today: no door takes a signed statement, so each contract stops where `granted()` files one. Every body
// starts with a grant that must be taken, so a refusal further down can't pass because nothing is ever taken.
//
// Who carries a filing matters (§7.1): the owner, and a member filing their own agent's grant, are told §7.4's
// reasons; anyone else gets the 401 an unknown vault gives. So every reason asserted here is carried by one of those.
import { describe, expect, test } from "bun:test";
import { LANE, NO_GRANTS, declareType, file, grantEvent, grantRow, granted, newKey, ownerKey, rec, records, red, revokeEvent, runId, tokenAs, tokenReply } from "./_grants.ts";

const owner = records("write");
/** A member-signed grant ends well within the member's own (a day), so a second between the two signings can't
 *  carry its date past the member's and turn a control into an `exceeds_grantor` refusal. */
const HOUR = 3_600;

/** The owner's own stamp: the `by` on a record the owner makes now, at this door. */
async function ownersBy(type: string): Promise<string> {
  const made = await owner.make({ types: [type], body: "the owner's own" });
  if (made.status !== 201) throw new Error(`setup: the owner's write gave ${made.status} ${made.text.slice(0, 200)}`);
  return rec(made.body).by as string;
}

describe("setup holds today", () => {
  test("the owner's writes carry a stamp, and a key nobody granted gets no token", async () => {
    const recipe = await declareType("recipe");
    const made = await owner.make({ types: [recipe], body: "soup" });
    expect(made.status).toBe(201);
    expect(rec(made.body).by).toBeString();
    expect(rec((await owner.get(made.body.id)).body).by).toBe(rec(made.body).by);
    expect((await tokenReply(await newKey())).status).toBe(401);
  });
});

describe("a member", () => {
  red("writes as themselves: by their own key, via their grant, and the owner's writes stay the owner's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const ownersOwn = await owner.make({ types: [recipe], body: "the owner's soup" });
    const ownerBy = rec(ownersOwn.body).by;
    const bo = await newKey();
    const g = await granted({ to: bo, by: "self", types: { [recipe]: ["read", "create", "update"] } });
    const asBo = records({ bearer: await tokenAs(bo) });

    const made = await asBo.make({ types: [recipe], body: "Bo's bread" });
    expect(made.status).toBe(201);
    const seen = rec((await owner.get(made.body.id)).body);
    expect(seen.by).toBe(`nostr:${bo.pubkey}`);
    expect(seen.via).toBe(`grant:${g.grantId}`);

    // Bo edits the owner's record: the edit is his, the record's making stays the owner's.
    expect((await asBo.edit(ownersOwn.body.id, { body: "the owner's soup, salted" })).status).toBe(200);
    const edited = rec((await owner.get(ownersOwn.body.id)).body);
    expect(edited.by).toBe(ownerBy);
    expect(edited.lastBy).toBe(`nostr:${bo.pubkey}`);
    expect(edited.lastVia).toBe(`grant:${g.grantId}`);

    // The owner's own writes keep the owner's stamp.
    const later = rec((await owner.make({ types: [recipe], body: "the owner's stew" })).body);
    expect(later.by).toBe(ownerBy);
    expect(later.via).not.toBe(`grant:${g.grantId}`);
  });

  red("can't make a member or a service (403 no_standing to the member who signed)", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create"] } });
    // Mara may sign for her own agent: the control, so the refusals below aren't "nothing is taken".
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });

    // A `by self` grant's id has no dot (§2.2 line 6), so the member's would-be member gets a dotless one: then the
    // only thing wrong with it is the member's standing (line 3), not its shape.
    for (const by of ["self", { names: "portal.example" }] as const) {
      const friend = await newKey();
      const id = by === "self" ? runId("friend") : undefined;
      const r = await file(await grantEvent({ id, signer: mara, under: m.grantId, to: friend, by, types: { [recipe]: ["read"] }, endsIn: HOUR }), { as: mara });
      expect(r.status, JSON.stringify(by)).toBe(403);
      expect(r.body.error, JSON.stringify(by)).toBe("no_standing");
      expect((await tokenReply(friend)).status).toBe(401);
    }
  });

  red("a member-signed grant hangs from the member's own grant: none, or someone else's, is refused, and it can't carry `was`", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create"] } });
    const bo = await newKey();
    const b = await granted({ to: bo, by: "self", types: { [recipe]: ["read", "create"] } });
    // Under her own grant: taken.
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });

    // No `under` (the id still starts with hers, so only the missing tag is wrong): a malformed grant (§2.1, required
    // there). `under` naming Bo's grant: Mara has no standing to hang a grant from his.
    const cases = [
      { why: "no under", under: undefined, status: 400, error: "invalid_statement" },
      { why: "under Bo's grant", under: b.grantId, status: 403, error: "no_standing" },
    ];
    for (const c of cases) {
      const agent = await newKey();
      const r = await file(await grantEvent({ id: `${m.grantId}.${runId("a")}`, signer: mara, under: c.under, to: agent, by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }), { as: mara });
      expect(r.status, c.why).toBe(c.status);
      expect(r.body.error, c.why).toBe(c.error);
      expect((await tokenReply(agent)).status, c.why).toBe(401);
    }

    // Only the owner may say "treat those records as this grantee's" (§4.3).
    const agent = await newKey();
    const r = await file(await grantEvent({ signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read"] }, was: ["key:claude"], endsIn: HOUR }), { as: mara });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_statement");
    expect((await tokenReply(agent)).status).toBe(401);
  });

  red("ids: a member's start with their grant's id and a dot, and nobody else may use that start", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create"] } });
    const ownersAgent = await granted({ to: await newKey(), by: "signer", types: { [recipe]: ["read"] } });
    // `<her grant id>.<x>` from Mara is taken: the control.
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });

    const cases: { why: string; id: string; signer: "mara" | "owner" }[] = [
      { why: "Mara, an id outside her start", id: runId("mara-agent"), signer: "mara" },
      { why: "Mara, the owner's id", id: ownersAgent.grantId, signer: "mara" },
      { why: "the owner, an id in Mara's start", id: `${m.grantId}.${runId("o")}`, signer: "owner" },
    ];
    for (const c of cases) {
      const agent = await newKey();
      const e = c.signer === "mara"
        ? await grantEvent({ id: c.id, signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR })
        : await grantEvent({ id: c.id, to: agent, by: "signer", types: { [recipe]: ["read"] } });
      const r = await file(e, { as: c.signer === "mara" ? mara : "owner" });
      expect(r.status, c.why).toBe(409);
      expect(r.body.error, c.why).toBe("id_taken");
      expect((await tokenReply(agent)).status, c.why).toBe(401);
    }
  });

  red("a member's own grant has an id with no dot", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    // A dotless id: the control.
    await granted({ to: await newKey(), by: "self", types: { [recipe]: ["read"] } });
    const bo = await newKey();
    const r = await file(await grantEvent({ id: `${runId("bo")}.x`, to: bo, by: "self", types: { [recipe]: ["read"] } }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_statement");
    expect((await tokenReply(bo)).status).toBe(401);
  });
});

describe("an agent", () => {
  red("writes for its person: by the owner's own stamp, via its grant", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const ownerBy = await ownersBy(recipe);
    const claude = await newKey();
    const g = await granted({ to: claude, by: "signer", types: { [recipe]: ["read", "create"] } });
    const made = await records({ bearer: await tokenAs(claude) }).make({ types: [recipe], body: "a recipe Claude added" });
    expect(made.status).toBe(201);
    const seen = rec((await owner.get(made.body.id)).body);
    expect(seen.by).toBe(ownerBy);
    expect(seen.via).toBe(`grant:${g.grantId}`);
  });

  red("can't sign for anyone: 401 when it carries its own grant, 403 no_standing when the owner carries it", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const agent = await newKey();
    await granted({ to: agent, by: "signer", types: { [recipe]: ["read"] } });
    // One level: the agent signs for another key, even within what it holds.
    const helper = await newKey();
    const e = await grantEvent({ signer: agent, to: helper, by: "signer", types: { [recipe]: ["read"] } });
    expect((await file(e, { as: agent })).status).toBe(401);
    const told = await file(e);
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    expect((await tokenReply(helper)).status).toBe(401);
  });

  red("a member signs for their own agent, whose writes are by the member, via the agent's grant", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create", "update"] } });
    const agent = await newKey();
    const g = await granted({ signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read", "create"] }, endsIn: HOUR }, { as: mara });
    expect(g.grantId.startsWith(`${m.grantId}.`)).toBe(true);
    const made = await records({ bearer: await tokenAs(agent) }).make({ types: [recipe], body: "a recipe Mara's agent added" });
    expect(made.status).toBe(201);
    const seen = rec((await owner.get(made.body.id)).body);
    expect(seen.by).toBe(`nostr:${mara.pubkey}`);
    expect(seen.via).toBe(`grant:${g.grantId}`);
  });

  red("a member's agent never passes the member: another type, a verb the member lacks, or a later date is refused", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, pantry] = [await declareType("recipe"), await declareType("pantry")];
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create", "update"] }, endsIn: 86_400 });
    // Within Mara's own: taken.
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });

    const beyond: { why: string; types: Record<string, ("read" | "create" | "delete")[]>; endsIn: number }[] = [
      { why: "a type Mara can't reach", types: { [pantry]: ["read"] }, endsIn: HOUR },
      { why: "a verb Mara lacks", types: { [recipe]: ["read", "delete"] }, endsIn: HOUR },
      { why: "a date after Mara's own", types: { [recipe]: ["read"] }, endsIn: 2 * 86_400 },
    ];
    for (const b of beyond) {
      const agent = await newKey();
      const r = await file(await grantEvent({ signer: mara, under: m.grantId, to: agent, by: "signer", types: b.types, endsIn: b.endsIn }), { as: mara });
      expect(r.status, b.why).toBe(403);
      expect(r.body.error, b.why).toBe("exceeds_grantor");
      expect((await tokenReply(agent)).status, b.why).toBe(401);
    }
  });

  red("a member naming a key that already holds a grant is told exceeds_grantor, so filing can't show which keys hold grants", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create"] } });
    // A fresh key under hers: the control.
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });
    // A key the owner has already granted, in force.
    const held = await newKey();
    const o = await granted({ to: held, by: "signer", types: { [recipe]: ["read"] } });
    const r = await file(await grantEvent({ signer: mara, under: m.grantId, to: held, by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }), { as: mara });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("exceeds_grantor");
    expect((await records({ bearer: await tokenAs(held) }).info()).body.grant.id).toBe(o.grantId);
  });

  red("`read` is beyond `read:own`: a member holding read:own can't give their agent read", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read:own", "create"] } });
    // read:own for her agent: taken.
    await granted({ signer: mara, under: m.grantId, to: await newKey(), by: "signer", types: { [recipe]: ["read:own"] }, endsIn: HOUR }, { as: mara });
    const agent = await newKey();
    const r = await file(await grantEvent({ signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }), { as: mara });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("exceeds_grantor");
    expect((await tokenReply(agent)).status).toBe(401);
  });

  red("a member's denied tag is denied to their agent, whatever the agent's grant says", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    // The owner's two records first, so this setup runs today, before the first grant stops the body.
    const plain = await owner.make({ types: [recipe], body: "a recipe for everyone" });
    const held = await owner.make({ types: [recipe], tags: ["private"], body: "a family recipe" });
    expect([plain.status, held.status]).toEqual([201, 201]);
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read"] }, deny: ["private"] });
    const agent = await newKey();
    await granted({ signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read"] }, endsIn: HOUR }, { as: mara });

    const asAgent = records({ bearer: await tokenAs(agent) });
    expect((await asAgent.get(plain.body.id)).status).toBe(200);
    expect((await asAgent.get(held.body.id)).status).toBe(404);
  });

  red("narrowing the member narrows their agent at once; ending the member ends it, and bringing them back doesn't revive it", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create", "update"] } });
    const agent = await newKey();
    const k = await granted({ signer: mara, under: m.grantId, to: agent, by: "signer", types: { [recipe]: ["read", "create"] }, endsIn: HOUR }, { as: mara });
    const asAgent = records({ bearer: await tokenAs(agent) });
    const first = await asAgent.make({ types: [recipe], body: "before" });
    expect(first.status).toBe(201);

    // The owner takes create away from Mara: her agent's own grant still says create, and it no longer counts.
    const narrower = await grantEvent({ id: m.grantId, to: mara, by: "self", types: { [recipe]: ["read", "update"] }, created_at: m.created_at + 1 });
    expect((await file(narrower)).status).toBe(201);
    const refused = await asAgent.make({ types: [recipe], body: "after" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_granted");
    expect((await asAgent.get(first.body.id)).status).toBe(200);

    // The owner ends Mara: the token her agent already holds stops on its next request.
    expect((await file(await revokeEvent({ pubkey: (await ownerKey()).pubkey, grantId: m.grantId }))).status).toBe(201);
    const ended = await asAgent.get(first.body.id);
    expect(ended.status).toBe(401);
    expect(ended.body.error).toBe("grant_ended");
    expect((await tokenReply(agent)).status).toBe(401);

    // Mara comes back under a new id: her agent stays ended.
    await granted({ to: mara, by: "self", types: { [recipe]: ["read", "create", "update"] } });
    expect((await records({ bearer: await tokenAs(mara) }).get(first.body.id)).status).toBe(200);
    expect((await asAgent.get(first.body.id)).status).toBe(401);
    expect((await tokenReply(agent)).status).toBe(401);
    const row = await grantRow(k.grantId);
    expect(row).toBeDefined();
    expect(row.state).not.toBe("in_force");
  });
});
