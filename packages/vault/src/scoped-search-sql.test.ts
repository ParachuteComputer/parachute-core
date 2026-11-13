/**
 * The scoped keyword search applies its visibility predicate as SQL (an EXISTS over note_tags) when the predicate
 * carries `byTag`. Property check: for random notes, tags, scopes, private tags and queries, that path and the
 * per-note path (the same predicate without `byTag`) return the same notes, in the same order, with the same scores.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { searchNotes } from "../core/src/notes.ts";
import type { Note } from "../core/src/types.ts";
import { TagScopeSet, buildExpandVisibility } from "./tag-scope.ts";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const TAGS = ["mine", "mine/sub", "other", "other/x", "secret", "secret/deep", "capture", "capture/voice", "plain", "a", "b"];
const WORDS = ["garden", "plan", "week", "budget", "team", "review", "music", "family", "stew", "frost", "ridge", "pump"];

describe("scoped keyword search, SQL visibility against the per-note predicate", () => {
  test("random vaults, scopes and queries give the same notes, order and scores", async () => {
    let compared = 0;
    let nonEmpty = 0;
    let withHidden = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 7919);
      const db = new Database(":memory:");
      const store = new SqliteStore(db);
      const inputs = [];
      for (let i = 0; i < 160; i++) {
        const tags = TAGS.filter(() => r() < 0.18);
        const body = Array.from({ length: 4 + Math.floor(r() * 12) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
        inputs.push({ content: `n${i} ${body}`, path: `p/${i}`, tags });
      }
      await store.createNotes(inputs as any);
      for (let k = 0; k < 8; k++) {
        const roots = TAGS.filter(() => r() < 0.25);
        if (roots.length === 0) roots.push("mine");
        const scope = new TagScopeSet(roots.filter(() => r() < 0.8)); // some roots are string-form only (not in the allowlist)
        scope.scopedRoots = roots;
        const priv = TAGS.filter(() => r() < 0.2);
        scope.privateTags = new Set(priv.filter((t) => !scope.has(t) && !roots.includes(t)));
        scope.privateRoots = priv.filter((t) => r() < 0.5 && !roots.includes(t));
        scope.denyAll = r() < 0.05;
        const visible = buildExpandVisibility(scope, roots)!;
        expect(typeof visible.byTag).toBe("function");
        const perNote = ((n: Note) => visible(n)) as typeof visible; // the same rule, without byTag
        const q = WORDS.filter(() => r() < 0.3).map((w) => `"${w}"`).join(" OR ") || '"garden"';
        const limit = 1 + Math.floor(r() * 30);
        const opts = { mode: "advanced" as const, limit, ...(r() < 0.3 ? { tags: [TAGS[Math.floor(r() * TAGS.length)]!] } : {}) };
        const a = searchNotes(db, q, { ...opts, visible });
        const b = searchNotes(db, q, { ...opts, visible: perNote });
        expect(a.map((n) => [n.id, n.score, n.tags])).toEqual(b.map((n) => [n.id, n.score, n.tags]));
        // Every returned note is visible by the predicate itself.
        for (const n of a) expect(perNote(n)).toBe(true);
        compared++;
        if (a.length > 0) nonEmpty++;
        const all = searchNotes(db, q, { mode: "advanced", limit: 500 });
        if (all.some((n) => !perNote(n))) withHidden++;
      }
      db.close();
    }
    // The comparison is sharp: most draws return notes, and most have hidden notes among the matches.
    expect(compared).toBe(96);
    expect(nonEmpty).toBeGreaterThan(50);
    expect(withHidden).toBeGreaterThan(50);
  });
});
