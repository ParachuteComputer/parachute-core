import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { generateMcpTools } from "./mcp.js";
import { anyTermsQuery, fuseRanks, HYBRID_AUTO_DEFAULT, keywordTerms } from "./hybrid.js";
import type { EmbeddingProvider, EmbedInput, EmbedResult } from "./embedding/provider.js";
import { encodeVector, normalize } from "./embedding/vector-codec.js";

describe("fuseRanks (reciprocal rank fusion)", () => {
  it("puts a note both arms found above notes only one arm found", () => {
    const fused = fuseRanks({ keyword: ["a", "b", "c"], meaning: ["d", "c", "e"] });
    expect(fused[0]!.id).toBe("c");
    expect(fused[0]!.ranks).toEqual({ keyword: 3, meaning: 2 });
  });
  it("breaks score ties by the best single rank, so each arm's first hit leads", () => {
    const fused = fuseRanks({ keyword: ["a", "b"], meaning: ["x", "y"] });
    expect(fused.map((h) => h.id)).toEqual(["a", "x", "b", "y"]);
  });
  it("on a tie, the keyword hit goes first, whatever the ids (an exact name beats a near meaning)", () => {
    expect(fuseRanks({ keyword: ["z-exact"], meaning: ["a-near", "b"] })[0]!.id).toBe("z-exact");
  });
  it("works with one arm missing (no embeddings)", () => {
    expect(fuseRanks({ keyword: ["a", "b"] }).map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("the keyword arm's query", () => {
  it("drops stopwords and punctuation, ORs the rest, phrase-quoted", () => {
    expect(keywordTerms("When did I write about feeling stuck at work?")).toEqual(["write", "feeling", "stuck", "work"]);
    expect(anyTermsQuery("didn't the 18.6 plan")).toBe('"didn\'t" OR "18" OR "plan"');
  });
  it("is empty when only stopwords are left", () => {
    expect(anyTermsQuery("what was it about?")).toBe("");
  });
});

// Paths are neutral (path is indexed for keyword search). The embedder is the one outside system here: a fake that maps a few words onto axes.
const AXES = ["garden", "money", "family", "music"];
const SYNONYMS: Record<string, string> = { allotment: "garden", vegetables: "garden", budget: "money", salary: "money", kids: "family" };
class AxisProvider implements EmbeddingProvider {
  readonly name = "axis";
  readonly model = "axis-model";
  readonly dims = AXES.length;
  async embed(input: EmbedInput): Promise<EmbedResult> {
    const vectors = input.texts.map((t) => {
      const v = new Float32Array(AXES.length).fill(0.01);
      for (const w of t.toLowerCase().split(/\W+/)) {
        const axis = AXES.indexOf(SYNONYMS[w] ?? w);
        if (axis >= 0) v[axis]! += 1;
      }
      return v;
    });
    return { vectors, model: this.model, dims: this.dims };
  }
  async available() {
    return { ok: true };
  }
}

async function seed(store: SqliteStore, db: Database, provider?: AxisProvider) {
  const notes = [
    ["note-1", "Spring planting: tomatoes and beans in the allotment"],
    ["note-2", "Quarterly budget review and salary talk"],
    ["note-3", "Weekend with the kids at the lake"],
    ["note-4", "Plan the garden beds for next year"],
  ];
  for (const [path, content] of notes) {
    const n = await store.createNote(content!, { path: path! });
    if (provider) {
      const [v] = (await provider.embed({ texts: [content!] })).vectors;
      db.prepare(
        "INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)",
      ).run(n.id, encodeVector(normalize(v!)), provider.dims, provider.model, "h", new Date().toISOString());
    }
  }
}

describe("query-notes search_mode: hybrid (MCP door)", () => {
  it("finds a note by meaning that keyword search misses, and keeps the keyword hit", async () => {
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await seed(store, db, provider);
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;

    // Literal keyword search: every word must appear, so a question finds nothing.
    const literal = (await query.execute({ search: "when did I work on the vegetables", search_mode: "literal" })) as { notes: unknown[] };
    expect(literal.notes).toHaveLength(0);

    const res = (await query.execute({ search: "when did I work on the vegetables", search_mode: "hybrid", limit: 2 })) as
      | { path: string; matched_by: string[] }[]
      | { notes: { path: string; matched_by: string[] }[] };
    const notes = Array.isArray(res) ? res : res.notes;
    expect(notes[0]!.path).toBe("note-1");
    expect(notes[0]!.matched_by).toEqual(["meaning"]);

    const both = (await query.execute({ search: "garden", search_mode: "hybrid", limit: 1 })) as { path: string; matched_by: string[] }[];
    expect(both[0]!.path).toBe("note-4"); // keyword #1 (literal word) and meaning top-2
    expect(both[0]!.matched_by.sort()).toEqual(["keyword", "meaning"]);
  });

  it("auto: a question in plain words is answered by hybrid and says so; explicit literal keeps today's answer", async () => {
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await seed(store, db, provider);
    const query = generateMcpTools(store, { hybridAuto: true }).find((t) => t.name === "query-notes")!;
    const res = (await query.execute({ search: "when did I work on the vegetables" })) as {
      notes: { path: string; matched_by: string[] }[];
      warnings: { code: string }[];
    };
    expect(res.notes[0]!.path).toBe("note-1");
    expect(res.warnings.map((w) => w.code)).toContain("search_auto");
    const strict = (await query.execute({ search: "when did I work on the vegetables", search_mode: "literal" })) as { notes: unknown[] };
    expect(strict.notes).toHaveLength(0);
    // A question literal would answer too still goes hybrid (the auto rule, not an empty-only fallback).
    const q2 = (await query.execute({ search: "plan the garden beds for next year" })) as { notes: { path: string; matched_by: string[] }[]; warnings: { code: string }[] };
    expect(q2.warnings.map((w) => w.code)).toContain("search_auto");
    expect(q2.notes[0]!.path).toBe("note-4");
    expect(q2.notes[0]!.matched_by.sort()).toEqual(["keyword", "meaning"]);
    // A short search is untouched literal.
    const found = (await query.execute({ search: "budget" })) as { path: string; matched_by?: string[] }[];
    expect(found.map((n) => n.path)).toEqual(["note-2"]);
    expect(found[0]!.matched_by).toBeUndefined();
  });

  it("the shipped default is off: HYBRID_AUTO_DEFAULT is false and a question without search_mode gets exactly the literal answer", async () => {
    expect(HYBRID_AUTO_DEFAULT).toBe(false);
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await seed(store, db, provider);
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    for (const search of ["when did I work on the vegetables", "plan the garden beds for next year"]) {
      const plain = await query.execute({ search });
      const literal = await query.execute({ search, search_mode: "literal" });
      expect(JSON.stringify(plain)).toBe(JSON.stringify(literal));
      expect(JSON.stringify(plain)).not.toContain("search_auto");
      expect(JSON.stringify(plain)).not.toContain("matched_by");
    }
  });

  it("a short search (an id, a code, a typo) keeps its empty answer; blank hybrid text is an empty search", async () => {
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await seed(store, db, provider);
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const notesOf = (r: unknown) => (Array.isArray(r) ? r : (r as { notes: unknown[] }).notes);
    const codesOf = (r: unknown) => (Array.isArray(r) ? [] : ((r as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code));
    const short = await query.execute({ search: "vegetables" });
    expect(notesOf(short)).toHaveLength(0);
    expect(codesOf(short)).not.toContain("search_auto");
    const title = await query.execute({ search: "Garden Plan 2026" }); // a 3-word title: an existence check
    expect(codesOf(title)).not.toContain("search_auto");
    const fewWords = await query.execute({ search: "what was it about the vegetables" }); // 6 words, 1 content word
    expect(codesOf(fewWords)).not.toContain("search_auto");
    const stop = (await query.execute({ search: "what was it about", search_mode: "hybrid" })) as { notes: unknown[]; warnings: { code: string }[] };
    expect(stop.notes).toHaveLength(0);
    expect(stop.warnings.map((w) => w.code)).toContain("empty_search");
    const url = await query.execute({ search: "https://example.com/garden" });
    expect(notesOf(url)).toHaveLength(0);
    expect(codesOf(url)).not.toContain("search_auto");
    const blank = (await query.execute({ search: "  ", search_mode: "hybrid" })) as { notes: unknown[]; warnings: { code: string }[] };
    expect(blank.notes).toHaveLength(0);
    expect(blank.warnings.map((w) => w.code)).toContain("empty_search");
  });

  it("on a vault without embeddings a question stays literal (no hybrid, no extra work)", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await seed(store, db);
    let calls = 0;
    const real = store.hybridSearch.bind(store);
    store.hybridSearch = (...a: Parameters<typeof real>) => (calls++, real(...a));
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const r = await query.execute({ search: "when did I work on the vegetables" });
    expect(Array.isArray(r) ? r : (r as { notes: unknown[] }).notes).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("a provider that is configured but failing: a question gets today's literal answer, and auto stops retrying", async () => {
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    await seed(store, db, provider);
    provider.embed = async () => {
      throw new Error("model failed to load");
    };
    const query = generateMcpTools(store, { hybridAuto: true }).find((t) => t.name === "query-notes")!;
    const r = await query.execute({ search: "plan the garden beds for next year" });
    const notes = (Array.isArray(r) ? r : (r as { notes: { path: string; matched_by?: string[] }[] }).notes) as { path: string; matched_by?: string[] }[];
    expect(notes.map((n) => n.path)).toEqual(["note-4"]);
    expect(notes[0]!.matched_by).toBeUndefined();
    expect(Array.isArray(r) ? [] : ((r as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code)).not.toContain("search_auto");
    expect(store.hasMeaningSearch()).toBe(false);
  });

  it("without embeddings answers by keyword alone and says so", async () => {
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    await seed(store, db);
    const query = generateMcpTools(store).find((t) => t.name === "query-notes")!;
    const res = (await query.execute({ search: "budget talk", search_mode: "hybrid" })) as {
      notes: { path: string }[];
      warnings: { code: string }[];
    };
    expect(res.notes.map((n) => n.path)).toEqual(["note-2"]);
    expect(res.warnings.map((w) => w.code)).toContain("semantic_unavailable");
  });
});

describe("tag scope: both arms run under `visible` before they rank and limit", () => {
  // Six garden notes that are NOT visible and rank first for the question, three visible ones that rank after them.
  async function scopedSeed() {
    const db = new Database(":memory:");
    const provider = new AxisProvider();
    const store = new SqliteStore(db, { embeddingProvider: provider });
    const make = async (content: string, path: string, tag: string, embed = true) => {
      const n = await store.createNote(content, { path, tags: [tag] });
      if (!embed) return n;
      const [v] = (await provider.embed({ texts: [content] })).vectors;
      db.prepare(
        "INSERT INTO note_vectors (note_id, chunk_ix, vector, dims, model, content_hash, embedded_at) VALUES (?, 0, ?, ?, ?, ?, ?)",
      ).run(n.id, encodeVector(normalize(v!)), provider.dims, provider.model, "h", new Date().toISOString());
      return n;
    };
    const hidden: string[] = [];
    for (let i = 0; i < 6; i++) hidden.push((await make(`garden garden vegetables allotment plan ${i}`, `hidden-${i}`, "other")).id);
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) mine.push((await make(`garden allotment diary ${i}`, `mine-${i}`, "mine")).id);
    // Two more of mine and one hidden that were never embedded: the counts must not include the hidden one.
    mine.push((await make("allotment shed diary", "mine-late", "mine", false)).id);
    hidden.push((await make("allotment shed secret", "hidden-late", "other", false)).id);
    const visible = (n: { tags?: string[] }) => (n.tags ?? []).includes("mine");
    return { store, mine, hidden, visible };
  }

  it("a scoped caller gets a full page of in-scope notes, from both arms, and nothing else", async () => {
    const { store, mine, hidden, visible } = await scopedSeed();
    // Unscoped, the hidden notes take the whole first page: that is what a cut after the limit would leave empty.
    const open = await store.hybridSearch("garden allotment vegetables plan", { limit: 3 });
    expect(open.notes.every((n) => hidden.includes(n.id))).toBe(true);
    const scoped = await store.hybridSearch("garden allotment vegetables plan", { limit: 3, visible });
    expect(scoped.notes).toHaveLength(3);
    expect(scoped.notes.every((n) => mine.includes(n.id))).toBe(true);
    expect(scoped.meaning).toBe("ok");
    // Counts are over what the caller can see: 4 visible candidates, 1 of them without a vector.
    expect(scoped.totalCandidates).toBe(4);
    expect(scoped.pendingCount).toBe(1);
  });

  it("the answer does not depend on notes the caller can't see (scores and order are the same without them)", async () => {
    const a = await scopedSeed();
    const b = await scopedSeed();
    for (const id of b.hidden) await b.store.deleteNote(id);
    const q = "garden allotment vegetables plan";
    const ra = await a.store.hybridSearch(q, { limit: 10, visible: a.visible });
    const rb = await b.store.hybridSearch(q, { limit: 10, visible: b.visible });
    const shape = (r: typeof ra) => r.notes.map((n) => [n.path, n.score, n.matched_by]);
    expect(shape(ra)).toEqual(shape(rb));
  });

  it("plain meaning search is ranked over the visible notes too (a full page, counts over the visible)", async () => {
    const { store, mine, visible } = await scopedSeed();
    const r = await store.semanticSearch("garden allotment vegetables plan", { limit: 3, visible });
    expect(r.notes).toHaveLength(3);
    expect(r.notes.every((n) => mine.includes(n.id))).toBe(true);
    expect(r.totalCandidates).toBe(4);
  });
});
