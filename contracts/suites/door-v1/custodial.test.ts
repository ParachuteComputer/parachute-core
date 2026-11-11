// 1.0 grants: a service writing for its people (docs/SPEC-1.0-grants.md §6). A `by names <prefix>` grant lets a
// service say whom a write was for; the vault builds the stamp `<prefix>:<name>` itself. The header from anyone
// without that permission is refused, never ignored. A link statement says which key a name belongs to, and the
// name reads as that person's only after their own key claims it. Links and claims name the vault they are said in.
//
// Red today: no door takes a signed statement, so most contracts stop where `granted()` files one, and each of those
// starts with a grant that must be taken. One is red for its own reason: today a write carrying the on-behalf header
// from a credential without the permission is taken and the header ignored.
//
// Who carries a filing matters (§7.1): the owner is told §7.4's reasons; a service or a person carrying its own link
// or claim gets the 401 an unknown vault gives for every failure. So every reason asserted here is carried by the
// owner (`file(e)`).
import { describe, expect, test } from "bun:test";
import { LANE, NO_GRANTS, claimEvent, declareType, door, file, grantEvent, granted, ids, linkEvent, must, newKey, rec, records, red, revokeEvent, runId, tokenAs, tokenReply, voidNameEvent, type Key } from "./_grants.ts";

const owner = records("write");
const reader = records("read");
const HEADER = "parachute-on-behalf-of";

/** Write a record with the on-behalf header sent exactly as given, even empty. Returns the reply and the path used. */
async function writeFor(client: ReturnType<typeof records>, type: string, onBehalfOf: string) {
  const path = `${runId("custodial")}/${runId("r")}`;
  const r = await client.call("POST", "/notes", { content: "an order for the bakery", path, tags: [type] }, { [HEADER]: onBehalfOf });
  return { r, path };
}
/** Whether a record exists at a path, as the owner sees it. */
const exists = async (path: string) => (await owner.get(path)).status === 200;

/** A made-up service prefix of its own per contract, so two contracts' service keys never share one. */
const newPrefix = () => `${runId("portal")}.example`;

/** A service with a `names` grant over one type, its token, and a record it wrote for client-42. */
async function serviceWithRecord() {
  const order = await declareType("order");
  const prefix = newPrefix();
  const service = await newKey();
  const g = await granted({ to: service, by: { names: prefix }, types: { [order]: ["read", "create"] } });
  const asService = records({ bearer: await tokenAs(service) });
  const made = await asService.make({ types: [order], body: "two loaves", onBehalfOf: "client-42" });
  expect(made.status).toBe(201);
  return { order, prefix, service, g, asService, id: made.body.id as string, name: `${prefix}:client-42` };
}

/** The linked name's row in `GET /api/stamps`, as the owner's read credential sees it. */
async function stampOf(name: string) {
  const r = await reader.stamps();
  expect(r.status).toBe(200);
  return r.stamps.find((x) => x.name === name);
}
/** The records the filter by person finds for a key (§7.1). */
const byPerson = async (who: Key) => ids(await reader.byPerson(who.pubkey));

/** A link and Mara's claim on it, both taken: the name reads as hers. */
async function confirmedLink(s: Awaited<ReturnType<typeof serviceWithRecord>>, mara: Key) {
  const link = await linkEvent(s.service, s.name, mara);
  expect((await file(link, { as: s.service })).status).toBe(201);
  const claim = await claimEvent(mara, s.name, "mine");
  expect((await file(claim, { as: mara })).status).toBe(201);
  expect((await stampOf(s.name))?.state).toBe("confirmed");
  return { link, claim };
}

describe("setup holds today", () => {
  test("the owner writes without the header, and the write carries the owner's stamp", async () => {
    const order = await declareType("order");
    const made = await owner.make({ types: [order], body: "an order" });
    expect(made.status).toBe(201);
    expect(rec(made.body).by).toBeString();
    // The "nothing is written" check below can see a write that happened.
    expect(await exists(made.body.path)).toBe(true);
  });
});

