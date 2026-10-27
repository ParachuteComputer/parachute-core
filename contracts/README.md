# contracts

Black-box tests that say what Parachute must do. They speak HTTP and MCP to running services, through the same
doors real clients use, and never import vault or hub code. Today they run against today's hub and vault, so they
guard every step of the move into this repo: a step lands only when they still pass.

## Run

Needs Bun 1.4 and git. From this folder:

```bash
bun install
bun run today        # start a throwaway hub + vault from the pinned commits, run suites/today, stop them
bun run v1           # the v1 contracts: decided behaviour that today's code lacks (marked failing)
bun run mutants      # break today's vault five ways and check the contracts catch each one
bun run selftest     # the harness's own safety checks (below)
bun run typecheck

bun run build:stock      # build today's code as a candidate (.cache/candidate-stock)
bun run candidate        # every suite against that candidate, in a sandbox (below)
bun run prism-compat     # Benjamin's compatibility suite against the candidate
bun run mutants:candidate  # mutants and flips on rebuilt candidates
```

`bun run today -- suites/today/notes.test.ts` runs one file. `--keep` keeps the temp home afterwards. The first
run clones the pinned vault and hub into `.cache/repos/` (set `PARACHUTE_REPOS` to use clones you already have).
A full `today` run takes about a minute; half of that is one contract waiting out a 30-second window.

## What runs, and where

`harness/services.ts` starts both services from the commits in [`pins.json`](pins.json):

- **hub** `53d327b`, started with its module supervisor off, so it can't spawn or re-port anything;
- **vault** `42fbf93`, started by the harness, registered with the hub through the temp home's `services.json`.

Both listen on 127.0.0.1, on random ports between 47000 and 49500, with `HOME` and `PARACHUTE_HOME` in a fresh temp
dir. The harness points every issuer setting at the throwaway hub, because today's code otherwise falls back to the
live hub on 1939 (the comments in `services.ts` say where). Test data is made up.

What keeps a run away from the live install, each held by a test in `harness/selftest/`:

- **Every request goes through one guard** (`harness/guard.ts`). Only the throwaway hub and vault may be called,
  the live ports 1939–1946 are refused even if registered, and redirects are returned instead of followed, so a
  bounced request can't carry a cookie, code or token anywhere else. The MCP client uses the same guard. A
  self-test fails if any file calls `fetch()` directly.
- **Cleanup always finishes.** `stopAll()` (what the signal handlers call) waits for any cleanup already under way.
  The services also preload `harness/watchdog.ts` and exit within half a second if the harness dies, even by
  SIGKILL. The next run deletes temp homes whose owner process is gone, but never homes kept with `--keep`, and
  never another user's.
- **A pinned run runs the pinned code.** A cached checkout with edited tracked files, untracked files or unexpected
  ignored files is refused. The only ignored files allowed are `node_modules/` and the hub's `packages/*/dist/`,
  which its install builds. Their bytes are hashed at install time and checked on every run. Every run prints what
  it ran, e.g. `[contracts] code: vault 42fbf93 (clean), hub 53d327b (clean)`. A deliberate run against other code
  (`VAULT_REPO_DIR` / `HUB_REPO_DIR`, which the mutants use) says `NOT PINNED`.
  Files hidden from `git status` (skip-worktree, assume-unchanged) are refused too. **Not checked:** the contents
  of `node_modules/`. Dependencies come from `bun install --frozen-lockfile` against each repo's lockfile, but a
  hand-edited file inside them would go unnoticed. Delete `.cache/repos` if in doubt; CI starts from a cache keyed
  on `pins.json`.

To run the contracts against something else (a build of this repo, a cloud deployment), write a services file in
the `Services` shape and run `CONTRACT_SERVICES=<file> bun test ./suites/today`.

## The candidate (v0.8)

The pinned run above helps the code under test: it writes `hub/run/hub.port` and `vault/config.yaml`, starts the hub
with its supervisor off and the vault by hand. That hides exactly the issuer, supervisor and process-model bugs v0.8
changes. So v0.8's suites run against **the candidate**: a built `parachute`, launched the way a user launches it.

