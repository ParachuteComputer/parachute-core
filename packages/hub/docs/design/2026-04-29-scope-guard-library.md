# scope-guard: shared hub-JWT validation library

**Issue:** [parachute-hub#59](https://github.com/ParachuteComputer/parachute-hub/issues/59)
**Date:** 2026-04-29
**Status:** Proposal — implementation in follow-up PRs

## Problem

Three Parachute modules each ship their own near-identical hub-JWT validator:

- [`parachute-vault/src/hub-jwt.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/hub-jwt.ts) — canonical impl. Most surface area: optional `expectedAudience` strict-check, RFC 7519 string-or-array `aud` handling, surfaces `{sub, scopes, aud, jti, clientId}`.
- [`parachute-scribe/src/hub-jwt.ts`](https://github.com/ParachuteComputer/parachute-scribe/blob/main/src/hub-jwt.ts) — explicit "mirrors vault" with simpler needs: no `expectedAudience`, surfaces `{sub, scopes}` only.
- [`paraclaw/src/web/auth.ts`](https://github.com/ParachuteComputer/paraclaw/blob/main/src/web/auth.ts) — explicit "mirrors vault" with paraclaw vocab + a `PARACLAW_HUB_ORIGIN` test override.

Across all three the JWKS-fetch + verify body is byte-for-byte identical:

```ts
const verified = await jwtVerify(token, getter, { issuer: origin });
// ...same kid lookup, same 5-minute cacheMaxAge, same 30s cooldownDuration...
```

Service-specific code surrounds it but the trust kernel is duplicated. That kernel is the worst place to drift.

`parachute-patterns/patterns/service-to-service-auth.md` already references this issue as the home for the eventual shared library:

> The shared scope-guard library proposed in `parachute-cli#59`. Every service uses the same `verifyJwt(...)` helper and pins trust to the hub origin (see `hub-as-issuer.md`).

## Decision

Ship `@openparachute/scope-guard` as a **sub-package in `parachute-hub`**, published independently to npm.

| Question | Decision | Rationale |
|---|---|---|
| Where does it live? | `parachute-hub/packages/scope-guard/` | Hub owns the JWT-issuance side and the scope vocabulary (per `oauth-scopes.md`). The verifier is its mirror. The pattern doc already names this location. |
| What's it called? | `@openparachute/scope-guard` | Matches the issue title. `scope-guard` reads as "guards routes by required scope" — the consumer-side verb. |
| Workspace tooling? | Bun workspaces (`"workspaces": ["packages/*"]` in root `package.json`). | Bun-native per `parachute-vault/CLAUDE.md` ecosystem convention. Lightweight; no monorepo build tool needed. |
| What's in the lib? | Generic JWT verify + parse + inheritance check. | The kernel that's identical today. |
| What's NOT in the lib? | Per-service scope vocab constants, exotic cross-resource catch-all rules. | Each service owns its scope language. The lib is the engine, not the dictionary. |
| Migration order | 1. Ship lib (this design's follow-up). 2. Vault adopts. 3. Scribe adopts. 4. Paraclaw adopts. Each as its own PR. | Vault is the canonical source; the lib API gets validated against the most-demanding consumer first. |
| JWT vs introspection? | JWT-only at launch; introspection not in scope. | All three current consumers do JWKS-backed JWT verify. Introspection adds a network call per request and a hub dependency that the JWKS path doesn't need. Add later if a consumer requires it. |
| JWKS caching | 5min `cacheMaxAge`, 30s `cooldownDuration` (current values across all three). Configurable via `createScopeGuard` options. | Current defaults are battle-tested. Config knob exists for cloud topologies that may want different values. |

### Alternatives considered

- **Vault as the home.** Canonical impl lives there today, but the hub owns scope vocabulary and JWT issuance. Vault as both publisher and consumer of the same package is awkward.
- **Fresh repo (`parachute-scope-guard`).** Independent versioning is a benefit but introduces cross-repo coordination overhead. The hub repo already publishes `@openparachute/hub` to npm and adding a sub-package is mechanical.
- **Just inlining a shared file via copy-paste.** What we have today. Drifts immediately and silently — a strict subset of "library" that is also strictly worse. Rejected.

## API

### `createScopeGuard(opts) → ScopeGuard`

Factory bound to a hub origin + an optional audience expectation. Holds the JWKS getter so the cache lives across requests.

```ts
import { createScopeGuard } from "@openparachute/scope-guard";

const guard = createScopeGuard({
  // Either a literal string or a resolver function. Paraclaw's case:
  // "PARACLAW_HUB_ORIGIN env var → PARACHUTE_HUB_ORIGIN env var → loopback".
  hubOrigin: () => resolveHubOrigin(),

  // Optional: tune JWKS cache. Defaults to 5min/30s.
  jwks: { cacheMaxAge: 5 * 60_000, cooldownDuration: 30_000 },
});

await guard.validateHubJwt(token);
await guard.validateHubJwt(token, { expectedAudience: "vault.work" });
guard.resetJwksCache(); // tests only
```

### `validateHubJwt(token, opts?) → Promise<HubJwtClaims>`

Throws `HubJwtError` on any verification failure (bad signature, wrong issuer, expired, missing kid, JWKS unreachable, audience mismatch).

```ts
interface HubJwtClaims {
  sub: string;
  scopes: string[];           // parsed from `scope` claim
  aud: string | undefined;    // representative aud (matched value if expectation supplied, else first array element)
  jti: string | undefined;
  clientId: string | undefined; // from `client_id` claim
}

interface ValidateOptions {
  expectedAudience?: string;  // strict-check JWT `aud` (string OR string[]) against this value
}
```

Implements RFC 7519 §4.1.3 string-or-array `aud` from day one — vault needs it, the others get it free.

### `parseScopes(raw) → string[]`

Whitespace-split the OAuth-standard `scope` claim. Empty/null → `[]`.

### `looksLikeJwt(token) → boolean`

Cheap pre-check (`startsWith("eyJ")`) so non-JWT tokens (e.g. shared secrets, `pvt_*`) skip JWKS verification.

### `extractBearer(authHeader) → string | undefined`

`/^Bearer\s+(.+)$/i` — what every consumer writes today.

### `hasScope(granted, required) → boolean`

Generic `<resource>:<verb>` and `<resource>:<name>:<verb>` matcher with `admin ⊇ write ⊇ read` inheritance.

```ts
hasScope(["vault:read"], "vault:read")            // true
hasScope(["vault:admin"], "vault:read")           // true (inherits)
hasScope(["vault:work:write"], "vault:work:read") // true (narrowed + inheritance)
hasScope(["vault:work:write"], "vault:home:read") // false (different resource)
hasScope(["scribe:transcribe"], "scribe:admin")   // false (admin not implied by transcribe — verb word doesn't match the inheritance ladder)
```

The lib's inheritance ladder is **`admin ⊇ write ⊇ read`** literally — those three verb names. Services with non-ladder verbs (scribe's `transcribe` / `admin`) get exact-match for the non-ladder name.

This deliberately punts on cross-resource catch-alls (paraclaw's `vault:admin` satisfying `claw:*`). Those rules belong in the consumer's wrapper, not in the lib — they're policy, not engine.

### Optional: `requireScope(scope)` middleware factory

Defer this — call sites today aren't using a uniform middleware framework (vault uses Bun.serve, paraclaw uses Hono on the `/api/*` mount, scribe uses Bun.serve). Each consumer writes its own thin `enforceAuth(req)` that returns `{ok: true, claims}` or a `Response`. The lib gives them the primitives, not the routing glue.

If a future module standardizes on a framework, add a framework-specific adapter in a separate sub-package.

## What stays per-service

- **Scope vocabulary constants.** Vault keeps `SCOPE_READ = "vault:read"` etc. Scribe keeps `SCOPE_TRANSCRIBE`. Paraclaw keeps `SCOPE_CLAW_*`. The lib doesn't define these.
- **Cross-resource catch-alls.** Paraclaw's `vault:admin` satisfies any `claw:*` — that's a paraclaw-specific policy and lives in `paraclaw/src/web/auth.ts` as a thin wrapper around `lib.hasScope`.
- **Resource-narrowed scope detection.** Vault's `findBroadVaultScopes` (rejects `vault:<verb>` from hub JWTs) is vault policy — stays in vault.
- **Auth seam (`enforceAuth(req)`).** Each service's request-shape varies; each builds its 401/403 responses to its own format. The lib gives them claims; the seam formats responses.
- **Hub-origin resolution.** Vault uses `PARACHUTE_HUB_ORIGIN`. Paraclaw layers `PARACLAW_HUB_ORIGIN` on top. Each passes its resolver into `createScopeGuard`.

## Migration sequence

Each step is its own PR.

1. **`parachute-hub#59-impl`: Ship the library.** This is what the design enables. Adds `parachute-hub/packages/scope-guard/` with full impl + unit tests + an integration test that mints a real hub JWT and validates it through the lib. No consumer migration in this PR. Publish `@openparachute/scope-guard@0.1.0` to npm.
2. **`parachute-vault#TBD`: Vault adopts.** Replaces `vault/src/hub-jwt.ts` internals with `createScopeGuard` + `validateHubJwt`. Vault keeps `scopes.ts` with its resource-narrowed bits (`hasScopeForVault`, `findBroadVaultScopes`, `legacyPermissionToScopes`); only the generic helpers (`parseScopes`, broad-form `hasScope`) come from the lib. External behavior unchanged — same tests pass.
3. **`parachute-scribe#TBD`: Scribe adopts.** Replaces `scribe/src/hub-jwt.ts` with the lib. `scribe/src/auth.ts` keeps its shared-secret + JWT bifurcation; the JWT half becomes `lib.validateHubJwt(token)`.
4. **`paraclaw#TBD`: Paraclaw adopts.** Replaces `paraclaw/src/web/auth.ts` JWT validation with the lib. The `vault:admin → claw:*` catch-all stays in paraclaw as a thin wrapper around `lib.hasScope`. The `PARACLAW_HUB_ORIGIN` override goes into the resolver passed to `createScopeGuard`.

After step 4, the duplicated trust kernel is gone. Pattern doc gets updated to reference the published library instead of the issue.

## Test plan

**Library unit tests (in `packages/scope-guard/__tests__/`):**

- `validateHubJwt`: signature pass, signature fail, wrong-issuer rejection, expired token, missing-kid, missing-`sub`, JWKS unreachable.
- Audience: `aud` as string match, as array match, mismatch (string), mismatch (array), missing when expected, no expectation set.
- `parseScopes`: empty, null, whitespace-only, multi-scope, leading/trailing whitespace.
- `hasScope`: exact match, broad inheritance, narrowed inheritance, cross-resource non-match, non-vault scope exact-only.
- `looksLikeJwt`, `extractBearer`: standard cases.

**Integration test:**

A fake mini-module spins up a Bun server on a port, registers a route guarded by `lib.requireBearer + lib.hasScope("test:read")`, then we mint a real hub JWT (using hub's signing key path) and POST to the module. Asserts: valid JWT passes, missing scope returns 403, missing token returns 401, expired returns 401.

Lives in the lib's tests, uses hub's own signJwt as the issuer.

**Per-consumer tests stay where they are.** Vault's `hub-jwt.test.ts` keeps its current cases — they assert vault's external behavior, not the lib's internals. After the vault adoption PR they pass unchanged because the lib preserves the contract.

## Out of scope

- **Token introspection (RFC 7662).** No consumer needs it today. Add as a separate factory if/when one does.
- **OAuth 2.1 DPoP / token-binding.** Future work. Not load-bearing for the current trust model.
- **Scope-based RBAC framework with role definitions.** The lib enforces what a route declares; it doesn't define what scopes mean. That's the issuer's vocabulary.
- **Migrating the shared-secret path.** Service-to-service shared secrets (vault → scribe today) are a separate trust axis per `service-to-service-auth.md`. The Phase B2 cutover is its own work; this lib is the JWT half only.

## Open questions

- **Should `validateHubJwt` accept a JWKS getter directly** (for tests / non-default JWKS topologies), in addition to deriving one from `hubOrigin`? Tentatively yes — vault's `resetJwksCache` is a test-only escape hatch; an injectable getter is cleaner. Confirm during impl.
- **Does the lib need its own `HubJwtError` subclass hierarchy** (`HubJwtSignatureError`, `HubJwtAudienceError`, etc.) or does a single error class with a `code` field suffice? Probably the latter — services format error messages anyway. Decide during impl based on whether any consumer wants to branch on error type.
- **Versioning policy.** `@openparachute/scope-guard` starts at `0.1.0`. Pre-1.0 conventions of the broader ecosystem (rc tags) apply, but tying its rc cadence to hub's may create friction — sub-package may want independent versioning. Decide during impl-PR setup.

## References

- Issue: [parachute-hub#59](https://github.com/ParachuteComputer/parachute-hub/issues/59)
- Pattern: [`parachute-patterns/patterns/service-to-service-auth.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/service-to-service-auth.md) — already names this library as the Phase B2 convergence point
- Pattern: [`parachute-patterns/patterns/oauth-scopes.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/oauth-scopes.md) — scope vocabulary
- Pattern: [`parachute-patterns/patterns/hub-as-issuer.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/hub-as-issuer.md) — issuer trust pin
- Canonical impl: [`parachute-vault/src/hub-jwt.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/hub-jwt.ts)
- Mirror impls: [`parachute-scribe/src/hub-jwt.ts`](https://github.com/ParachuteComputer/parachute-scribe/blob/main/src/hub-jwt.ts), [`paraclaw/src/web/auth.ts`](https://github.com/ParachuteComputer/paraclaw/blob/main/src/web/auth.ts)
