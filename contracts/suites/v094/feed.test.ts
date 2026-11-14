// v094/feed: the feed (ROADMAP 0.9.4; T-471, PLAN-0.9.4 PR 3). A reader asks for the changes after the position it
// holds; the server keeps that position per (key, reader), and a read never moves it, so a reader that crashes before
// committing reads the same page again. Each record appears once per page, at its newest change: upsert (with the
// record, as GET /api/records/<id> renders it), delete, or removed (it left a tag-scoped reader's scope: the id only).
// A tag-scoped reader never learns of a record that was always outside its scope. Black box: HTTP to the candidate's
// hub, keys minted by name, tag-scoped passes from the operator. Made-up data.
//
// Not here, and why: positions surviving a restart of the box (the shared box can't be restarted from a suite; the
// positions are rows in the vault's own SQLite file, and core/src/feed.test.ts reopens the file to show they stay),
// and a position behind the horizon answering 410 (the log keeps at least a day, and a suite can't age rows; covered
// by core/src/feed.test.ts with a forced sweep).
//
// Red on PR 1 (write sets): /api/feed and /api/feed/position are 404.
import { beforeAll, describe, expect, test } from "bun:test";
import { must, pass } from "../lib.ts";
import { adminPass, call, enc, mintKey, s, shortId, type Answer, type Key } from "./_keys.ts";

let writer: Key; // the key whose writes the feed carries (an AI's, say)
let reader: Key; // a key that reads the feed
let other: Key; // another key, to show positions are per key
let admin: Key;

beforeAll(async () => {
  writer = await mintKey("feed-writer", "write");
  reader = await mintKey("feed-reader", "read");
  other = await mintKey("feed-other", "read");
  admin = await adminPass();
});

/** A key from a bare token (a tag-scoped pass). */
const asKey = (token: string): Key => ({
  name: "",
  token,
  api: (method, path, body, headers = {}) => call(`/vault/${s.vaultName}/api${path}`, { method, auth: `Bearer ${token}`, body, headers }),
});

const readerName = (label: string) => `${label}-${shortId()}`;