- **A candidate** is a folder with `bin/parachute`, `bin/parachute-vault` and `CANDIDATE.json` (what it is, and a
  sha256 of every other file). `bun run build:core` builds this repo's workspace that way, with profile `v0.8`:
  `bin/parachute-core` and its two aliases, `lib/` (the workspace, installed from the root `bun.lock`) and a
  `package.json` naming `@openparachute/core`. It is what `bun run candidate` and `prism-compat` run by default.
  `bun run build:stock` builds today's hub and vault from `pins.json` into the same layout (profile `stock-0.7`);
  the suites that need the old programs (takeover, identity, rollback) find it in `.cache/candidate-stock`, or at
  `OLD_STOCK_DIR`.
- **`bun run candidate`** (`harness/run-candidate.ts`) refuses a candidate whose bytes don't match its manifest, or
  `CANDIDATE_SHA256` (CI passes the hash its build step produced). Then it starts a box: `parachute-vault create`, then
  `parachute serve` on a random port with the hub supervising its vault. An admin pass is minted with the real CLI.
  It checks that every listening socket belongs to a process started from the candidate folder. It prints the hash,
  the source, the process model (as built and as seen) and any workaround, and hashes the candidate again after the
  run. The stock profile needs two workarounds, both fix 1, printed every run: it writes `hub/run/hub.port`, and it sets
  `PARACHUTE_HUB_JWKS_ORIGIN` (a hub-started vault otherwise looks for keys on :1939). A `v0.8` candidate may need none,
  and the core build needs none: fix 1's first half is in `packages/hub`.
- **The sandbox** (`harness/sandbox.ts`): every candidate run re-executes itself under `unshare` in its own network
  and PID namespace. Today's box puts its vault on :1940 whatever the hub's port, and a box like uni has its live
  vault there. Inside, only loopback exists, plus a dummy interface holding the default route. An nftables counter
  counts every packet that tries to leave (`outboundPackets()`). The guard still refuses 1939–1946. On Ubuntu 24.04
  runners, CI turns off AppArmor's unprivileged user-namespace restriction first.
- **Suites that start the candidate themselves** (`embedded/`, `lifecycle/`) use `suites/candidate-lib.ts`:
  `newHome()`, `cli()`, `start()`, `listeners()`, `outboundPackets()`.

### Red today: `red()`

v0.8's contracts are written before the code, so most are red on today's code. `red(name, {reason, lane}, fn)`
(`suites/lib.ts`) wraps such a contract:
- it passes only while the body fails with an error matching `reason`;
- if the body passes, it fails with `now green`, and the lane that made it pass removes `red()` in the same PR;
- if the body fails for another reason, it fails too, so a broken setup can't pass as an expected failure;
- with `CONTRACT_RELEASE=1` it is a plain test, because release suites can't contain expected failures;
- `RED_SHOW=1` runs them plainly, to read why each fails.

Use `must(cond, "reason")` so the reason can be matched.

### Benjamin's suite

`bun run prism-compat` runs Prism's `scripts/parachute-compat/run.mjs` unchanged against the candidate, inside the
sandbox. It is fetched at the commit in `pins.json` and never copied here (it is his code, under his licence). It is
the Nov 9 gate: 0 FAIL from slice 1 on. Until then, each FAIL today's code gets is listed in
`prism-compat-expected.json` with its reason and lane. The run fails on any FAIL that isn't listed, and on any listed
one that now passes.

### Mutants and flips on the candidate

`bun run mutants:candidate` copies the workspace once, applies each mutant to `packages/vault`, `packages/hub` or
`packages/cli` in a copy, rebuilds the core candidate, and requires the named contracts to go red
(`harness/mutants.ts`). **Flips** go the other way: a small fix to today's code that must turn
named `red()` contracts "now green". A contract that is red today and green under the fix has a red/green proof
that it tests the fix.

## The contracts

