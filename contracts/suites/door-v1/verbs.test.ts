// 1.0 grants: the verbs (docs/SPEC-1.0-grants.md §2.1, §4.1–4.3). `read`, `create`, `update`, `delete`, each alone;
// `create` without `read` is a form, and a form can't choose a path; `:own` reaches only what the grantee made, and
// `was` carries that across a new grant but can't be added or changed by a replacement; a type covers its subtypes;
// a denied tag hides a record from every verb and can't be attached; adding a type needs `create` on it and removing
// one needs `delete`; grants only add; `"*"` covers untyped records.
//
// Red today: no door takes a signed statement, so each contract stops where `granted()` files one. Every body
// starts with a grant that must be taken, so a refusal further down can't pass because nothing is ever taken. The
// owner's records are made before the grant, so their setup runs today.
import { describe, expect, test } from "bun:test";
import { LANE, NO_GRANTS, declareSubtype, declareType, file, grantEvent, grantRow, granted, ids, newKey, rec, records, red, revokeEvent, runId, tokenAs, type Key, type Reply } from "./_grants.ts";

const owner = records("write");

/** The grantee's record client, under the one grant its key holds. */
const as = async (key: Key) => records({ bearer: await tokenAs(key) });

/** A refused write on a visible record: 403 `not_granted`, naming the verb and the type (§4.2, §7.4). */
function notGranted(r: Reply, verb: string, type: string) {
  expect(r.status, r.text.slice(0, 200)).toBe(403);
  expect(r.body.error).toBe("not_granted");
  expect(JSON.stringify(r.body)).toContain(verb);
  expect(JSON.stringify(r.body)).toContain(type);
}

/** The record as the owner sees it now. */
const now = async (id: string) => rec((await owner.get(id)).body);

describe("setup holds today", () => {
  test("the owner can make typed, untyped, two-typed and subtyped records, and add and remove types on them", async () => {
    const [recipe, log] = [await declareType("recipe"), await declareType("cooklog")];
    const sub = await declareSubtype(recipe, "sub");
    const both = await owner.make({ types: [recipe, log], body: "two types" });
    expect(both.status).toBe(201);
    expect(rec(both.body).names).toEqual([recipe, log].sort());
    const loose = await owner.make({ body: "no type at all" });
    expect(loose.status).toBe(201);
    expect(rec(loose.body).names).toEqual([]);
    // A query by a type reaches its subtypes today.
    const child = await owner.make({ types: [sub], body: "a child" });
    expect(child.status).toBe(201);
    expect(ids(await owner.list({ type: recipe }))).toContain(child.body.id);
    // Types and tags move on a record with one edit.
    const marked = await owner.make({ types: [recipe], tags: [runId("private")], body: "marked" });
    expect(marked.status).toBe(201);
    const added = await owner.edit(both.body.id, { add: [sub], remove: [log] });
    expect(added.status, added.text.slice(0, 200)).toBe(200);
    expect((await now(both.body.id)).names).toEqual([recipe, sub].sort());
    expect((await owner.edit(both.body.id, { body: "edited" })).status).toBe(200);
    expect((await owner.remove(loose.body.id)).status).toBe(200);
    expect((await owner.get(loose.body.id)).status).toBe(404);
  });
});

