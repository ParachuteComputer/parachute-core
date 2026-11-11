// 1.0 grants: applets in a shell (docs/SPEC-1.0-grants.md §5.3, §7.2, §4.3). An applet has no key: the shell asks
// the door for a token "as applet arcade", and the vault holds that token to the applet's grant and stamps its
// writes via `applet:arcade`. Only the signed-in grantor can ask as an applet. A caller with access to the vault who
// isn't the grantor is refused (403); a caller with no access gets the 401 an unknown vault gives. Neither gets a token.
//
// Red today: no door takes a signed statement, so most contracts stop where `granted()` files one, and each of those
// starts with a grant that must be taken. One is red for its own reason: today the door answers an ask "as an
// applet" with the owner's whole reach, because it ignores the field.
import { describe, expect, test } from "bun:test";
import { LANE, NO_GRANTS, declareType, door, enc, file, granted, ids, must, newKey, nostrAuth, rec, records, red, revokeEvent, runId, safeFetch, tokenAs, tokenReply, type Key } from "./_grants.ts";
import { token } from "../door/_door.ts";

const owner = records("write");
const tokenUrl = () => `${door().issuer}/account/vaults/${enc(door().vault)}/token`;

function payload(jwt: unknown): any {
  try {
    return JSON.parse(Buffer.from(String(jwt).split(".")[1]!, "base64url").toString());
  } catch {
    return null;
  }
}
/** What a vault token claims, without the token itself (for a failure message). */
const claims = (jwt: unknown) => {
  const c = payload(jwt);
  return c ? `scope "${c.scope}", permissions ${JSON.stringify(c.permissions ?? null)}` : "claims unreadable";
};
/** The grant a vault token is under (§7.2: `permissions.grant`). */
const grantOf = (jwt: unknown): unknown => payload(jwt)?.permissions?.grant;

