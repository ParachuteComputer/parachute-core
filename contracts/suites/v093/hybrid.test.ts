// 0.9.3 row 4, "Hybrid search for questions" (HYBRID-0.9.3.md contracts 1-6; T-461, T-463). `search_mode: "hybrid"` ranks
// a question by keyword (any of its content words) and by meaning (the vault's embeddings) together, fused by rank.
//
// Two runs of the same file, because a box has meaning search only when it is switched on:
//   bun run doors -- --doors box --embeddings suites/v093/hybrid.test.ts   the box embeds with the bundled model
//   bun run doors -- --doors box suites/v093/hybrid.test.ts                the box has no embedding provider (the default)
// The first runs the contracts that need real embeddings (the pinned model, nothing faked); the second runs the
// no-provider contract. Each run proves which mode it is in first, so a box set up wrong fails loudly rather than
// skipping. REST = MCP runs in both.
//
// `auto` (a question with no search_mode answered by hybrid) is built but off behind HYBRID_AUTO_DEFAULT (core/src/
// hybrid.ts) until Aaron says yes (DECIDED-HYBRID): its contract is `red()` and the "auto is off" contract guards the
// default. Flipping the constant removes the red() and replaces the "auto is off" contract in the same pull request.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { door, mcp, rest, runId, safeFetch, token, vaultUrl } from "../door/_door.ts";
import { must, red } from "../lib.ts";

const EMBEDDED = process.env.DOOR_EMBEDDINGS === "on";
const writer = rest("write");
const admin = rest("admin");

const r = runId("hy");
const T = `${r}t`; // the main corpus's tag
const MINE = `${r}mine`;
const OTHER = `${r}other`;
const rare = `zorbaquine${runId("w")}`;
const rareOther = `quillfeather${runId("w")}`;

// A question in plain words that shares no word with the note that answers it (so literal search finds nothing).
const QUESTION = "why did the crew alter its recurring sync weekday";
const MOVED = "We shifted the weekly team check-in from Monday to Thursday because Mondays were overloaded with deadlines.";

const corpus: [string, string][] = [
  ["schedule", MOVED],
  ["garden", "Compost heap needs turning every two weeks; the tomato seedlings go out after the last frost."],
  ["invoice", "Quarterly invoice for the printing supplier is due at the end of the month and must be approved by finance."],
  ["hike", "The ridge trail loop takes about four hours and the water source near the summit is unreliable."],
  ["recipe", "Slow-cooked lentil stew with smoked paprika, carrots and a spoon of tomato paste."],
  ["rare", `Replace the ${rare} gasket before restarting the pump.`],
];

// Scope: eight out-of-scope notes that answer the question better than any in-scope one, so a cut after the limit
// would leave a scoped caller with an empty or short page; six in-scope notes about other things.
const hiddenCount = 8;
const mineTopics = [
  "Notes on the school fair stall: lemonade, bunting and a cash tin.",
  "The bicycle needs a new chain and the brakes squeal on wet days.",
  "Draft of the neighbourhood newsletter: bins, parking, the street party.",
  "Seed order for spring: beans, courgettes and two kinds of lettuce.",
  "Choir rehearsal moved to the church hall for the winter term.",
  "A list of films to watch on rainy weekends.",
];

async function create(path: string, content: string, tags: string[]): Promise<string> {
  const made = await writer.post("/notes", { content, path, tags });
  if (made.status !== 201) throw new Error(`setup: creating ${path} gave ${made.status} ${JSON.stringify(made.body).slice(0, 300)}`);
  return made.body.id as string;
}

type Row = { id: string; path?: string; matched_by?: string[]; score?: number };
type Reply = { rows: Row[]; warnings: { code: string; message?: string }[]; raw: any };

/** One query as an MCP caller sees it: the rows, the warnings, and the reply as sent. */
async function ask(m: Awaited<ReturnType<typeof mcp>>, params: Record<string, unknown>, tool = "query-notes"): Promise<Reply> {
  const raw: any = await m.call(tool, params);
  const rows = (Array.isArray(raw) ? raw : (raw.notes ?? raw.records ?? [])) as Row[];
  return { rows, warnings: (Array.isArray(raw) ? [] : (raw.warnings ?? [])) as Reply["warnings"], raw };
}