| File | What it holds |
|---|---|
| `today/notes.test.ts` | Notes keep their body, fields, tags and path exactly. Paths are unique. An update must name the version it saw: blind writes get 428 and stale ones 409, never a silent merge. Fields merge, `null` removes. Deletes are complete. No token, no notes. |
| `today/tags.test.ts` | Types are tags with fields. Strict fields refuse bad values on create and update, including adding the type later. Loose fields accept but warn. Notes can be listed by tag (all, any) and found by a typed field. Two types that disagree about a shared field are refused. |
| `today/links-search-history.test.ts` | `[[wikilinks]]` become links both ends see. A link to a missing note resolves when the note is made, and goes away when the text does. The neighbourhood is followed two steps out. Search finds by body and forgets old words and deleted notes. Every change keeps the version before it, readable and restorable, with who made it. |
| `today/access.test.ts` | **Property tests** (fast-check). Random populations of notes with random tags. Every tag-scoped pass must see exactly the notes under its tags on list, search, get, history, links and MCP, never learn hidden tags, and never see less than a narrower pass ("only adds up", for today's passes). Scoped writers can't touch or create outside their scope; read passes can't write. A failure prints its seed; `FC_SEED=<n>` replays it, `FC_RUNS=<n>` runs more. |
| `today/consumer-connector.test.ts` | **The consumer connector**, end to end, as a consumer AI app does it: MCP 401 → protected-resource metadata → server metadata → dynamic registration → sign in and consent → PKCE code → token. Then it writes, searches, reads and updates over MCP with the official SDK. It refreshes the token, and checks that replaying a used refresh token after the 30-second retry window ends the session. A read-only approval can't write. A forged token gets 401. |
| `compat/prism.test.ts` | **What Prism relies on**, from its code: passes as it mints them, its JWT check, REST shapes and 409/428s, tag-schema rights, MCP tools per scope against its allowlists, revocation. Green today; must stay green. Candidate only. |
| `compat/uni.test.ts` | **One probe per client of uni's box** (`uni-writers.json`: call shapes only), NIP-98 in both shapes, single-use events and tickets, one process per `vault.db`, config files unchanged across a restart. Green today. Candidate only. |
| `safety/*.test.ts` | **Fixes 2, 5–8, 13–15** (PLAN §5): loopback by default, `/view` scope, scoped writes add no outside or private tag, deletes only to subscribers who could see the note, search scores leak nothing, a mint never widens, unknown permission keys refused. Red today; each moves to `today/` when fixed. |
| `embedded/*.test.ts` | **Embedded mode for Prism** (PLAN §3): serve, issuer (fix 1), JSON outputs, newer data (fix 4), modes (fix 3), bootstrap, refusals, ready and stop, offline (outbound trap), rollback to stock, hostile local callers. Red today, except issuer's CLI and box tests and `version --json` (green on the core build). |
| `lifecycle/shutdown.test.ts` | **One shutdown coordinator** (PLAN §2.2, §7.4): every stop path keeps acknowledged writes, checkpoints the WAL, closes every port and removes its run files. |
| `lifecycle/takeover.test.ts` | **First-run takeover** (PLAN §8.0): detect, dry run, backup, refuse while an old process holds the data, pause old units, same data, rollback. Red today. |
| `lifecycle/identity.test.ts` | **The new name** (PLAN §2.5): `@openparachute/core` / `parachute-core`, with `parachute` and `parachute-vault` as aliases; the vault serve starts is core's own even with the old one first on PATH (green on the core build); installing it leaves the old global packages byte-identical (red until lane D). |
| `v1/sharing.test.ts` | Grants (who × what × how much). A pass alone grants nothing. Grants add up. Private notes are the exception inside a shared page. Revoking takes effect at once. |
| `v1/connector-attribution.test.ts` | When an app writes for a person, the note names both. |

### today and v1

- **`today`** contracts must pass against the pins. CI runs them on every push and pull request.
- **`v1`** contracts describe behaviour Aaron has decided for v1 that today's code lacks. They are `test.failing`:
  green while the behaviour is missing, red the day it works. That red is the signal to move the test to
  `today/` in its own pull request. `V1_SHOW=1 bun run v1` shows why each fails today. Each v1 file also has a
  plain test that its setup works, so a broken setup can't pass as an "expected failure".

### Mutants

`harness/mutate.ts` proves the suite can fail. For each mutant it checks the pinned vault out into a temp git
worktree, applies a one-line bug, runs the contract file that should catch it, and requires red. These are the five
bugs:

1. a scoped pass treated as unscoped;
2. untagged notes shown to everyone;
3. history switched off;
4. a stale write that wins;
5. a wrong MCP resource URL in discovery.

CI runs them after the main job. Add a mutant whenever you add a contract that guards something new.

## Bumping the pins

Change `pins.json` in its own pull request, run `bun run today` and `bun run mutants`, and paste the summary lines
into the pull request. If a contract now fails, that's a change in behaviour: either the new code is wrong, or the
contract changes, and that's a decision for Aaron or Benjamin, not a quiet edit.
