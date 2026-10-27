// The mutants: one-line bugs a real change could make, each with the contracts that must catch it.
//
//   MUTANTS            today's suites; `bun run mutants` applies them to the pinned vault (harness/mutate.ts), and
//                      `bun run mutants:candidate` applies them to the candidate's source and rebuilds it
//   CANDIDATE_MUTANTS  for suites that only run on the candidate (compat/), candidate only
//   FLIPS              the other direction, for red() contracts: a small fix to today's code that must turn the
//                      named red contracts "now green". Red today plus green under the fix is the red/green proof
//                      that a red contract tests the fix and not something impossible (PLAN §7.4, §7.5).
export interface Mutant {
  name: string;
  /** Which of today's repos the change is in (default: vault). */
  repo?: "vault" | "hub";
  why: string;
  file: string;
  find: string;
  replace: string;
  suite: string; // the contract file expected to catch it
  catches: string[]; // contracts (test-name substrings) that must go red; another red test doesn't count
}

export const MUTANTS: Mutant[] = [
  {
    name: "scope-leak",
    why: "a tag-scoped pass is treated as unscoped on single-note reads",
    file: "src/tag-scope.ts",
    find: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    replace: "  rawRoots: string[] | null,\n): boolean {\n  if (rawRoots === null || rawRoots.length > 0) return true;\n  if (scopeDeniesAll(allowed)) return false;\n  if (!note.tags",
    suite: "suites/today/access.test.ts",
    catches: ["a scoped pass sees exactly the notes under its tags", "cannot change or delete a note it cannot see"],
  },
  {
    name: "untagged-leak",
    why: "notes with no tags become visible to every scoped pass",
    file: "src/tag-scope.ts",
    find: "  if (!note.tags || note.tags.length === 0) return false;\n  let admitted = false;",
    replace: "  if (!note.tags || note.tags.length === 0) return true;\n  let admitted = false;",
    suite: "suites/today/access.test.ts",
    catches: ["a scoped pass sees exactly the notes under its tags"],
  },
  {
    name: "no-history",
    why: "changes stop keeping the version before them",
    file: "core/src/history.ts",
    find: "  if (!opts.policy.enabled) return;",
    replace: "  if (!opts.policy.enabled || true) return;",
    suite: "suites/today/links-search-history.test.ts",
    catches: ["each change keeps the version before it", "an old version can be restored"],
  },
  {
    name: "stale-write",
    why: "an update made from an old version silently wins instead of being refused",
    file: "core/src/notes.ts",
    find: '    sql += " AND updated_at IS ?";\n    values.push(updates.if_updated_at);',
    replace: '    sql += " AND (updated_at IS ? OR 1)";\n    values.push(updates.if_updated_at);',
    suite: "suites/today/notes.test.ts",
    catches: ["a stale one is refused"],
  },
  {
    name: "wrong-resource",
    why: "the vault advertises a resource URL that isn't its MCP endpoint, so consumer apps can't bind tokens to it",
    file: "src/oauth-discovery.ts",
    find: "    resource: `${base}${prefix}/mcp`,",
    replace: "    resource: `${base}${prefix}`,",
    suite: "suites/today/consumer-connector.test.ts",
    catches: ["the app connects from nothing but the MCP URL"],
  },
];

/** Candidate-only mutants (filled as suites land). */
export const CANDIDATE_MUTANTS: Mutant[] = [];

/** Fixes that must flip red contracts to "now green" (`catches` lists the red contracts that must flip). */
export const FLIPS: Mutant[] = [];