describe("each verb alone", () => {
  red("read alone reads, and can't create, update or delete", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read"] } });
    const bo = await as(key);
    expect((await bo.get(soup.body.id)).status).toBe(200);
    expect(ids(await bo.list({ type: recipe }))).toEqual([soup.body.id]);
    notGranted(await bo.make({ types: [recipe], body: "bread" }), "create", recipe);
    notGranted(await bo.edit(soup.body.id, { body: "changed" }), "update", recipe);
    notGranted(await bo.remove(soup.body.id), "delete", recipe);
    // A refused write changes nothing.
    expect((await now(soup.body.id)).body).toBe("soup");
    expect(ids(await owner.list({ type: recipe }))).toEqual([soup.body.id]);
  });

  red("create without read is a form: it adds where the vault puts it, and reads nothing back, not even what it added", { reason: NO_GRANTS, lane: LANE }, async () => {
    const signup = await declareType("signup");
    const theirs = await owner.make({ types: [signup], body: "an earlier signup" });
    const key = await newKey();
    await granted({ to: key, types: { [signup]: ["create"] } });
    const form = await as(key);
    // It sends no path: the vault assigns one.
    const sent = await form.make({ types: [signup], body: "count me in", path: null });
    expect(sent.status).toBe(201);
    expect((await now(sent.body.id)).body).toBe("count me in");
    // A form that names a path is refused, so it can't probe which paths are taken (§4.1), and nothing is written.
    const chosen = `${runId("signups")}/${runId("mine")}`;
    const named = await form.make({ types: [signup], body: "at my own path", path: chosen });
    expect(named.status, named.text.slice(0, 200)).toBe(400);
    expect(named.body.error).toBe("path_not_allowed");
    expect((await owner.get(chosen)).status).toBe(404);
    expect(ids(await owner.list({ type: signup }))).toEqual([sent.body.id, theirs.body.id].sort());
    // Its own receipt is the 201. After that, its record is as hidden as anyone's.
    expect((await form.get(sent.body.id)).status).toBe(404);
    expect((await form.get(theirs.body.id)).status).toBe(404);
    expect(ids(await form.list({ type: signup }))).toEqual([]);
    expect(ids(await form.list())).toEqual([]);
    // Not visible, so not editable: 404, never 403.
    expect((await form.edit(sent.body.id, { body: "changed my mind" })).status).toBe(404);
    expect((await now(sent.body.id)).body).toBe("count me in");
  });

  red("update with read edits, and can't delete or create", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read", "update"] } });
    const bo = await as(key);
    expect((await bo.edit(soup.body.id, { body: "better soup" })).status).toBe(200);
    expect((await now(soup.body.id)).body).toBe("better soup");
    notGranted(await bo.remove(soup.body.id), "delete", recipe);
    expect((await owner.get(soup.body.id)).status).toBe(200);
    notGranted(await bo.make({ types: [recipe], body: "bread" }), "create", recipe);
  });

  red("delete with read deletes, and can't update or create", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const [soup, stew] = [await owner.make({ types: [recipe], body: "soup" }), await owner.make({ types: [recipe], body: "stew" })];
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read", "delete"] } });
    const bo = await as(key);
    notGranted(await bo.edit(stew.body.id, { body: "changed" }), "update", recipe);
    expect((await now(stew.body.id)).body).toBe("stew");
    expect((await bo.remove(soup.body.id)).status).toBe(200);
    expect((await owner.get(soup.body.id)).status).toBe(404);
    notGranted(await bo.make({ types: [recipe], body: "bread" }), "create", recipe);
  });
});

