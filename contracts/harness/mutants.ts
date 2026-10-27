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
  /** Instead of find/replace: a patch file (relative to harness/), applied with `git apply` (flips only). */
  patch?: string;
  /** Which of today's repos the change is in (default: vault). */
  repo?: "vault" | "hub";
  why: string;
  file?: string;
  find?: string;
  replace?: string;
  suite: string; // the contract file(s) expected to catch it, space-separated
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
export const CANDIDATE_MUTANTS: Mutant[] = [
  {"name": "view-ignores-pass", "why": "/view treats every reader as anonymous: the positive control must catch a fix that breaks reading", "repo": "vault", "file": "src/routes.ts", "find": "  if (!authenticated && !isNotePublished(note, publishedTag)) {", "replace": "  if (!isNotePublished(note, publishedTag)) {", "suite": "suites/safety/view-scope.test.ts", "catches": ["reads an in-scope note through /view"]},
  {"name": "g2-naive-every-tag", "why": "a naive G2 fix: every tag on the note must be in scope, so editing a co-tagged note breaks", "repo": "vault", "file": "src/tag-scope.ts", "find": "  for (const t of tags) {\n    if (allowed && allowed.has(t)) return true;\n    const root = t.split(\"/\")[0];\n    if (root && rawRoots.includes(root)) return true;\n  }\n  return false;", "replace": "  return tags.every((t) => (allowed && allowed.has(t)) || rawRoots.includes(t.split(\"/\")[0]!));", "suite": "suites/safety/scoped-write.test.ts", "catches": ["editing an in-scope note that also carries other tags"]},
  {"name": "deletes-dropped", "why": "a G5 fix that drops every delete event, visible ones too", "repo": "vault", "file": "src/subscriptions.ts", "find": "        this.emit(sub, \"remove\", { id: ref.id });", "replace": "", "suite": "suites/safety/delete-scope.test.ts", "catches": ["receives the delete of a note it could see"]},
  {"name": "scoped-as-unscoped", "why": "a tag-scoped pass treated as unscoped (setup checks must notice)", "repo": "vault", "file": "src/auth.ts", "find": "  if (!permissions || !(\"scoped_tags\" in permissions)) return null;", "replace": "  return null;", "suite": "suites/safety", "catches": ["setup works today"]},
  {"name": "mint-drops-permissions", "why": "the mint drops the permissions it was asked for (a wrong fix 13 that widens the honest case)", "repo": "hub", "file": "src/api-mint-token.ts", "find": "    permissionsClaim = body.permissions as Record<string, unknown>;", "replace": "    permissionsClaim = {};", "suite": "suites/safety/mint-attenuation.test.ts suites/safety/permissions-fail-closed.test.ts", "catches": ["can mint a pass with its own tags", "the mint accepts the keys the vault enforces"]},
  {"name": "vault-refuses-all-permissions", "why": "a naive fix 14 that 401s every pass with permissions, known keys included", "repo": "vault", "file": "src/auth.ts", "find": "  if (!permissions || !(\"scoped_tags\" in permissions)) return null;", "replace": "  if (permissions) throw new MalformedScopedTagsError(\"any permissions refused\");\n  return null;", "suite": "suites/safety/permissions-fail-closed.test.ts", "catches": ["a re-signed pass with only known keys is accepted"]},
  {"name": "vault-binds-all", "why": "binds: the vault's default bind switched to every interface", "repo": "vault", "file": "src/bind.ts", "find": "  return \"127.0.0.1\";", "replace": "  return \"0.0.0.0\";", "suite": "suites/safety/loopback.test.ts", "catches": ["parachute-vault serve` with no VAULT_BIND binds 127.0.0.1 only"]},
  {"name": "hub-ignores-bind-host", "why": "a fix 2 that hardcodes loopback and breaks the containers' PARACHUTE_BIND_HOST", "repo": "hub", "file": "src/commands/serve.ts", "find": "  const hostname = env.PARACHUTE_BIND_HOST || \"0.0.0.0\";", "replace": "  const hostname = \"127.0.0.1\";", "suite": "suites/safety/loopback.test.ts", "catches": ["PARACHUTE_BIND_HOST=0.0.0.0 still binds every interface"]},
  {"name": "view-anonymous-reads", "why": "/view treats a request with no pass as authenticated", "repo": "vault", "file": "src/routing.ts", "find": "  if (!key) return false;\n  const auth = await authenticateVaultRequest(req, vaultConfig);\n  return !(\"error\" in auth);", "replace": "  if (!key) return true;\n  const auth = await authenticateVaultRequest(req, vaultConfig);\n  return !(\"error\" in auth);", "suite": "suites/safety/view-scope.test.ts", "catches": ["with no pass, /view shows neither note"]},
];

/** Fixes that must flip red contracts to "now green" (`catches` lists the red contracts that must flip). */
export const FLIPS: Mutant[] = [
  {
    name: "safety-fixes-hub",
    why: "fixes 2, 13 and 14 in the hub: loopback by default, a mint never wider than its minter, unknown permission keys refused",
    repo: "hub",
    patch: "flips/safety-hub.patch",
    suite: "suites/safety",
    catches: [
      "`parachute serve` with no PARACHUTE_BIND_HOST and no --listen binds 127.0.0.1 only",
      "a tag-scoped minter can't mint an unscoped pass",
      "a tag-scoped minter can't mint a pass for other tags",
      "a tag-scoped minter can't widen its tags by adding one",
      "the mint endpoint refuses an unknown permission key",
      "`parachute auth mint-token` refuses an unknown permission key",
    ],
  },
  {
    name: "safety-fixes-vault",
    why: "fixes 5, 6/15 and 14 in the vault: /view checks scope, a scoped write adds no tag outside scope, unknown keys get 401",
    repo: "vault",
    patch: "flips/safety-vault.patch",
    suite: "suites/safety",
    catches: [
      "through /view",
      "on create, a scoped writer can't add a tag outside its scope",
      "on create, a scoped writer can't add publish",
      "on create, a scoped writer can't add a private tag",
      "on update, a scoped writer can't add a tag outside its scope",
      "on update, a scoped writer can't add a private tag",
      "the vault answers 401 to a pass whose permissions carry an unknown key",
    ],
  },
];
