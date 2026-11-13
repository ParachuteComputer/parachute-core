/**
 * Wider equivalence check for the SQL visibility path (kept from the #105 review): odd tag names, declared hierarchy,
 * renames, plain-Set and deny-all scopes, both constructors; the SQL path must equal noteWithinTagScope note by note
 * and the per-note path in ranked results.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../core/src/store.ts";
import { searchNotes, getNoteTagsForNotes } from "../core/src/notes.ts";
import type { Note } from "../core/src/types.ts";
import { TagScopeSet, buildExpandVisibility, expandTokenTagScope, noteWithinTagScope, tagScopeVisibility } from "./tag-scope.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const BASE = ["Mine","mine","mine/sub","mine/sub/deep","mine/secret","MINE/x","work","work/meetings","work/meetings/a","Work/Meetings","secret","secret/x","secret/x/y","secret/mine","proj","proj-child","proj/child","a b","ü/ß","ü","it's","x%_","x%_/y","capture","capture/voice","plain","Plain","sub","deep"];
const WORDS = ["garden","plan","week","budget","team","review","music","stew","frost","ridge"];

test("rev105: SQL tag rule == noteWithinTagScope over nasty shapes", async () => {
  let compared = 0, diffs: string[] = [], nonTrivial = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 104729);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
    const db = new Database(":memory:");
    const store = new SqliteStore(db);
    // random extra tag names with random / nesting
    const extra = Array.from({ length: 8 }, () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(["mine","work","secret","q","Z","sub"])).join("/"));
    const universe = [...new Set([...BASE, ...extra])];
    const inputs = [];
    for (let i = 0; i < 250; i++) {
      const k = Math.floor(r() * 5); // 0..4 tags; 0 = untagged
      const tags = [...new Set(Array.from({ length: k }, () => pick(universe)))];
      const body = Array.from({ length: 3 + Math.floor(r() * 10) }, () => pick(WORDS)).join(" ");
      inputs.push({ content: `zz ${body}`, path: `p/${i}`, tags });
    }
    await store.createNotes(inputs as any);
    // declared hierarchy: random parents (lower index only, no cycles), random kinds
    const used = (db.prepare("SELECT name FROM tags").all() as { name: string }[]).map((x) => x.name);
    for (let i = 1; i < used.length; i++) {
      const x = r();
      try {
        if (x < 0.25) await store.upsertTagRecord(used[i]!, { parent_names: [used[Math.floor(r() * i)]!] });
        else if (x < 0.4) await store.upsertTagRecord(used[i]!, { kind: "tag" });
        else if (x < 0.5) await store.upsertTagRecord(used[i]!, { kind: "type" });
      } catch {}
    }
    for (let round = 0; round < 2; round++) {
      if (round === 1) { // rename + merge some tags
        const a = pick(used), b = pick(universe) + "/r" + seed;
        try { await store.renameTag(a, b); } catch {}
      }
      const all = db.prepare("SELECT id FROM notes").all() as { id: string }[];
      const tagsById = getNoteTagsForNotes(db, all.map((x) => x.id));
      for (let k = 0; k < 12; k++) {
        const roots = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => r() < 0.85 ? pick(universe) : pick(["nope", "mine/", "/mine", "", "Mine/sub"])))];
        const priv = [...new Set(Array.from({ length: Math.floor(r() * 4) }, () => pick(universe)))];
        const variant = r();
        let allowed: Set<string> | null;
        if (variant < 0.7) allowed = await expandTokenTagScope(store, roots, priv);
        else if (variant < 0.8) { const s = new TagScopeSet(); s.denyAll = true; allowed = s; }
        else if (variant < 0.9) allowed = new Set(roots.filter(() => r() < 0.5)); // plain Set: no deny side
        else allowed = null; // MCP holder not yet filled
        const fns = [
          buildExpandVisibility(allowed, roots)!,
          tagScopeVisibility(() => ({ allowed, rawRoots: roots })),
        ];
        for (const visible of fns) {
          const expected = all.filter((x) => noteWithinTagScope({ id: x.id, tags: tagsById.get(x.id) ?? [] } as Note, allowed, roots)).map((x) => x.id).sort();
          const got = searchNotes(db, '"zz"', { mode: "advanced", limit: 100000, visible }).map((n) => n.id).sort();
          if (JSON.stringify(got) !== JSON.stringify(expected)) diffs.push(`seed ${seed} round ${round} roots ${JSON.stringify(roots)} priv ${JSON.stringify(priv)} got ${got.length} exp ${expected.length}`);
          if (expected.length > 0 && expected.length < all.length) nonTrivial++;
          // ranked comparison with a random query/limit/tag filter vs per-note path
          const q = WORDS.filter(() => r() < 0.3).map((w) => `"${w}"`).join(" OR ") || '"garden"';
          const opts = { mode: "advanced" as const, limit: 1 + Math.floor(r() * 40), ...(r() < 0.3 ? { tags: [pick(universe)] } : {}) };
          const perNote = (n: Note) => visible(n);
          const a = searchNotes(db, q, { ...opts, visible });
          const b = searchNotes(db, q, { ...opts, visible: perNote });
          if (JSON.stringify(a.map((n) => [n.id, n.score])) !== JSON.stringify(b.map((n) => [n.id, n.score]))) diffs.push(`ranked seed ${seed} q ${q}`);
          compared++;
        }
      }
    }
    db.close();
  }
    expect(diffs).toEqual([]);
  expect(nonTrivial).toBeGreaterThan(compared / 4);
}, 120000);
