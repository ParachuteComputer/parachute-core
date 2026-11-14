/**
 * Timing for a tag-scoped keyword search (hybrid's keyword arm under a scoped pass): `bun src/scoped-search.bench.ts`.
 * Seeds N made-up notes (default 94000, 90% carrying the in-scope tag) into a cached file db, then times
 * searchNotes with the scoped `visible` predicate for an any-word question. Env: N, DB (path), RUNS.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { SqliteStore } from "../core/src/store.ts";
import { searchNotes } from "../core/src/notes.ts";
import { TagScopeSet, buildExpandVisibility } from "./tag-scope.ts";
import { anyTermsQuery } from "../core/src/hybrid.ts";

const N = Number(process.env.N ?? 94000);
const DB = process.env.DB ?? `${process.env.TMPDIR ?? "/tmp"}/scoped-search-${N}.db`;
const RUNS = Number(process.env.RUNS ?? 5);

const words = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}x`);
const common = ["plan", "week", "team", "garden", "review", "budget"];
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

if (!existsSync(DB)) {
  const db = new Database(DB);
  const store = new SqliteStore(db);
  const r = rng(7);
  const t0 = Date.now();
  for (let off = 0; off < N; off += 1000) {
    const batch = [];
    for (let i = off; i < Math.min(N, off + 1000); i++) {
      const body = Array.from({ length: 40 }, () => (r() < 0.3 ? common[Math.floor(r() * common.length)] : words[Math.floor(r() ** 2 * words.length)])).join(" ");
      batch.push({ content: `Note ${i} ${body}`, path: `n/${i}`, tags: r() < 0.9 ? ["mine"] : ["other"] });
    }
    await store.createNotes(batch as any);
  }
  console.log(`seeded ${N} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  db.close();
}

const db = new Database(DB);
const allowed = new TagScopeSet(["mine"]);
const visible = buildExpandVisibility(allowed, ["mine"])!;
const lineByLine = ((n: Parameters<typeof visible>[0]) => visible(n)) as typeof visible; // no byTag: the per-note path (what ran before)
const query = anyTermsQuery("what did the team plan for the garden budget review this week");
const time = (label: string, fn: () => unknown) => {
  const ts: number[] = [];
  let out: unknown;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    out = fn();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`${label}: median ${ts[Math.floor(ts.length / 2)]!.toFixed(0)} ms (min ${ts[0]!.toFixed(0)})`);
  return out;
};
time("unscoped", () => searchNotes(db, query, { mode: "advanced", limit: 50 }));
const before = time("scoped, per-note path (before)", () => searchNotes(db, query, { mode: "advanced", limit: 50, visible: lineByLine })) as { id: string; score?: number }[];
const scoped = time("scoped, SQL path (after)", () => searchNotes(db, query, { mode: "advanced", limit: 50, visible })) as { id: string; score?: number }[];
console.log(`same answer: ${JSON.stringify(before.map((n) => [n.id, n.score])) === JSON.stringify(scoped.map((n) => [n.id, n.score]))}`);
console.log(`first ids ${scoped.slice(0, 3).map((n) => n.id).join(",")}`);