/** Wait until every candidate of `tags` has a vector (the embedding worker runs behind writes). */
async function embedded(m: Awaited<ReturnType<typeof mcp>>, tags: string[], want: number): Promise<void> {
  const until = Date.now() + 100_000;
  let last = "";
  while (Date.now() < until) {
    try {
      const got = await ask(m, { near_text: "anything", semantic: true, tag: tags, limit: 50 });
      last = JSON.stringify(got.warnings.map((w) => w.code));
      if (got.rows.length >= want && !got.warnings.some((w) => w.code === "embeddings_pending")) return;
    } catch (err) {
      last = (err as Error).message.slice(0, 200);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`setup: ${want} notes were not embedded within 100 s (last: ${last})`);
}

const ids = (x: Reply | Row[]) => (Array.isArray(x) ? x : x.rows).map((n) => n.id);

let reader: Awaited<ReturnType<typeof mcp>>;
const idOf: Record<string, string> = {};

beforeAll(async () => {
  reader = await mcp("read");
  for (const [name, text] of corpus) idOf[name] = await create(`${r}/${name}`, text, [T]);
  if (EMBEDDED) {
    for (let i = 0; i < hiddenCount; i++) await create(`${r}/other-${i}`, `${MOVED} Reminder ${i}, kept for the record. ${i === 0 ? rareOther : ""}`, [OTHER]);
    for (const [i, text] of mineTopics.entries()) await create(`${r}/mine-${i}`, text, [MINE]);
    await embedded(reader, [T, MINE, OTHER], corpus.length + hiddenCount + mineTopics.length);
  }
}, 120_000);

afterAll(async () => {
  await reader?.close();
});

describe("hybrid: which mode this box is in", () => {
  test(`the box ${EMBEDDED ? "has" : "has no"} meaning search, as this run says`, async () => {
    let semantic: "ok" | string = "ok";
    try {
      await ask(reader, { near_text: "anything", semantic: true, limit: 1 });
    } catch (err) {
      semantic = (err as Error).message;
    }
    if (EMBEDDED) expect(semantic).toBe("ok");
    else must(/semantic_unavailable|requires an embedding provider/.test(semantic), `expected no meaning search; the probe said: ${semantic.slice(0, 200)}`);
  });
});

describe.skipIf(!EMBEDDED)("hybrid, with the bundled embeddings", () => {
  test("a plain-words question that literal search misses is found by meaning, and says so", async () => {
    const literal = await ask(reader, { search: QUESTION, search_mode: "literal", tag: T });
    expect(literal.rows).toEqual([]);
    const hybrid = await ask(reader, { search: QUESTION, search_mode: "hybrid", tag: T });
    must(hybrid.rows[0]?.id === idOf.schedule, `hybrid did not put the schedule note first: ${JSON.stringify(hybrid.rows.map((n) => [n.path, n.matched_by]))}`);
    expect(hybrid.rows[0]!.matched_by).toEqual(["meaning"]);
    expect(typeof hybrid.rows[0]!.score).toBe("number");
  });

  test("a rare exact word comes first, and the keyword arm found it", async () => {
    const hybrid = await ask(reader, { search: `what did we do about ${rare}`, search_mode: "hybrid", tag: T });
    must(hybrid.rows[0]?.id === idOf.rare, `the rare-word note is not first: ${JSON.stringify(hybrid.rows.map((n) => [n.path, n.matched_by]))}`);
    expect(hybrid.rows[0]!.matched_by).toContain("keyword");
  });

  test("with auto off, a search without search_mode answers exactly as search_mode literal (and says nothing of auto)", async () => {
    // The guard on the default (HYBRID_AUTO_DEFAULT = false): byte for byte, for a question, a rare word and a short search.
    for (const search of [QUESTION, `what did we do about ${rare}`, "weekly team check-in", "lentil stew"]) {
      const plain = await ask(reader, { search, tag: T });
      const literal = await ask(reader, { search_mode: "literal", search, tag: T });
      expect(JSON.stringify(plain.raw)).toBe(JSON.stringify(literal.raw));
      expect(JSON.stringify(plain.raw)).not.toContain("search_auto");
      expect(JSON.stringify(plain.raw)).not.toContain("matched_by");
    }
  });

  red(
    "auto: a 4+ word question with no search_mode is answered by hybrid and says so (search_auto)",
    { reason: /no search_auto warning/, lane: "0.9.3 hybrid auto default off until Aaron's yes" },
    async () => {
      const got = await ask(reader, { search: QUESTION, tag: T });
      must(got.warnings.some((w) => w.code === "search_auto"), `no search_auto warning: ${JSON.stringify(got.warnings)}; first: ${got.rows[0]?.path}`);
      expect(got.rows[0]!.id).toBe(idOf.schedule);
      // A short search stays literal, exactly as search_mode literal answers it.
      const short = await ask(reader, { search: "lentil stew", tag: T });
      expect(JSON.stringify(short.raw)).toBe(JSON.stringify((await ask(reader, { search: "lentil stew", search_mode: "literal", tag: T })).raw));
    },
    120_000,
  );
});

describe.skipIf(EMBEDDED)("hybrid, with no embedding provider", () => {
  test("hybrid answers by keyword alone with a semantic_unavailable warning, never an error", async () => {
    const got = await ask(reader, { search: "weekly team check-in deadlines overloaded", search_mode: "hybrid", tag: T });
    expect(got.rows[0]?.id).toBe(idOf.schedule);
    expect(got.rows.every((n) => (n.matched_by ?? []).join() === "keyword")).toBe(true);
    must(got.warnings.some((w) => w.code === "semantic_unavailable"), `no semantic_unavailable warning: ${JSON.stringify(got.warnings)}`);
  });

  test("a question with no search_mode never runs hybrid: the literal answer, no auto warning", async () => {
    for (const search of [QUESTION, "what did the team shift because of the deadlines"]) {
      const plain = await ask(reader, { search, tag: T });
      const literal = await ask(reader, { search_mode: "literal", search, tag: T });
      expect(JSON.stringify(plain.raw)).toBe(JSON.stringify(literal.raw));
      expect(JSON.stringify(plain.raw)).not.toContain("search_auto");
    }
  });
});

describe.skipIf(!EMBEDDED)("hybrid and tag scope (box: the scoped pass is minted over the hub's HTTP mint, by attenuation)", () => {
  let scoped: string;
  let scopedMcp: Awaited<ReturnType<typeof mcp>>;
  const mineIds = new Set<string>();
  const hiddenIds = new Set<string>();

  beforeAll(async () => {
    const d = door();
    const minter = await token("admin");
    const minted = await safeFetch(`${d.issuer}/api/auth/mint-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${minter}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: `vault:${d.vault}:read`, label: "hybrid-scope", permissions: { scoped_tags: [MINE] } }),
    });
    const body: any = await minted.json().catch(() => ({}));
    if (minted.status !== 200 || typeof body.token !== "string") throw new Error(`setup: minting a tag-scoped pass gave ${minted.status} ${JSON.stringify(body).slice(0, 200)}`);
    scoped = body.token;
    scopedMcp = await mcp("read", { bearer: scoped });
    const all = await ask(reader, { tag: [MINE, OTHER], limit: 100 });
    for (const n of all.rows) ((n.path ?? "").startsWith(`${r}/mine`) ? mineIds : hiddenIds).add(n.id);
  }, 60_000);

  afterAll(async () => {
    await scopedMcp?.close();
  });

  const restSearch = async (params: string) => {
    const res = await safeFetch(`${vaultUrl()}/api/notes?${params}`, { headers: { authorization: `Bearer ${scoped}` } });
    return { status: res.status, text: await res.text() };
  };

  test("setup is sharp: unscoped, the out-of-scope notes take the whole first page", async () => {
    const open = await ask(reader, { search: QUESTION, search_mode: "hybrid", tag: [MINE, OTHER], limit: 5 });
    expect(open.rows.length).toBe(5);
    must(open.rows.every((n) => hiddenIds.has(n.id)), `the first page is not all out-of-scope notes: ${JSON.stringify(open.rows.map((n) => n.path))}`);
  });

  test("a scoped session gets a full page of in-scope notes from hybrid, and nothing out of scope shows anywhere in the reply", async () => {
    const got = await ask(scopedMcp, { search: QUESTION, search_mode: "hybrid", limit: 5 });
    must(got.rows.length === 5, `a scoped caller's page is not full: ${got.rows.length} of 5 (${JSON.stringify(got.rows.map((n) => n.path))})`);
    expect(got.rows.every((n) => mineIds.has(n.id))).toBe(true);
    const text = JSON.stringify(got.raw);
    for (const leak of [OTHER, `${r}/other`, rareOther, ...hiddenIds]) expect(text).not.toContain(leak);
  });

  test("a word only out-of-scope notes hold finds nothing through the keyword arm", async () => {
    const got = await ask(scopedMcp, { search: `what did we do about ${rareOther}`, search_mode: "hybrid", limit: 5 });
    expect(got.rows.every((n) => mineIds.has(n.id))).toBe(true);
    expect(got.rows.some((n) => (n.matched_by ?? []).includes("keyword"))).toBe(false);
    expect(JSON.stringify(got.raw)).not.toContain(rareOther);
  });

  test("what a scoped session is told does not depend on notes it can't see (scores, order and warnings are the same without them)", async () => {
    const before = await ask(scopedMcp, { search: QUESTION, search_mode: "hybrid", limit: 6 });
    // Three more out-of-scope notes that hold the question's own words and the rare word.
    for (let i = 0; i < 3; i++) await create(`${r}/other-extra-${i}`, `${MOVED} ${rareOther} ${QUESTION} extra ${i}`, [OTHER]);
    await embedded(reader, [OTHER], hiddenCount + 3);
    const after = await ask(scopedMcp, { search: QUESTION, search_mode: "hybrid", limit: 6 });
    expect(JSON.stringify(after.raw)).toBe(JSON.stringify(before.raw));
  });

  test("meaning search (near_text) is ranked over what the session can see too: a full page, no out-of-scope note", async () => {
    const got = await ask(scopedMcp, { near_text: QUESTION, semantic: true, limit: 5 });
    must(got.rows.length === 5, `meaning search gave a scoped caller ${got.rows.length} of 5 (cut after the limit?)`);
    expect(got.rows.every((n) => mineIds.has(n.id))).toBe(true);
  });

  test("over REST the scoped pass gets the same full page", async () => {
    const res = await restSearch(`search=${encodeURIComponent(QUESTION)}&search_mode=hybrid&limit=5`);
    expect(res.status).toBe(200);
    const rows = JSON.parse(res.text) as Row[];
    must(rows.length === 5, `REST gave a scoped caller ${rows.length} of 5`);
    expect(rows.every((n) => mineIds.has(n.id))).toBe(true);
    for (const leak of [OTHER, rareOther]) expect(res.text).not.toContain(leak);
  });
});

describe("hybrid over REST answers the same ids as MCP", () => {
  const searches: [string, string][] = EMBEDDED ? [[QUESTION, "a question found by meaning"], [`what did we do about ${rare}`, "a rare word"]] : [["weekly team check-in deadlines overloaded", "a question by keyword"], [`what did we do about ${rare}`, "a rare word"]];
  for (const [search, label] of searches) {
    test(`/api/notes and /api/records, ${label}: the same ids in the same order as query-notes and query-records`, async () => {
      const q = `search=${encodeURIComponent(search)}&search_mode=hybrid&tag=${T}&limit=20`;
      const viaNotes = await admin.get(`/notes?${q}`);
      const viaRecords = await admin.get(`/records?${q}`);
      expect(viaNotes.status).toBe(200);
      expect(viaRecords.status).toBe(200);
      const m = await mcp("admin");
      try {
        const notes = await ask(m, { search, search_mode: "hybrid", tag: T, limit: 20 });
        const records = await ask(m, { search, search_mode: "hybrid", tag: T, limit: 20 }, "query-records");
        must(notes.rows.length > 0, "setup: MCP found nothing");
        expect((viaNotes.body as Row[]).map((n) => n.id)).toEqual(ids(notes));
        expect((viaRecords.body as Row[]).map((n) => n.id)).toEqual(ids(records));
        expect(ids(records)).toEqual(ids(notes));
        // The same matched_by too: each door says which arm found each note.
        expect((viaNotes.body as Row[]).map((n) => n.matched_by)).toEqual(notes.rows.map((n) => n.matched_by));
      } finally {
        await m.close();
      }
    });
  }

  test("an unknown search_mode is still refused, and the refusal lists hybrid", async () => {
    const res = await admin.get(`/notes?search=anything&search_mode=semantic`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("hybrid");
  });
});
