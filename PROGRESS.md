# T-308 progress (attempt 1bjhpusk, stopped early)

## Done
- Local scaffold: LICENSE (AGPL-3.0), README draft, AGENTS.md, contracts/ package (fast-check, MCP SDK), pins.json, docs/walkthrough/music.py. No commits yet; no GitHub repo yet.
- Scratch clones at pinned commits, deps installed: /home/uni/.hermes/cache/scratch/t308/repos/ (vault 42fbf93, hub 53d327b, surface 74c2522).
- Smoke: throwaway vault from 42fbf93 on 127.0.0.1:47811, temp HOME/PARACHUTE_HOME, VAULT_AUTH_TOKEN; /health ok, POST notes 201.

## Next
1. harness/: start vault (+ hub) in temp home on random ports; reuse ~/Code/uni-ops/research/t289-parachute-v1/deep/core/prototype/shared/throwaway-vault.ts.
2. Suites: notes CRUD, tags+schemas, links, search, history, access (today: tag scope), consumer connector (OAuth + MCP). Prove one red.
3. PROCESS.md, .github/workflows/contracts.yml, private repo, push, CI green.
4. Video (Kokoro + music.py), copy to ~/.local/share/uni/videos (uni-publish writes a vault note: not authorised by brief).

## Vault API at 42fbf93 (from source reading, not yet run except the smoke)
- Boot: `bun src/server.ts` (or `cli.ts serve`). Data under $PARACHUTE_HOME/vault/. PORT, VAULT_BIND (default 127.0.0.1). selfRegister writes $PARACHUTE_HOME/services.json (stays in temp). Avoid `init` and `mcp-install`. PARACHUTE_VAULT_NAME auto-creates on first boot (logs a pvk_ key). Seed packs add welcome notes, so a fresh vault is not empty.
- Set PARACHUTE_HUB_ORIGIN and PARACHUTE_HUB_JWKS_ORIGIN, or it trusts 127.0.0.1:1939 (the live hub).
- Auth order: VAULT_AUTH_TOKEN (operator, all scopes) → hub JWT (RS256, JWKS at <origin>/.well-known/jwks.json, also fetches /.well-known/parachute-revocation.json; iss=origin, aud=vault.<name>, scope vault:<name>:read|write|admin, optional permissions.scoped_tags) → legacy pvk_ keys in vault.yaml (sha256:<hex>, re-read per request; scope: read → read-only). Fake hub + signJwt example: src/auth-hub-jwt.test.ts:37-150.
- Tag scope: out-of-scope note → 404 on get/versions/attachments/delete; filtered from list, search, near, graph, cursor, find-path, include_links, WS, MCP query-notes/list-tags; writes without in-scope tag → 403.
- REST under /vault/<name>/api: POST /notes; GET/PATCH/DELETE /notes/{idOrPath} (PATCH needs if_updated_at or force, else 428; stale → 409); GET /notes?tag=&search=; links via include_links, near[...], /find-path; PUT /tags/{n} (admin) with fields {type, strict, required...}, strict violation → 422; GET /notes/{id}/versions (first version on first change); feed: GET /notes?cursor= or WS /api/subscribe.
- MCP: /vault/<name>/mcp, streamable HTTP, stateless JSON. Tools create-note, query-notes, update-note, delete-note, list-tags, update-tag... 401 carries WWW-Authenticate resource_metadata=/vault/<n>/.well-known/oauth-protected-resource, which points at the hub origin.

## Hub at 53d327b (from source reading, not yet run)
- Reference flow already exists: hub e2e/mcp-probe.ts:83-264 (DCR → login → authorize/consent → token → MCP create + query).
- Boot without the supervisor: `bun -e "const m=await import('<hub>/src/commands/serve.ts'); await m.serve({skipModuleBoot:true})"` with PARACHUTE_HOME=<tmp>, PORT, PARACHUTE_BIND_HOST=127.0.0.1 (serve defaults to 0.0.0.0), PARACHUTE_HUB_ORIGIN=http://127.0.0.1:<port>, PARACHUTE_INITIAL_ADMIN_USERNAME / _PASSWORD (12+ chars, first boot only).
- HAZARDS for the live install: with module boot on, reconcilePortToCanonical rewrites the vault row to port 1940 (the live vault) and the supervisor may kill a parachute-vault on that port. The hub never passes PARACHUTE_HUB_JWKS_ORIGIN to vaults it spawns. So: skipModuleBoot, start the vault yourself, and write <tmp>/.parachute/vault/config.yaml `port: <vault port>` first (the vault's services.json row uses config.yaml, not PORT).
- OAuth: POST /oauth/register {redirect_uris} → GET /login (csrf cookie + __csrf) → POST /login form {__csrf, username, password} → session cookie → GET /oauth/authorize (S256, scope vault:<n>:read vault:<n>:write, resource=<hub>/vault/<n>/mcp) → 200 consent page (re-read __csrf) or 302 code → POST /oauth/authorize form {__action=consent, __csrf, approve=yes, ...params, vault_pick=<n>} → 302 ?code= → POST /oauth/token form {grant_type=authorization_code, code, client_id, redirect_uri, code_verifier}. JWT RS256 900 s, aud vault.<n>, refresh 30 days.
- MCP at <hub>/vault/<n>/mcp (or <hub>/mcp, vault taken from aud); Accept: application/json, text/event-stream.
- door-contract conformance helpers (packages/door-contract/src/conformance.ts) can be run against live discovery and token responses.
