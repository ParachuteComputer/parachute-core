// 1.0 grants: the grant itself (docs/SPEC-1.0-grants.md §2, §4.4, §7). An owner-signed statement opens exactly the
// types it names to the key it names. Anything that isn't the owner's signed word is refused.
//
// Red today: no door takes a signed statement, so each contract stops where `granted()` files one. Every body
// starts with a grant that must be taken, so a refusal further down can't pass because nothing is ever taken.
import { describe, expect, test } from "bun:test";
import { KIND, LANE, NO_GRANTS, declareType, door, file, grantEvent, grantRow, granted, ids, must, newKey, ownerKey, rec, records, red, rest, revokeEvent, sign, statements, tokenAs, tokenReply, vaultId, vaultRecordEvent } from "./_grants.ts";
import { lacks } from "../door/_door.ts";

const owner = records("write");

describe("setup holds today", () => {
  test("the door knows a made-up owner key, the owner can write, and a key nobody granted gets no token", async () => {
    expect((await ownerKey()).pubkey).toMatch(/^[0-9a-f]{64}$/);
    const type = await declareType("recipe");
    const made = await owner.make({ types: [type], body: "soup" });
    expect(made.status).toBe(201);
    expect(rec(made.body).names).toEqual([type]);
    // Holds today and at 1.0: a key with no grant in force is told nothing.
    const stranger = await tokenReply(await newKey());
    expect(stranger.status).toBe(401);
  });
});

describe("a signed grant", () => {
  red("a vault says its own id, the same after a rename would be, so a grant can name it", { reason: /the vault has no id of its own/, lane: LANE }, async () => {
    const info = await rest("read").get("/vault");
    must(typeof info.body?.id === "string" && /^[0-9a-f]{64}$/.test(info.body.id), `the vault has no id of its own: GET /api/vault has keys ${Object.keys(info.body ?? {}).join(",")}`);
    expect(info.body.id).not.toBe((await rest("read", door().otherVault).get("/vault")).body.id);
  });

  red("the vault's own key names it, can't be a grantee, and an owner's override names the key that signs for it now", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    const id = await vaultId();
    // The vault's id is its own public key (§2.3). It has no standing, so it can't hold a grant either.
    const asGrantee = await file(await grantEvent({ to: { secretKey: "", pubkey: id }, types: { [recipe]: ["read"] } }));
    expect(asGrantee.status).toBe(409);
    expect(asGrantee.body.error).toBe("grantee_has_grant");
    // The owner rotates: an override names a new key. The vault's birth record (key = id) no longer counts.
    const fresh = await newKey();
    const override = await file(await vaultRecordEvent(await ownerKey(), { key: fresh.pubkey }));
    expect(override.status, override.text.slice(0, 200)).toBe(201);
    const listed = (await statements()).body?.records ?? [];
    const counts = listed.filter((r: any) => r.counts).map((r: any) => r.key);
    expect(counts).toEqual([fresh.pubkey]);
    // A stranger's record for this vault has no standing.
    const stranger = await newKey();
    const theirs = await file(await vaultRecordEvent(stranger, { key: stranger.pubkey }));
    expect(theirs.status).toBe(403);
    expect(theirs.body.error).toBe("no_standing");
  });

  red("opens the types it names to the key it names, and nothing else", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, journal] = [await declareType("recipe"), await declareType("journal")];
    const mine = await owner.make({ types: [recipe], body: "soup" });
    const hidden = await owner.make({ types: [journal], body: "a private day" });
    const loose = await owner.make({ body: "no type at all" });
    const key = await newKey();
    const g = await granted({ to: key, types: { [recipe]: ["read"] } });

    const bo = records({ bearer: await tokenAs(key) });
    expect((await bo.get(mine.body.id)).status).toBe(200);
    expect(ids(await bo.list({ type: recipe }))).toEqual([mine.body.id]);
    // Hidden is the same as missing: 404, never 403.
    expect((await bo.get(hidden.body.id)).status).toBe(404);
    expect((await bo.get(loose.body.id)).status).toBe(404);
    expect(ids(await bo.list())).toEqual([mine.body.id]);
    // The key is told what it holds.
    const info = await bo.info();
    expect(info.body.grant.id).toBe(g.grantId);
    // It opens this vault only: no token for the owner's other vault, and this token is refused there.
    expect((await tokenReply(key, door().otherVault)).status).toBe(401);
    expect((await records({ bearer: await tokenAs(key) }, door().otherVault).list()).status).toBeOneOf([401, 403]);
  });

  red("the owner's list shows it, with the signed event word for word", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const key = await newKey();
    const g = await granted({ to: key, types: { [recipe]: ["read", "create"] } });
    const list = await statements();
    expect(list.status).toBe(200);
    const row = list.body.grants.find((x: any) => x.id === g.grantId);
    expect(row).toMatchObject({ origin: "signed", state: "in_force", grantee: key.pubkey, by: "signer" });
    expect(row.types).toEqual({ [recipe]: ["read", "create"] });
    expect(row.event.sig).toBe(g.sig);
    // The grantee sees its own row and no one else's.
    const other = await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    const own = await statements({ as: key });
    expect(own.body.grants.map((x: any) => x.id)).toEqual([g.grantId]);
    expect(JSON.stringify(own.body)).not.toContain(other.grantId);
  });

  red("a newer event under the same id replaces it, and can't change who it is for", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, log] = [await declareType("recipe"), await declareType("cooklog")];
    const key = await newKey();
    const first = await granted({ to: key, types: { [recipe]: ["read"], [log]: ["read"] } });
    const inLog = await owner.make({ types: [log], body: "cooked it" });
    const bearer = await tokenAs(key);
    expect((await records({ bearer }).get(inLog.body.id)).status).toBe(200);
    // Narrowed: the token already held follows the new event at once.
    const narrower = await grantEvent({ id: first.grantId, to: key, types: { [recipe]: ["read"] }, created_at: first.created_at + 1 });
    expect((await file(narrower)).status).toBe(201);
    expect((await records({ bearer }).get(inLog.body.id)).status).toBe(404);
    // The older event can't come back, and the id can't be pointed at another key.
    expect((await file(first)).status).toBe(409);
    const moved = await grantEvent({ id: first.grantId, to: await newKey(), types: { [recipe]: ["read"] }, created_at: first.created_at + 2 });
    const r = await file(moved);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("id_taken");
  });
});