async function feed(k: Key, name: string, query = ""): Promise<Answer> {
  const r = await k.api("GET", `/feed?reader=${enc(name)}${query.includes("limit=") ? "" : "&limit=500"}${query}`);
  must(r.status === 200, `GET /feed?reader=${name}${query}: ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}
async function commit(k: Key, name: string, position: number | string): Promise<number> {
  const r = await k.api("POST", "/feed/position", { reader: name, position });
  must(r.status === 200, `POST /feed/position ${name} ${position}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body.position as number;
}
async function create(path: string, content: string, tags: string[] = []): Promise<string> {
  const r = await writer.api("POST", "/notes", { path, content, ...(tags.length ? { tags } : {}) });
  must(r.status === 201, `create ${path}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body.id as string;
}
async function edit(id: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const r = await writer.api("PATCH", `/notes/${enc(id)}`, { ...body, force: true }, headers);
  must(r.status === 200, `edit ${id}: ${r.status} ${r.text.slice(0, 300)}`);
}
async function remove(id: string, headers: Record<string, string> = {}): Promise<void> {
  const r = await writer.api("DELETE", `/notes/${enc(id)}`, undefined, headers);
  must(r.status === 200, `delete ${id}: ${r.status} ${r.text.slice(0, 300)}`);
}
/** The page's entries about these records, in page order. */
const about = (page: Answer, ids: string[]) => (page.body.changes as any[]).filter((c) => ids.includes(c.id));

describe("v094/feed: each change once, in order, and the position moves only on commit", () => {
  test("a fresh reader starts at 0; create, edit and delete arrive once, in order; a re-read gives the same page; after commit, nothing", async () => {
    const t = `fd${shortId()}`;
    const name = readerName("fresh");
    const fresh = await feed(reader, name, "&limit=1");
    expect(fresh.body.position).toBe(0);
    const edited = await create(`${t}/edited`, "before");
    const deleted = await create(`${t}/deleted`, "soon gone");
    await commit(reader, name, "now");
    const created = await create(`${t}/created`, "new words", [t]);
    await edit(edited, { content: "after" });
    await remove(deleted);
    const ids = [created, edited, deleted];

    const page = await feed(reader, name);
    const mine = about(page, ids);
    expect(mine.map((c) => [c.id, c.op])).toEqual([[created, "upsert"], [edited, "upsert"], [deleted, "delete"]]);
    expect(mine[0].seq).toBeLessThan(mine[1].seq);
    expect(mine[1].seq).toBeLessThan(mine[2].seq);
    // The record, in record words (as GET /api/records/<id> renders it), and who wrote it.
    const asRecord = (await reader.api("GET", `/records/${enc(created)}`)).body;
    expect(mine[0].record).toEqual(asRecord);
    expect(mine[0].record.body).toBe("new words");
    expect(mine[1].record.body).toBe("after");
    expect(mine[2].record).toBeUndefined();
    for (const c of mine) expect(c).toMatchObject({ by: expect.anything(), via: `key:${writer.name}`, write_set: expect.stringMatching(/^ws_/), at: expect.any(String) });
    // Each record once.
    expect(new Set(mine.map((c) => c.id)).size).toBe(3);

    // A read doesn't move the position: the same page again.
    const again = await feed(reader, name);
    expect(again.body.position).toBe(page.body.position);
    expect(about(again, ids)).toEqual(mine);
    expect(again.body.next_position).toBe(page.body.next_position);

    // After commit: nothing about these records, and the position is held.
    expect(await commit(reader, name, page.body.next_position)).toBe(page.body.next_position);
    const after = await feed(reader, name);
    expect(after.body.position).toBe(page.body.next_position);
    expect(about(after, ids)).toEqual([]);
    expect(after.body.more).toBe(false);
  });

  test("a record changed twice in one page appears once, at its newest change", async () => {
    const t = `fd${shortId()}`;
    const name = readerName("twice");
    const twice = await create(`${t}/twice`, "v1");
    await commit(reader, name, "now");
    await edit(twice, { content: "v2" });
    const between = await create(`${t}/between`, "made between the two edits");
    await edit(twice, { content: "v3" });
    const mine = about(await feed(reader, name), [twice, between]);
    expect(mine.map((c) => c.id)).toEqual([between, twice]);
    expect(mine[1].record.body).toBe("v3");
    expect(mine[1].seq).toBeGreaterThan(mine[0].seq);
  });

  test("resume: a commit midway (or ?ack= on the read) and the next read starts after it", async () => {
    const t = `fd${shortId()}`;
    const name = readerName("resume");
    await commit(reader, name, "now");
    const one = await create(`${t}/one`, "one");
    const two = await create(`${t}/two`, "two");
    const first = await feed(reader, name, "&limit=1");
    expect(first.body.changes.map((c: any) => c.id)).toEqual([one]);
    expect(first.body.more).toBe(true);
    // Commit and read in one trip.
    const second = await feed(reader, name, `&limit=1&ack=${first.body.next_position}`);
    expect(second.body.position).toBe(first.body.next_position);
    expect(second.body.changes.map((c: any) => c.id)).toEqual([two]);
    await commit(reader, name, second.body.next_position);
    const three = await create(`${t}/three`, "three");
    const third = await feed(reader, name);
    expect(about(third, [one, two, three]).map((c) => c.id)).toEqual([three]);
  });

  test("a position past the newest is refused; now and 0 are taken; a bad reader name is refused; a read key may commit", async () => {
    const name = readerName("bounds");
    const now = await commit(reader, name, "now");
    expect(typeof now).toBe("number");
    const past = await reader.api("POST", "/feed/position", { reader: name, position: now + 1000 });
    expect(past.status).toBe(400);
    expect((await feed(reader, name)).body.position).toBe(now);
    expect(await commit(reader, name, 0)).toBe(0);
    expect((await reader.api("POST", "/feed/position", { reader: name, position: -1 })).status).toBe(400);
    expect((await reader.api("POST", "/feed/position", { reader: name, position: "soon" })).status).toBe(400);
    expect((await reader.api("GET", "/feed?reader=has%20a%20space")).status).toBe(400);
    expect((await reader.api("POST", "/feed/position", { reader: "x".repeat(65), position: 0 })).status).toBe(400);
    // `reader` defaults to `default`.
    expect((await reader.api("POST", "/feed/position", { position: "now" })).status).toBe(200);
    expect((await reader.api("GET", "/feed?limit=1")).status).toBe(200);
  });
});

describe("v094/feed: a tag-scoped reader sees its scope and nothing else", () => {
  const SECRET = "made-up-secret-feed-7f3a";

  test("in scope: created, edited, then moved out (removed, the id only); never a record that was always out", async () => {
    const t = `fs${shortId()}`;
    const mine = `${t}mine`;
    const elsewhere = `${t}else`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("scoped");
    const start = await commit(scoped, name, "now");
    const inside = await create(`${t}/inside`, "in scope", [mine]);
    const outside = await create(`${t}/outside`, `out of scope ${SECRET}`, [elsewhere]);
    await edit(inside, { content: "in scope, edited" });
    await edit(outside, { content: `still out ${SECRET}` });

    const page = await feed(scoped, name);
    expect(about(page, [inside]).map((c) => [c.op, c.record?.body])).toEqual([["upsert", "in scope, edited"]]);
    must(!page.text.includes(outside), "the feed named a record that was always outside the reader's scope");
    must(!page.text.includes(SECRET), "the feed carried the content of a record outside the reader's scope");
    // Provenance stays hidden from a scoped reader, as on versions.
    for (const c of page.body.changes as any[]) for (const k of ["by", "via", "write_set"]) expect(Object.keys(c)).not.toContain(k);
    await commit(scoped, name, page.body.next_position);

    // Moved out: removed, and nothing else about it.
    await edit(inside, { content: `moved out ${SECRET}`, tags: { add: [elsewhere], remove: [mine] } });
    const left = await feed(scoped, name);
    const gone = about(left, [inside]);
    expect(gone.map((c) => c.op)).toEqual(["removed"]);
    expect(Object.keys(gone[0]).sort()).toEqual(["id", "op", "seq"]);
    must(!left.text.includes(SECRET), "a removed entry carried the record's new content");
    expect(start).toBeLessThan(left.body.next_position);
  });

  test("a delete of an out-of-scope record doesn't arrive; a delete of an in-scope one does", async () => {
    const t = `fs${shortId()}`;
    const mine = `${t}mine`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("deletes");
    const inside = await create(`${t}/inside`, "in scope", [mine]);
    const outside = await create(`${t}/outside`, "out of scope", [`${t}else`]);
    await commit(scoped, name, "now");
    await remove(outside);
    await remove(inside);
    const page = await feed(scoped, name);
    expect(about(page, [inside]).map((c) => c.op)).toEqual(["delete"]);
    must(!page.text.includes(outside), "the feed told a scoped reader about the delete of a record it never could see");
  });

  test("next_position and more say no more than a scope-blind reader of the same log", async () => {
    const t = `fs${shortId()}`;
    const mine = `${t}mine`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("blind");
    const p = await commit(scoped, name, "now");
    await commit(reader, name, p);
    const outside = await create(`${t}/outside`, "out of scope", [`${t}else`]);
    const inside = await create(`${t}/inside`, "in scope", [mine]);
    // A page of one: the scoped reader's is empty (the row is out of scope) yet moves on exactly as the unscoped one.
    const s1 = await feed(scoped, name, "&limit=1");
    const u1 = await feed(reader, name, "&limit=1");
    expect(s1.body.changes).toEqual([]);
    must(JSON.stringify(u1.body.changes.map((c: any) => c.id)) === JSON.stringify([outside]), `unscoped page: ${JSON.stringify(u1.body).slice(0, 1500)}`);
    expect([s1.body.next_position, s1.body.more]).toEqual([u1.body.next_position, u1.body.more]);
    must(!s1.text.includes(outside), "an empty page named the out-of-scope record");
    const s2 = await feed(scoped, name, `&limit=1&ack=${s1.body.next_position}`);
    expect(s2.body.changes.map((c: any) => c.id)).toEqual([inside]);
  });

  test("a tag put under the scope later brings its records in", async () => {
    const t = `fs${shortId()}`;
    const mine = `${t}mine`;
    const later = `${t}later`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("later");
    await commit(scoped, name, "now");
    const brought = await create(`${t}/brought`, "under a tag outside the scope, for now", [later]);
    const before = await feed(scoped, name);
    must(!before.text.includes(brought), "the feed named a record outside the scope");
    await commit(scoped, name, before.body.next_position);
    const put = await admin.api("PUT", `/tags/${enc(later)}?force=true`, { parent_names: [mine] });
    must(put.status === 200, `re-parent: ${put.status} ${put.text.slice(0, 300)}`);
    await edit(brought, { content: "now under the scope" });
    const after = await feed(scoped, name);
    expect(about(after, [brought]).map((c) => [c.op, c.record?.body])).toEqual([["upsert", "now under the scope"]]);
  });
});

describe("v094/feed: a write set that spans several requests, read by a tag-scoped reader", () => {
  // A client groups several requests into one write set with Parachute-Write-Set. Each request's writes are placed
  // in the log when they commit, so a reader that committed between two of them still hears of the later ones.
  const setHeader = () => ({ "Parachute-Write-Set": `feedset-${shortId()}${shortId()}` });
  const ops = (changes: any[], id: string) => changes.filter((c) => c.id === id).map((c) => c.op);

  test("a commit between two requests of one set: the later delete and move out still arrive", async () => {
    const t = `fw${shortId()}`;
    const mine = `${t}mine`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("spans");
    const r1 = await create(`${t}/r1`, "one", [mine]);
    const r2 = await create(`${t}/r2`, "two", [mine]);
    await commit(scoped, name, "now");
    const h = setHeader();
    await edit(r1, { content: "one, edited" }, h);
    await edit(r2, { content: "two, edited" }, h);
    const first = await feed(scoped, name);
    expect(about(first, [r1, r2]).map((c) => [c.id, c.op])).toEqual([[r1, "upsert"], [r2, "upsert"]]);
    await commit(scoped, name, first.body.next_position);
    await remove(r1, h);
    await edit(r2, { tags: { add: [`${t}else`], remove: [mine] } }, h);
    const second = await feed(scoped, name);
    expect(about(second, [r1, r2]).map((c) => [c.id, c.op])).toEqual([[r1, "delete"], [r2, "removed"]]);
  });

  test("paging by one ends where one page of 500 does", async () => {
    const t = `fw${shortId()}`;
    const mine = `${t}mine`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const [big, small] = [readerName("big"), readerName("small")];
    const r = await create(`${t}/r`, "in scope", [mine]);
    const p = await commit(scoped, big, "now");
    await commit(scoped, small, p);
    const h = setHeader();
    await edit(r, { tags: { add: [`${t}else`], remove: [mine] } }, h); // the set moves it out
    await edit(r, { content: "edited by another write" }); // another set, still out
    await edit(r, { content: "edited by the first set again" }, h); // the set again
    const whole = ops((await feed(scoped, big)).body.changes, r);
    expect(whole).toEqual(["removed"]);
    const paged: string[] = [];
    let page = await feed(scoped, small, "&limit=1");
    for (let i = 0; i < 50; i++) {
      paged.push(...ops(page.body.changes, r));
      if (!page.body.more) break;
      page = await feed(scoped, small, `&limit=1&ack=${page.body.next_position}`);
    }
    // A page of one may say the same thing more than once (each transaction of a request is its own row); what the
    // reader ends up knowing must be the same.
    expect(paged.length).toBeGreaterThan(0);
    expect(paged.at(-1)).toBe(whole.at(-1));
  });

  test("a record out of scope at the reader's position, in scope only in between, leaves no id", async () => {
    const t = `fw${shortId()}`;
    const mine = `${t}mine`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const name = readerName("between");
    const r = await create(`${t}/r`, "out of scope", [`${t}else`]);
    const h = setHeader();
    await edit(r, { content: "the set's first edit" }, h);
    await commit(scoped, name, "now");
    await edit(r, { tags: { add: [mine] } }, h); // the set brings it in
    await edit(r, { tags: { remove: [mine] } }); // another write takes it out
    const page = await feed(scoped, name);
    must(!page.text.includes(r), `the feed named a record that was out of scope at the reader's position: ${page.text.slice(0, 400)}`);
  });
});