describe("own records", () => {
  red("create, read:own and update:own: the grantee sees and edits only what it made", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const ownersSoup = await owner.make({ types: [recipe], body: "the owner's soup" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["create", "read:own", "update:own"] } });
    const bo = await as(key);
    const mine = await bo.make({ types: [recipe], body: "my soup" });
    expect(mine.status).toBe(201);
    expect((await bo.get(mine.body.id)).status).toBe(200);
    expect(ids(await bo.list({ type: recipe }))).toEqual([mine.body.id]);
    expect((await bo.edit(mine.body.id, { body: "my better soup" })).status).toBe(200);
    expect((await now(mine.body.id)).body).toBe("my better soup");
    // The owner's record of the same type doesn't exist for it.
    expect((await bo.get(ownersSoup.body.id)).status).toBe(404);
    expect((await bo.edit(ownersSoup.body.id, { body: "mine now" })).status).toBe(404);
    expect((await now(ownersSoup.body.id)).body).toBe("the owner's soup");
  });

  red("read with update:own and delete:own reads every record of the type, and edits and deletes only its own", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const ownersSoup = await owner.make({ types: [recipe], body: "the owner's soup" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read", "create", "update:own", "delete:own"] } });
    const bo = await as(key);
    const mine = await bo.make({ types: [recipe], body: "my soup" });
    expect(mine.status).toBe(201);
    expect(ids(await bo.list({ type: recipe }))).toEqual([mine.body.id, ownersSoup.body.id].sort());
    expect((await bo.edit(mine.body.id, { body: "my better soup" })).status).toBe(200);
    // Visible and not its own: refused with the reason, not hidden.
    notGranted(await bo.edit(ownersSoup.body.id, { body: "mine now" }), "update", recipe);
    notGranted(await bo.remove(ownersSoup.body.id), "delete", recipe);
    expect((await now(ownersSoup.body.id)).body).toBe("the owner's soup");
    expect((await bo.remove(mine.body.id)).status).toBe(200);
    expect((await owner.get(mine.body.id)).status).toBe(404);
  });

  red("was carries own-ness to a new grant for the same key; a new grant without it starts with nothing", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const key = await newKey();
    const first = await granted({ to: key, types: { [recipe]: ["create", "read:own"] } });
    const made = await (await as(key)).make({ types: [recipe], body: "made under the first grant" });
    expect(made.status).toBe(201);
    expect(rec(made.body).via).toBe(`grant:${first.grantId}`);
    // The first grant ends; a second, under a new id, names it in `was`.
    expect((await file(await revokeEvent(first))).status).toBe(201);
    const second = await granted({ to: key, types: { [recipe]: ["read:own", "update:own"] }, was: [`grant:${first.grantId}`] });
    const carried = await as(key);
    expect((await carried.get(made.body.id)).status).toBe(200);
    expect((await carried.edit(made.body.id, { body: "still mine" })).status).toBe(200);
    // A third, with no `was`, doesn't own it.
    expect((await file(await revokeEvent(second))).status).toBe(201);
    await granted({ to: key, types: { [recipe]: ["read:own", "update:own"] } });
    const fresh = await as(key);
    expect((await fresh.get(made.body.id)).status).toBe(404);
    expect(ids(await fresh.list({ type: recipe }))).toEqual([]);
  });

  red("a replacement under the same id can't add to or change was, so it can't claim what an older grant made", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const key = await newKey();
    // Two earlier grants for the key, one after the other; only the first one's grantee writes.
    const first = await granted({ to: key, types: { [recipe]: ["create", "read:own"] } });
    const made = await (await as(key)).make({ types: [recipe], body: "made under the first grant" });
    expect(made.status).toBe(201);
    expect((await file(await revokeEvent(first))).status).toBe(201);
    const second = await granted({ to: key, types: { [recipe]: ["read:own"] } });
    expect((await file(await revokeEvent(second))).status).toBe(201);
    // The grant in force carries on from the second only.
    const third = await granted({ to: key, types: { [recipe]: ["read:own", "update:own"] }, was: [`grant:${second.grantId}`] });
    const changed = await grantEvent({ id: third.grantId, to: key, types: { [recipe]: ["read:own", "update:own"] }, was: [`grant:${first.grantId}`], created_at: third.created_at + 1 });
    const added = await grantEvent({ id: third.grantId, to: key, types: { [recipe]: ["read:own", "update:own"] }, was: [`grant:${second.grantId}`, `grant:${first.grantId}`], created_at: third.created_at + 2 });
    for (const e of [changed, added]) {
      const r = await file(e);
      expect(r.status, r.text.slice(0, 200)).toBe(409);
      expect(r.body.error).toBe("id_taken");
    }
    expect((await grantRow(third.grantId))?.event.sig).toBe(third.sig);
    // Nothing moved: the first grant's record still isn't this grant's own.
    const bo = await as(key);
    expect((await bo.get(made.body.id)).status).toBe(404);
    expect((await bo.edit(made.body.id, { body: "mine now" })).status).toBe(404);
    expect((await now(made.body.id)).body).toBe("made under the first grant");
  });
});