describe("one grant per grantee", () => {
  red("a key holds one grant in force in a vault: a second is refused until the first has ended", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, log] = [await declareType("recipe"), await declareType("cooklog")];
    const key = await newKey();
    const first = await granted({ to: key, types: { [recipe]: ["read"] } });
    const second = await grantEvent({ to: key, types: { [log]: ["read"] } });
    const r = await file(second);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("grantee_has_grant");
    expect((await file(await revokeEvent(first))).status).toBe(201);
    expect((await file(second)).status).toBe(201);
    expect((await records({ bearer: await tokenAs(key) }).info()).body.grant.id).toBe(second.grantId);
  });

  red("the grantee can carry its own grant to the door: the signed event is the invitation", { reason: /the door didn't take a grant carried by its grantee: POST \S+ answered 40[45]/, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const mine = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    const e = await grantEvent({ to: key, types: { [recipe]: ["read"] } });
    const r = await file(e, { as: key });
    must(r.status === 201, `the door didn't take a grant carried by its grantee: POST /account/vaults/<v>/statements answered ${r.status}`);
    expect((await records({ bearer: await tokenAs(key) }).get(mine.body.id)).status).toBe(200);
  });

  red("a grantee is never one of the vault's owner keys", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    const r = await file(await grantEvent({ to: await ownerKey(), types: { [recipe]: ["read"] } }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("grantee_has_grant");
  });
});