describe("the on-behalf header", () => {
  red("from a credential without the permission is refused, never ignored", { reason: /the on-behalf header was ignored, not refused/, lane: LANE }, async () => {
    const order = await declareType("order");
    const { r, path } = await writeFor(owner, order, "client-42");
    try {
      must(r.status !== 201, `the on-behalf header was ignored, not refused: a write token without the permission answered 201, stamped by ${r.body?.createdBy}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("on_behalf_not_allowed");
      expect(await exists(path)).toBe(false);
    } finally {
      if (r.status === 201 && r.body?.id) await owner.remove(r.body.id);
    }
  });

  red("a service's write names its person under the service's prefix; without the header it is the owner's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const order = await declareType("order");
    const ownerBy = rec((await owner.make({ types: [order], body: "the owner's order" })).body).by;
    const prefix = newPrefix();
    const service = await newKey();
    const g = await granted({ to: service, by: { names: prefix }, types: { [order]: ["read", "create"] } });
    const asService = records({ bearer: await tokenAs(service) });

    const forMara = await asService.make({ types: [order], body: "two loaves", onBehalfOf: "client-42" });
    expect(forMara.status).toBe(201);
    const seen = rec((await owner.get(forMara.body.id)).body);
    expect(seen.by).toBe(`${prefix}:client-42`);
    expect(seen.via).toBe(`grant:${g.grantId}`);

    const plain = await asService.make({ types: [order], body: "the service's own note" });
    expect(plain.status).toBe(201);
    const plainSeen = rec((await owner.get(plain.body.id)).body);
    expect(plainSeen.by).toBe(ownerBy);
    expect(plainSeen.via).toBe(`grant:${g.grantId}`);
  });

  red("can't name outside its prefix or pose as a real stamp: a bad or empty name is refused and nothing is written", { reason: NO_GRANTS, lane: LANE }, async () => {
    const order = await declareType("order");
    const service = await newKey();
    await granted({ to: service, by: { names: newPrefix() }, types: { [order]: ["read", "create"] } });
    const asService = records({ bearer: await tokenAs(service) });
    for (const name of ["other.example:client-1", `nostr:${"ab".repeat(32)}`, "a@b", "x".repeat(65), ""]) {
      const { r, path } = await writeFor(asService, order, name);
      expect(r.status, JSON.stringify(name)).toBe(400);
      expect(r.body.error, JSON.stringify(name)).toBe("invalid_name");
      expect(await exists(path), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("a names grant", () => {
  red("can't claim a reserved prefix or an uppercase one", { reason: NO_GRANTS, lane: LANE }, async () => {
    const order = await declareType("order");
    await granted({ to: await newKey(), by: { names: newPrefix() }, types: { [order]: ["create"] } });
    for (const prefix of ["nostr", "key", "grant", "applet", "agent", "token", "operator", "migrate", "surface", "mcp", "api", "Portal.Example"]) {
      const service = await newKey();
      const r = await file(await grantEvent({ to: service, by: { names: prefix }, types: { [order]: ["create"] } }));
      expect(r.status, prefix).toBe(400);
      expect(r.body.error, prefix).toBe("invalid_statement");
      expect((await tokenReply(service)).status, prefix).toBe(401);
    }
  });

  red("only the vault's owner may sign one: a member can't", { reason: NO_GRANTS, lane: LANE }, async () => {
    const order = await declareType("order");
    const mara = await newKey();
    const m = await granted({ to: mara, by: "self", types: { [order]: ["read", "create"] } });
    const service = await newKey();
    const r = await file(await grantEvent({ signer: mara, under: m.grantId, to: service, by: { names: newPrefix() }, types: { [order]: ["create"] }, endsIn: 3_600 }), { as: mara });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("no_standing");
    expect((await tokenReply(service)).status).toBe(401);
  });
});

describe("the link statement", () => {
  red("the service's link alone is only a claim: listed unconfirmed, the record unchanged, not found as the person's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    expect((await file(await linkEvent(s.service, s.name, mara), { as: s.service })).status).toBe(201);

    expect(await stampOf(s.name)).toMatchObject({ name: s.name, key: mara.pubkey, state: "unconfirmed" });
    expect(rec((await owner.get(s.id)).body).by).toBe(s.name);
    expect(await byPerson(mara)).toEqual([]);
  });

  red("confirmed only by the person's own key: then the filter by person finds the record", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    expect((await file(await linkEvent(s.service, s.name, mara), { as: s.service })).status).toBe(201);

    // A claim from a key the link doesn't name: the owner is told why, the key carrying it is told nothing.
    const stranger = await newKey();
    const strangers = await claimEvent(stranger, s.name, "mine");
    const told = await file(strangers);
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    expect((await file(strangers, { as: stranger })).status).toBe(401);
    expect((await stampOf(s.name))?.state).toBe("unconfirmed");
    expect(await byPerson(mara)).toEqual([]);

    expect((await file(await claimEvent(mara, s.name, "mine"), { as: mara })).status).toBe(201);
    expect(await stampOf(s.name)).toMatchObject({ name: s.name, key: mara.pubkey, state: "confirmed" });
    expect(await byPerson(mara)).toEqual([s.id]);
    // Always both: the stamp still names the service's prefix.
    expect(rec((await owner.get(s.id)).body).by).toBe(s.name);
  });

  red("not-mine undoes a claim, and her newest claim counts", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    const { claim } = await confirmedLink(s, mara);
    expect(await byPerson(mara)).toEqual([s.id]);

    const notMine = await claimEvent(mara, s.name, "not-mine", { created_at: claim.created_at + 1 });
    expect((await file(notMine, { as: mara })).status).toBe(201);
    expect((await stampOf(s.name))?.state).not.toBe("confirmed");
    expect(await byPerson(mara)).toEqual([]);

    const mineAgain = await claimEvent(mara, s.name, "mine", { created_at: claim.created_at + 2 });
    expect((await file(mineAgain, { as: mara })).status).toBe(201);
    expect((await stampOf(s.name))?.state).toBe("confirmed");
    expect(await byPerson(mara)).toEqual([s.id]);
  });

  red("a link signed by a key that doesn't hold the prefix is refused", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const [mara, stranger] = [await newKey(), await newKey()];
    const e = await linkEvent(stranger, s.name, mara);
    const told = await file(e);
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    expect((await file(e, { as: stranger })).status).toBe(401);
    expect(await stampOf(s.name)).toBeUndefined();
  });

  red("a link from a service whose names grant was revoked is refused, and the links it filed before stay", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const [mara, other] = [await newKey(), await newKey()];
    const earlier = await linkEvent(s.service, s.name, mara);
    expect((await file(earlier, { as: s.service })).status).toBe(201);
    expect((await file(await revokeEvent(s.g))).status).toBe(201);
    const told = await file(await linkEvent(s.service, s.name, other, { created_at: earlier.created_at + 1 }));
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    // Ending the grant stops new links and leaves the filed ones: labels on history that stays (§6.2).
    expect(await stampOf(s.name)).toMatchObject({ name: s.name, key: mara.pubkey, state: "unconfirmed" });
  });

  red("a link or a claim said in another vault is refused here and changes nothing", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    // Said for the other vault (the same service may serve both), carried to this one.
    const elsewhere = await linkEvent(s.service, s.name, mara, { vault: door().otherVault });
    const r = await file(elsewhere);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("wrong_vault");
    expect(await stampOf(s.name)).toBeUndefined();

    // Linked here; her claim from the other vault doesn't confirm it.
    expect((await file(await linkEvent(s.service, s.name, mara), { as: s.service })).status).toBe(201);
    const claimElsewhere = await claimEvent(mara, s.name, "mine", { vault: door().otherVault });
    const c = await file(claimElsewhere);
    expect(c.status).toBe(400);
    expect(c.body.error).toBe("wrong_vault");
    expect((await stampOf(s.name))?.state).toBe("unconfirmed");
    expect(await byPerson(mara)).toEqual([]);
  });

  red("a link never opens anything: the person's key gets no token, even confirmed", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    await confirmedLink(s, mara);
    expect((await tokenReply(mara)).status).toBe(401);
  });

  red("the service unlinks by signing a newer link with no person", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    const link = await linkEvent(s.service, s.name, mara);
    expect((await file(link, { as: s.service })).status).toBe(201);
    expect((await stampOf(s.name))?.key).toBe(mara.pubkey);
    expect((await file(await linkEvent(s.service, s.name, null, { created_at: link.created_at + 1 }), { as: s.service })).status).toBe(201);
    expect(await stampOf(s.name)).toBeUndefined();
    expect(await byPerson(mara)).toEqual([]);
  });

  red("the owner voids a name: gone, and final for that name whichever service key links it next; only an owner key may void one", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    const { link } = await confirmedLink(s, mara);
    // The same form signed by the service: no standing, and the link stays.
    const theirs = await file(await voidNameEvent(s.name, { signer: s.service }));
    expect(theirs.status, theirs.text.slice(0, 200)).toBe(403);
    expect(theirs.body.error).toBe("no_standing");
    expect((await stampOf(s.name))?.state).toBe("confirmed");

    expect((await file(await voidNameEvent(s.name))).status).toBe(201);
    expect(await stampOf(s.name)).toBeUndefined();
    expect(await byPerson(mara)).toEqual([]);

    // A newer link by the same service key.
    const again = await file(await linkEvent(s.service, s.name, mara, { created_at: link.created_at + 1 }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("revoked");
    // A rotated service key under the same prefix.
    expect((await file(await revokeEvent(s.g))).status).toBe(201);
    const rotated = await newKey();
    await granted({ to: rotated, by: { names: s.prefix }, types: { [s.order]: ["read", "create"] } });
    const rotatedLink = await file(await linkEvent(rotated, s.name, mara, { created_at: link.created_at + 2 }));
    expect(rotatedLink.status).toBe(409);
    expect(rotatedLink.body.error).toBe("revoked");
    expect(await stampOf(s.name)).toBeUndefined();
    expect(await byPerson(mara)).toEqual([]);
  });

  red("her claim outlives the service's key: a new key under the same prefix links the name, and it is confirmed at once", { reason: NO_GRANTS, lane: LANE }, async () => {
    const s = await serviceWithRecord();
    const mara = await newKey();
    const { link } = await confirmedLink(s, mara);

    expect((await file(await revokeEvent(s.g))).status).toBe(201);
    const rotated = await newKey();
    await granted({ to: rotated, by: { names: s.prefix }, types: { [s.order]: ["read", "create"] } });
    expect((await file(await linkEvent(rotated, s.name, mara, { created_at: link.created_at + 1 }), { as: rotated })).status).toBe(201);
    expect(await stampOf(s.name)).toMatchObject({ name: s.name, key: mara.pubkey, state: "confirmed" });
    expect(await byPerson(mara)).toEqual([s.id]);
  });
});