describe("v094/feed: a reader more than one page behind", () => {
  // A reader that commits each page and holds what it is told: upsert adds the record, delete and removed drop it.
  function holder(k: Key, name: string, ids: () => string[]) {
    const held = new Set<string>();
    const apply = (page: Answer) => {
      for (const c of page.body.changes as any[]) if (ids().includes(c.id)) c.op === "upsert" ? held.add(c.id) : held.delete(c.id);
    };
    return {
      held,
      /** One page of `limit`, committed. */
      async one(limit: number) {
        const page = await feed(k, name, `&limit=${limit}`);
        apply(page);
        await commit(k, name, page.body.next_position);
        return page.body.more as boolean;
      },
      async drain() {
        for (let i = 0; i < 100 && (await this.one(500)); i++);
      },
    };
  }

  for (const [label, last] of [
    ["deleted", async (id: string) => remove(id)],
    ["moved out", async (id: string, mine: string) => edit(id, { tags: { remove: [mine] } })],
  ] as const) {
    test(`a record brought into scope, a page of one read, then ${label}: the reader ends without it`, async () => {
      const t = `fb${shortId()}`;
      const mine = `${t}mine`;
      const scoped = asKey(await pass({ level: "read", tags: [mine] }));
      const name = readerName("behind");
      await commit(scoped, name, "now");
      const r = await create(`${t}/r`, "outside the scope at first", [`${t}else`]);
      await edit(r, { tags: { add: [mine] } });
      const h = holder(scoped, name, () => [r]);
      expect(await h.one(1)).toBe(true); // more after it: the reader is behind
      await last(r, mine);
      await h.drain();
      expect([...h.held]).toEqual([]);
    });
  }

  test("a reader paging by one between writes ends up holding what a reader of 500 holds", async () => {
    const t = `fb${shortId()}`;
    const mine = `${t}mine`;
    const other = `${t}else`;
    const scoped = asKey(await pass({ level: "read", tags: [mine] }));
    const ids: string[] = [];
    const [small, big] = [readerName("small"), readerName("big")];
    const p = await commit(scoped, small, "now");
    await commit(scoped, big, p);
    const hs = holder(scoped, small, () => ids);
    const hb = holder(scoped, big, () => ids);
    const steps: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < 4; i++) steps.push(async () => ids.push(await create(`${t}/n${i}`, `n${i}`, [i % 2 ? mine : other])));
    steps.push(
      () => edit(ids[0]!, { tags: { add: [mine] } }),
      () => edit(ids[1]!, { tags: { remove: [mine], add: [other] } }),
      () => edit(ids[2]!, { tags: { add: [mine] } }),
      () => remove(ids[2]!),
      () => remove(ids[3]!),
      () => edit(ids[0]!, { content: "edited" }),
      () => edit(ids[1]!, { tags: { add: [mine] } }),
    );
    for (const step of steps) {
      await step();
      await hs.one(1);
    }
    await hs.drain();
    await hb.drain();
    expect([...hs.held].sort()).toEqual([...hb.held].sort());
    expect([...hb.held].sort()).toEqual([ids[0]!, ids[1]!].sort());
  });
});

describe("v094/feed: positions are per key and per reader", () => {
  test("two readers on one key keep separate positions", async () => {
    const t = `fp${shortId()}`;
    const [a, b] = [readerName("a"), readerName("b")];
    await commit(reader, a, "now");
    await commit(reader, b, "now");
    const x = await create(`${t}/x`, "x");
    const pageA = await feed(reader, a);
    await commit(reader, a, pageA.body.next_position);
    expect(about(await feed(reader, a), [x])).toEqual([]);
    expect(about(await feed(reader, b), [x]).map((c) => c.id)).toEqual([x]);
  });

  test("another key can neither see nor move a key's position", async () => {
    const name = readerName("shared");
    const held = await commit(reader, name, "now");
    expect(held).toBeGreaterThan(0);
    // The other key's reader of the same name is its own: fresh, at 0.
    expect((await feed(other, name, "&limit=1")).body.position).toBe(0);
    await commit(other, name, 0);
    expect((await feed(reader, name, "&limit=1")).body.position).toBe(held);
  });
});
