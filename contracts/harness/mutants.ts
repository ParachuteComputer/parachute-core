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
  /** Which package the change is in (default: vault): today's repos, moved to packages/vault and packages/hub, or
   *  packages/cli (the one command, lane A1). `bun run mutants` (the pinned vault) takes only vault mutants. */
  repo?: "vault" | "hub" | "cli";
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
  {"name": "tag-schema-needs-write-only", "why": "Prism: a write pass may change tag schemas", "repo": "vault", "file": "src/routing.ts", "find": "(isTagSchemaMutation || isNoteHistoryErase || isHistoryCompact) ? \"admin\"", "replace": "(isNoteHistoryErase || isHistoryCompact) ? \"admin\"", "suite": "suites/compat/prism.test.ts", "catches": ["tag schema: PUT /tags/:name with a write pass"]},
  {"name": "if-exists-ignored", "why": "a taken path silently replaced", "repo": "vault", "file": "src/routes.ts", "find": "const ifExists: string = item.if_exists ?? \"error\";", "replace": "const ifExists: string = \"replace\";", "suite": "suites/compat", "catches": ["if_exists:error → 409", "uni-publish", "the door"]},
  {"name": "attachment-download-admin-only", "why": "Prism's vault-rw allowlist loses a tool", "repo": "vault", "file": "core/src/mcp-manifest.ts", "find": "name: \"request-attachment-download\",\n      requiredVerb: \"read\",", "replace": "name: \"request-attachment-download\",\n      requiredVerb: \"admin\",", "suite": "suites/compat/prism.test.ts", "catches": ["a write pass sees every tool in Prism's vault-rw allowlist"]},
  {"name": "mint-service-ignored", "why": "hub#872: member agent writes attributed to the operator", "repo": "hub", "file": "src/commands/auth.ts", "find": "const asService = flags.service;", "replace": "const asService = undefined as string | undefined;", "suite": "suites/compat/prism.test.ts", "catches": ["--service <id> makes the pass's sub"]},
  {"name": "revocation-list-empty", "why": "revoked passes keep working", "repo": "hub", "file": "src/api-revocation-list.ts", "find": "const jtis = listActiveRevocations(deps.db, now);", "replace": "const jtis: string[] = [];", "suite": "suites/compat/prism.test.ts", "catches": ["auth revoke-token <jti> puts the jti", "the vault refuses a revoked pass"]},
  {"name": "nip98-no-forwarded-https", "why": "the Uni app and uni-nightly locked out behind Tailscale Serve", "repo": "hub", "file": "src/nostr-http-auth.ts", "find": "if (layerOf(req, peer) !== \"loopback\" && isHttpsRequest(req)) {", "replace": "if (false && layerOf(req, peer) !== \"loopback\" && isHttpsRequest(req)) {", "suite": "suites/compat/uni.test.ts", "catches": ["the Uni app's shape", "uni-nightly", "the Uni app: create-note"]},
  {"name": "nip98-unlinked-message", "why": "the Uni app's 'not linked' hint breaks", "repo": "hub", "file": "src/nostr-http-auth.ts", "find": "\"Nostr pubkey is not linked to a hub user\"", "replace": "\"Nostr pubkey is unknown to this hub\"", "suite": "suites/compat/uni.test.ts", "catches": ["an unlinked key is refused"]},
  {"name": "ticket-reusable", "why": "upload tickets stop being single-use", "repo": "vault", "file": "src/attachment-tickets.ts", "find": "    if (!ticket) return null;\n    this.tickets.delete(id);\n    return ticket;", "replace": "    if (!ticket) return null;\n    return ticket;", "suite": "suites/compat/uni.test.ts", "catches": ["the Uni app: create-note"]},
  {"name": "cursor-bootstrap-regression", "why": "vault#550 back: cursor= gets a bare array", "repo": "vault", "file": "src/routes.ts", "find": "const cursorMode = cursorParam !== null;", "replace": "const cursorMode = !!cursorParam;", "suite": "suites/compat/uni.test.ts", "catches": ["uni-digest", "the door"]},
  {"name": "self-register-restamps", "why": "services.json rewritten every boot", "repo": "vault", "file": "src/self-register.ts", "find": "    version: deps.version,\n    installDir,\n  };", "replace": "    version: deps.version,\n    installDir,\n    ...({ registeredAt: new Date().toISOString() } as {}),\n  };", "suite": "suites/compat/uni.test.ts", "catches": ["a restart leaves services.json"]},
  {"name": "hub-admin-route-unauthenticated", "why": "an admin route reachable by any local process without a token", "repo": "hub", "file": "src/api-hub.ts", "find": "    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);", "replace": "    void requireScope;", "suite": "suites/embedded/hostile-local.test.ts", "catches": ["box: with no token", "box: with a vault read token", "box: with a vault write token"]},
  {"name": "vault-exit-before-db-close", "why": "shutdown: the process ends before the DB closes (PLAN §7.5)", "repo": "vault", "file": "src/server.ts", "find": "  process.exit(0);\n}\nprocess.on(\"SIGINT\"", "replace": "  process.kill(process.pid, \"SIGKILL\");\n}\nprocess.on(\"SIGINT\"", "suite": "suites/lifecycle/shutdown.test.ts", "catches": ["SIGTERM: the home is left clean", "SIGINT: the home is left clean", "ten restarts in a row: every stop is clean"]},
  {"name": "hub-exit-without-stop", "why": "a signal ends the hub without the coordinator: the vault child is orphaned", "repo": "hub", "file": "src/cli.ts", "find": "          await stopServer();", "replace": "          process.exit(0);", "suite": "suites/lifecycle/shutdown.test.ts", "catches": ["SIGTERM: serve exits 0 within 10 s", "SIGINT: serve exits 0 within 10 s", "SIGTERM: the home is left clean", "ten restarts in a row: every stop is clean"]},
  {"name": "hub-ready-always", "why": "/api/ready says ready before the box is usable", "repo": "hub", "file": "src/api-ready.ts", "find": "  const isReady = transient.length === 0 && persistent.length === 0;", "replace": "  const isReady = true;", "suite": "suites/lifecycle/shutdown.test.ts", "catches": ["/api/ready says ready only once a write goes through", "vault start failure: /api/ready never says ready", "occupied vault port: /api/ready never says ready"]},
  {"name": "hub-keeps-instance-file", "why": "the instance file is left after a clean stop", "repo": "hub", "file": "src/commands/serve.ts", "find": "      clearHubInstanceFile(CONFIG_DIR);", "replace": "      // clearHubInstanceFile(CONFIG_DIR);", "suite": "suites/lifecycle/shutdown.test.ts", "catches": ["SIGTERM: the home is left clean", "SIGINT: the home is left clean", "ten restarts in a row: every stop is clean"]},
  {"name": "rest-sort-ignored", "why": "area-briefs reads newest first; the REST sort parameter is ignored", "repo": "vault", "file": "src/routes.ts", "find": "    sort: (parseQuery(url, \"sort\") as \"asc\" | \"desc\") ?? undefined,", "replace": "    sort: undefined,", "suite": "suites/compat/uni.test.ts", "catches": ["extra clients"]},
  {"name": "issuer-from-port", "why": "fix 1 undone in the CLI: the issuer comes from hub.port or :1939 again, not PARACHUTE_HUB_ORIGIN (was the issuer-hub flip)", "repo": "hub", "file": "src/hub-issuer.ts", "find": "  override ??= process.env.PARACHUTE_HUB_ORIGIN;\n", "replace": "", "suite": "suites/embedded/issuer.test.ts", "catches": ["with PARACHUTE_HUB_ORIGIN set, rotate-operator and mint-token sign with exactly that iss", "box: on a non-default hub port with only PARACHUTE_HUB_ORIGIN set"]},
  {"name": "vault-keys-from-1939", "why": "fix 1 undone in serve: the vault child fetches its keys from :1939 again (was the issuer-hub flip)", "repo": "hub", "file": "src/commands/serve.ts", "find": "  process.env.PARACHUTE_HUB_JWKS_ORIGIN ??= `http://127.0.0.1:${port}`;\n", "replace": "", "suite": "suites/embedded/issuer.test.ts", "catches": ["box: a vault the hub starts verifies that hub's tokens on a non-default hub port"]},
  {"name": "version-names-the-hub", "why": "identity: `version --json` names the old package", "repo": "cli", "file": "src/dispatch.ts", "find": "return { name: core.name, version: core.version,", "replace": "return { name: \"@openparachute/hub\", version: core.version,", "suite": "suites/lifecycle/identity.test.ts suites/embedded/json.test.ts", "catches": ["with bin/parachute and bin/parachute-vault as aliases", "`parachute-core version --json` says @openparachute/core", "version --json prints {name, version, schema, bun}"]},
  {"name": "aliases-run-the-old-programs", "why": "identity: bin/parachute-vault skips core and runs the vault CLI directly", "repo": "cli", "file": "bin/parachute-vault", "find": "exec bun \"$here/../src/parachute-vault.ts\" \"$@\"", "replace": "exec bun \"$here/../../vault/src/cli.ts\" \"$@\"", "suite": "suites/lifecycle/identity.test.ts", "catches": ["with bin/parachute and bin/parachute-vault as aliases"]},
  {"name": "vault-child-from-path", "why": "PLAN §2.1: the hub finds `parachute-vault` on the user's PATH, so on uni it would start the old 0.7.9 vault", "repo": "cli", "file": "bin/parachute-core", "find": "PATH=\"$here:$PATH\" exec bun", "replace": "exec bun", "suite": "suites/lifecycle/identity.test.ts", "catches": ["the vault `parachute-core serve` starts is core's own"]},
  {"name": "hub-drops-open-requests-on-stop", "why": "stop must answer or finish requests it has started reading, not drop them", "repo": "hub", "file": "src/commands/serve.ts", "find": "    stop: async () => {\n      // Stop supervised children first so they get a clean SIGTERM", "replace": "    stop: async () => {\n      void server.stop(true);\n      // Stop supervised children first so they get a clean SIGTERM", "suite": "suites/lifecycle/shutdown.test.ts", "catches": ["SIGTERM: acknowledged writes survive, and writes the hub was reading"]}
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