describe("ids", () => {
  red("an id is never reused: not after a revoke, and not for another key after it expired", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const [k1, k2] = [await newKey(), await newKey()];
    // Revoked: the same address is final, whatever the new event's date (§3).
    const x = await granted({ to: k1, types: { [recipe]: ["read"] } });
    expect((await file(await revokeEvent(x))).status).toBe(201);
    const again = await file(await grantEvent({ id: x.grantId, to: k1, types: { [recipe]: ["read"] }, created_at: x.created_at + 1 }));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("revoked");
    // Merely expired: the id still belongs to the grantee it named, because `grant:<id>` stays on what it wrote (§2.2 line 6).
    const y = await granted({ to: k1, types: { [recipe]: ["read"] }, endsIn: 6 });
    await Bun.sleep(7_000);
    const other = await file(await grantEvent({ id: y.grantId, to: k2, types: { [recipe]: ["read"] } }));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("id_taken");
    expect((await tokenReply(k2)).status).toBe(401);
  }, 20_000);
});

describe("what a vault refuses to file", () => {
  /** Every case first files a good grant for the same key shape, so "refused" can't mean "nothing is taken". */
  async function control(recipe: string) {
    await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
  }

  red("a grant signed by a key that isn't the owner's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await control(recipe);
    const stranger = await newKey();
    const key = await newKey();
    const e = await grantEvent({ signer: stranger, to: key, types: { [recipe]: ["read"] } });
    // The owner is told why. Anyone else carrying it gets the answer an unknown vault gives (§7.1).
    const told = await file(e);
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    const unknown = await file(e, { as: stranger, vault: "no-such-vault-here" });
    for (const as of [stranger, key]) {
      const r = await file(e, { as });
      expect(r.status).toBe(401);
      expect(r.body).toEqual(unknown.body);
    }
    expect((await tokenReply(key)).status).toBe(401);
  });

  red("a grant changed after it was signed, and one whose id isn't its hash", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, journal] = [await declareType("recipe"), await declareType("journal")];
    await control(recipe);
    const key = await newKey();
    const e = await grantEvent({ to: key, types: { [recipe]: ["read"] } });
    const widened = { ...e, content: e.content.split(JSON.stringify(recipe)).join(JSON.stringify(journal)) };
    const r = await file(widened);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_signature");
    expect((await file({ ...e, sig: "00".repeat(64) })).status).toBe(400);
    expect((await tokenReply(key)).status).toBe(401);
  });

  red("a grant that names another vault, even the same owner's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await control(recipe);
    const key = await newKey();
    // Signed for the other vault, carried to this one; and a revoke signed for the other vault (§3).
    const e = await grantEvent({ id: "elsewhere", to: key, types: { "*": ["read"] }, vault: door().otherVault });
    const r = await file(e);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("wrong_vault");
    const mine = await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    const there = await file(await revokeEvent(mine, { vault: door().otherVault }));
    expect(there.status).toBe(400);
    expect(there.body.error).toBe("wrong_vault");
    expect((await grantRow(mine.grantId))?.state).toBe("in_force");
    expect((await tokenReply(key)).status).toBe(401);
  });

  red("a grant with no end date, one already ended, and one that lasts longer than a year", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await control(recipe);
    for (const endsIn of [null, -60, 400 * 86_400]) {
      const key = await newKey();
      const r = await file(await grantEvent({ to: key, types: { [recipe]: ["read"] }, endsIn }));
      expect(r.status, `endsIn ${endsIn}`).toBe(400);
      expect(r.body.error).toBe("invalid_statement");
      expect((await tokenReply(key)).status).toBe(401);
    }
  });

  red("a grant carrying a tag or a verb the vault doesn't know: refused, never read around", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    await control(recipe);
    const key = await newKey();
    // A limit from some later version, in the content or as a tag. A vault that skipped it would open more than was
    // signed. And the same grant spelled a second way, or with tags that disagree with its content (§2.1).
    for (const e of [
      await grantEvent({ to: key, types: { [recipe]: ["read"] }, extraFields: { only_fields: ["title"] } }),
      await grantEvent({ to: key, types: { [recipe]: ["read"] }, extraTags: [["only-field", "title"]] }),
    ]) {
      const future = await file(e);
      expect(future.status).toBe(400);
      expect(future.body.error).toBe("invalid_statement");
    }
    const plain = await grantEvent({ to: key, types: { [recipe]: ["read"] } });
    const spaced = await sign(await ownerKey(), { kind: KIND.grant, tags: plain.tags, content: JSON.stringify(JSON.parse(plain.content), null, 1) });
    const disagreeing = await sign(await ownerKey(), { kind: KIND.grant, tags: [plain.tags[0], ["expiration", String(Number(plain.tags[1][1]) + 60)]], content: plain.content });
    for (const e of [spaced, disagreeing]) {
      const r = await file(e);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_statement");
    }
    const verb = await file(await grantEvent({ to: key, types: { [recipe]: ["read", "admin" as any] } }));
    expect(verb.status).toBe(400);
    expect(verb.body.error).toBe("invalid_statement");
    // update with no read on the type, and an applet grant over every record, are incoherent (§2.2 line 8).
    for (const e of [await grantEvent({ to: key, types: { [recipe]: ["update"] } }), await grantEvent({ to: { applet: "arcade", author: await newKey() }, types: { "*": ["read"] } })]) {
      const r = await file(e);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_statement");
    }
    expect((await tokenReply(key)).status).toBe(401);
  });
});