describe("which records a grant reaches", () => {
  red("a type covers its subtypes", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const sub = await declareSubtype(recipe, "sub");
    const child = await owner.make({ types: [sub], body: "a soup of a kind" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read", "update"] } });
    const bo = await as(key);
    expect((await bo.get(child.body.id)).status).toBe(200);
    expect(ids(await bo.list({ type: recipe }))).toContain(child.body.id);
    expect((await bo.edit(child.body.id, { body: "edited through the parent" })).status).toBe(200);
  });

  red("a record carrying a denied tag is outside the grant for every verb: taking the tag off is 404 (the record is hidden), putting it on is 403 not_granted", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const secret = runId("private");
    const held = await owner.make({ types: [recipe], tags: [secret], body: "grandma's soup" });
    const open = await owner.make({ types: [recipe], body: "plain soup" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read", "create", "update", "delete"] }, deny: [secret] });
    const bo = await as(key);
    expect((await bo.get(held.body.id)).status).toBe(404);
    expect(ids(await bo.list({ type: recipe }))).toEqual([open.body.id]);
    expect((await bo.edit(held.body.id, { body: "changed" })).status).toBe(404);
    expect((await bo.remove(held.body.id)).status).toBe(404);
    // Taking the tag off would need the record, which it can't see.
    expect((await bo.edit(held.body.id, { remove: [secret] })).status).toBe(404);
    expect(await now(held.body.id)).toMatchObject({ body: "grandma's soup", names: [recipe, secret].sort() });
    // Putting it on a record it can see, or making one with it, is refused with the reason and changes nothing.
    for (const r of [await bo.edit(open.body.id, { add: [secret] }), await bo.make({ types: [recipe], tags: [secret], body: "sneaky" })]) {
      expect(r.status, r.text.slice(0, 200)).toBe(403);
      expect(r.body.error).toBe("not_granted");
    }
    expect((await now(open.body.id)).names).toEqual([recipe]);
    expect(ids(await owner.list({ type: secret }))).toEqual([held.body.id]);
  });

  red("adding a type needs create on it and removing one needs delete on it, so a record can't be moved in or out", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, pantry, menu] = [await declareType("recipe"), await declareType("pantry"), await declareType("menu")];
    const soup = await owner.make({ types: [recipe], body: "soup" });
    const stocked = await owner.make({ types: [recipe, pantry], body: "stocked soup" });
    const listed = await owner.make({ types: [recipe, menu], body: "soup on the menu" });
    const key = await newKey();
    // pantry: no create, no delete. menu: create and delete.
    await granted({ to: key, types: { [recipe]: ["read", "update"], [pantry]: ["read", "update"], [menu]: ["read", "create", "delete"] } });
    const bo = await as(key);
    notGranted(await bo.edit(soup.body.id, { add: [pantry] }), "create", pantry);
    expect((await now(soup.body.id)).names).toEqual([recipe]);
    notGranted(await bo.edit(stocked.body.id, { remove: [pantry] }), "delete", pantry);
    expect((await now(stocked.body.id)).names).toEqual([recipe, pantry].sort());
    // A new record needs create on every type it carries.
    notGranted(await bo.make({ types: [menu, pantry], body: "new" }), "create", pantry);
    // With the verb, the same moves are taken.
    expect((await bo.edit(soup.body.id, { add: [menu] })).status).toBe(200);
    expect((await now(soup.body.id)).names).toEqual([recipe, menu].sort());
    expect((await bo.edit(listed.body.id, { remove: [menu] })).status).toBe(200);
    expect((await now(listed.body.id)).names).toEqual([recipe]);
  });

  red("grants only add: a record with two types is visible when either is granted", { reason: NO_GRANTS, lane: LANE }, async () => {
    const [recipe, journal] = [await declareType("recipe"), await declareType("journal")];
    const both = await owner.make({ types: [recipe, journal], body: "cooked it, felt good" });
    const onlyJournal = await owner.make({ types: [journal], body: "a private day" });
    const key = await newKey();
    await granted({ to: key, types: { [recipe]: ["read"] } });
    const bo = await as(key);
    expect((await bo.get(both.body.id)).status).toBe(200);
    expect(ids(await bo.list({ type: recipe }))).toEqual([both.body.id]);
    expect((await bo.get(onlyJournal.body.id)).status).toBe(404);
  });

  red('"*" covers records with no type; a grant on a type doesn\'t', { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const loose = await owner.make({ body: "no type at all" });
    const typed = await owner.make({ types: [recipe], body: "soup" });
    const all = await newKey();
    await granted({ to: all, types: { "*": ["read"] } });
    const everything = await as(all);
    expect((await everything.get(loose.body.id)).status).toBe(200);
    expect((await everything.get(typed.body.id)).status).toBe(200);
    const narrow = await newKey();
    await granted({ to: narrow, types: { [recipe]: ["read"] } });
    const some = await as(narrow);
    expect((await some.get(typed.body.id)).status).toBe(200);
    expect((await some.get(loose.body.id)).status).toBe(404);
  });
});