/** Ask the door for a token as an applet with any authorization: a key's NIP-98, or a bearer credential. */
async function askAsApplet(applet: string, as: Key | { bearer: string }) {
  const body = JSON.stringify({ applet });
  const authorization = "bearer" in as ? `Bearer ${as.bearer}` : await nostrAuth(as.secretKey, tokenUrl(), "POST", body);
  const r = await safeFetch(tokenUrl(), { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe("setup holds today", () => {
  test("the owner declares the applet's types and writes to them", async () => {
    const [reaction, card] = [await declareType("reaction"), await declareType("card")];
    for (const type of [reaction, card]) {
      const made = await owner.make({ types: [type], body: "made by the owner" });
      expect(made.status).toBe(201);
      expect(rec(made.body).names).toEqual([type]);
    }
  });
});

describe("an applet", () => {
  red("asking as an applet nobody granted is refused, never answered with the owner's own reach", { reason: /the door handed a token for an applet with no grant/, lane: LANE }, async () => {
    const applet = runId("arcade");
    const r = await tokenReply({ applet });
    must(r.status !== 200, `the door handed a token for an applet with no grant: POST /account/vaults/<v>/token {applet} answered 200 with ${claims(r.body?.vault_token)}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_granted");
  });

  red("is held to its grant: reads its card, adds a reaction, sees nothing else, and writes via applet:<id>", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [reaction, card, journal] = [await declareType("reaction"), await declareType("card"), await declareType("journal")];
    const theCard = await owner.make({ types: [card], body: "a taste card" });
    const hidden = await owner.make({ types: [journal], body: "a private day" });
    const ownerBy = rec(theCard.body).by;
    const applet = runId("arcade");
    await granted({ to: { applet, author: await newKey() }, by: "signer", types: { [reaction]: ["create", "read:own"], [card]: ["read"] } });
    const asApplet = records({ bearer: await tokenAs({ applet }) });

    expect((await asApplet.get(theCard.body.id)).status).toBe(200);
    expect((await asApplet.get(hidden.body.id)).status).toBe(404);
    const made = await asApplet.make({ types: [reaction], body: "yum" });
    expect(made.status).toBe(201);
    const seen = rec((await owner.get(made.body.id)).body);
    expect(seen.by).toBe(ownerBy);
    expect(seen.via).toBe(`applet:${applet}`);
    const refused = await asApplet.make({ types: [card], body: "a card the applet made" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_granted");
    expect(refused.text).toContain(card);
  });

  red("with read:own it sees the reactions it made, and not the owner's", { reason: NO_GRANTS, lane: LANE }, async () => {
    const reaction = await declareType("reaction");
    const owners = await owner.make({ types: [reaction], body: "the owner's own reaction" });
    expect(owners.status).toBe(201);
    const applet = runId("arcade");
    await granted({ to: { applet, author: await newKey() }, by: "signer", types: { [reaction]: ["create", "read:own"] } });
    const asApplet = records({ bearer: await tokenAs({ applet }) });
    const mine = await asApplet.make({ types: [reaction], body: "the applet's reaction" });
    expect(mine.status).toBe(201);

    expect(ids(await asApplet.list({ type: reaction }))).toEqual([mine.body.id]);
    expect((await asApplet.get(mine.body.id)).status).toBe(200);
    expect((await asApplet.get(owners.body.id)).status).toBe(404);
  });

  red("own means by its signer and via the applet: the same applet in a member's shell and the owner's sees only its own", { reason: NO_GRANTS, lane: LANE }, async () => {
    const reaction = await declareType("reaction");
    const bo = await newKey();
    const b = await granted({ to: bo, by: "self", types: { [reaction]: ["create", "read:own"] } });
    const applet = runId("arcade");
    const author = await newKey();
    await granted({ to: { applet, author }, by: "signer", types: { [reaction]: ["create", "read:own"] } });
    await granted({ signer: bo, under: b.grantId, to: { applet, author }, by: "signer", types: { [reaction]: ["create", "read:own"] }, endsIn: 3_600 }, { as: bo });

    const ours = records({ bearer: await tokenAs({ applet }) });
    const bosAsk = await askAsApplet(applet, bo);
    expect(bosAsk.status).toBe(200);
    const bos = records({ bearer: bosAsk.body.vault_token });
    const fromOurs = await ours.make({ types: [reaction], body: "the owner's arcade reaction" });
    const fromBos = await bos.make({ types: [reaction], body: "Bo's arcade reaction" });
    expect([fromOurs.status, fromBos.status]).toEqual([201, 201]);
    // Both are via applet:<id>; only the signer tells them apart.
    expect(rec((await owner.get(fromBos.body.id)).body)).toMatchObject({ by: `nostr:${bo.pubkey}`, via: `applet:${applet}` });

    expect(ids(await ours.list({ type: reaction }))).toEqual([fromOurs.body.id]);
    expect(ids(await bos.list({ type: reaction }))).toEqual([fromBos.body.id]);
    expect((await ours.get(fromBos.body.id)).status).toBe(404);
    expect((await bos.get(fromOurs.body.id)).status).toBe(404);
  });

  red("only the signed-in grantor can ask as an applet: a caller with access is refused (403), one without is told nothing (401), neither gets a token", { reason: NO_GRANTS, lane: LANE }, async () => {
    const card = await declareType("card");
    const author = await newKey();
    const applet = runId("arcade");
    const g = await granted({ to: { applet, author }, by: "signer", types: { [card]: ["read"] } });
    const grantee = await newKey();
    await granted({ to: grantee, by: "signer", types: { [card]: ["read"] } });
    // The grantor asking is answered, under the applet's grant: the control.
    const control = await tokenReply({ applet });
    expect(control.status).toBe(200);
    expect(grantOf(control.body.vault_token)).toBe(g.grantId);

    // A caller with access to the vault who isn't the grantor: a key holding its own grant here. Refused, no token.
    const asGrantee = await askAsApplet(applet, grantee);
    expect(asGrantee.status).toBe(403);
    expect(asGrantee.body.error).toBe("not_granted");
    expect(asGrantee.body.vault_token).toBeUndefined();
    // A vault credential is not a sign-in at the door: the door may refuse it as a sign-in (401) or as a caller who
    // isn't the grantor (403). Either way, no token.
    const asVaultToken = await askAsApplet(applet, { bearer: await token("write") });
    expect([401, 403], `a vault credential answered ${asVaultToken.status}`).toContain(asVaultToken.status);
    expect(asVaultToken.body.vault_token).toBeUndefined();
    // Keys with no access here (the applet's author key, a stranger): told nothing, as for an unknown vault (§5.3, §7.2).
    for (const [who, as] of [["the author key", author], ["a stranger key", await newKey()]] as const) {
      const r = await askAsApplet(applet, as);
      expect(r.status, who).toBe(401);
      expect(r.body.vault_token, who).toBeUndefined();
    }
  });

  red("revoking the applet's grant: the next ask as that applet is refused, and its held token stops", { reason: NO_GRANTS, lane: LANE }, async () => {
    const card = await declareType("card");
    const theCard = await owner.make({ types: [card], body: "a taste card" });
    const applet = runId("arcade");
    const g = await granted({ to: { applet, author: await newKey() }, by: "signer", types: { [card]: ["read"] } });
    const held = records({ bearer: await tokenAs({ applet }) });
    expect((await held.get(theCard.body.id)).status).toBe(200);

    expect((await file(await revokeEvent(g))).status).toBe(201);
    const ask = await tokenReply({ applet });
    expect(ask.status).toBe(403);
    expect(ask.body.error).toBe("not_granted");
    const after = await held.get(theCard.body.id);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe("grant_ended");
  });
});