describe("what no grant opens", () => {
  red("a grantee can't manage types, export, change the vault, read or erase history, or file a grant for anyone", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const kept = await owner.make({ types: [recipe], body: "kept, with its history" });
    const key = await newKey();
    await granted({ to: key, types: { "*": ["read", "create", "update", "delete"] } });
    const bo = records({ bearer: await tokenAs(key) });
    expect((await bo.call("PUT", `/tags/${recipe}`, { fields: { a: { type: "string" } } })).status).toBe(403);
    expect((await bo.call("PATCH", "/vault", { description: "mine now" })).status).toBe(403);
    expect((await bo.call("GET", "/history/deleted")).status).toBe(403);
    // It may delete the record (it holds `delete`), but never erase its history: that is admin (§4.4).
    expect((await bo.call("DELETE", `/notes/${kept.body.id}?erase_history=true`)).status).toBe(403);
    expect((await owner.get(kept.body.id)).status).toBe(200);
    // Export is never granted (§4.4), even to a grant over every record. Only where the door exports over HTTP.
    if (!lacks("export-over-http")) expect((await bo.call("GET", "/export")).status).toBe(403);
    // It signs a grant for a friend: no standing (a `by self` grantee would be a member, and still couldn't).
    // Carried by the grantee it is told nothing (401, §7.1); carried by the owner it is told why.
    const friend = await newKey();
    const e = await grantEvent({ signer: key, to: friend, types: { [recipe]: ["read"] } });
    expect((await file(e, { as: key })).status).toBe(401);
    const told = await file(e);
    expect(told.status).toBe(403);
    expect(told.body.error).toBe("no_standing");
    expect((await tokenReply(friend)).status).toBe(401);
  });

  red("a vault credential, even an admin one, can't file a statement: only the owner's sign-in or a signed carrier can", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const key = await newKey();
    const e = await grantEvent({ to: key, types: { [recipe]: ["read"] } });
    // The same event is taken from the owner …
    await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    // … and not from a token that only opens the vault.
    for (const level of ["write", "admin"] as const) expect((await file(e, { as: level })).status).toBe(401);
    expect((await tokenReply(key)).status).toBe(401);
  });

  red("every credential that reaches the vault is a row in the list: an app key shows as a grant the door vouches for", { reason: /no grant list at this door: GET \S+\/statements answered 40[45]/, lane: LANE }, async () => {
    const d = door();
    const { accountToken, safeFetch } = await import("../door/_door.ts");
    const name = `door-app-${Math.random().toString(36).slice(2, 8)}`;
    const made = await safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: { authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" }, body: JSON.stringify({ name, vault: d.vault, can: "write" }) });
    expect(made.status).toBe(201);
    const list = await statements();
    must(list.status === 200, `no grant list at this door: GET /account/vaults/<v>/statements answered ${list.status}`);
    const row = list.body.grants.find((x: any) => x.id === name);
    expect(row).toMatchObject({ origin: "door", state: "in_force" });
    expect(row.types).toEqual({ "*": ["read", "create", "update", "delete"] });
    // A door grant has no signed event: the row says `event: null` (§7.1).
    expect(row.event ?? null).toBeNull();
  });
});
