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
  the v0.8 bundle tree ([`release/`](../release/README.md)), which is what the tarball holds. `bin/parachute-core`
  and its two aliases, `runtime/bun` (the pinned Bun), `lib/` (the workspace with a production install from the
  root `bun.lock`, the embedding stack for its platform and the pinned embedding model), a `package.json` naming `@openparachute/core`, the notices and the
  entitlements. It also packs the tarball and `SHA256SUMS` into `.cache/dist/`. It is what `bun run candidate` and
  `prism-compat` run by default; CI runs them on the tarball unpacked again.
  Its `serve` runs the vault inside its own process (lane A2, `packages/cli/src/serve.ts`); `--process-model child`
  builds the fallback, where the hub starts the vault as a child, until the Nov 3 decision (PLAN §2.1).
  `bun run build:stock` builds today's hub and vault from `pins.json` into the same layout (profile `stock-0.7`);
  the suites that need the old programs (takeover, identity, rollback) find it in `.cache/candidate-stock`, or at
  `OLD_STOCK_DIR`.
- **`bun run candidate`** (`harness/run-candidate.ts`) refuses a candidate whose bytes don't match its manifest, or
  `CANDIDATE_SHA256` (CI passes the hash its build step produced). Then it starts a box: `parachute-vault create`, then
  `parachute serve` on a random port (with its vault inside, or supervised as a child on the child path). An admin pass is minted with the real CLI.
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
- **On macOS** there are no namespaces. Only a GitHub runner may run a candidate there (`GITHUB_ACTIONS=true`), with
  `bun run candidate -- --no-box`, which starts no box: CI's `bundle-macos` workflow runs `embedded/bundle` and
  Benjamin's suite on the signed tree that way.
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
that it tests the fix. When the real fix lands, its flip becomes mutants that put each bug back.

## Doors: one suite, every way of running Parachute

Parachute runs as a box (this repo), as Parachute Cloud (parachute-cloud: two Cloudflare workers) and as a personal
door (cloud's two workers on someone's own Cloudflare account, one owner). An app that holds a vault's address and a
credential must not be able to tell which one it is talking to. `suites/door/` is that promise as a test: the same
files run against each door, and then the doors are compared with each other.

```bash
bun run build:core
bun run doors                                    # the box alone
CLOUD_REPO=<parachute-cloud checkout> bun run doors -- --doors box,cloud
PERSONAL_REPO=<a checkout with deploy/personal> bun run doors -- --doors box,personal
bun run doors -- --doors box --check-golden      # CI here: the box must match its kept file in suites/door/golden
bun run doors -- --doors cloud --with-golden box-0.8   # CI in parachute-cloud: its door against the kept box
bun run doors -- --remote door.json              # a deployed door (below)
bun run moves                                    # a made-up vault through all three doors, every direction
```

- **The contracts are door-blind.** They read a door file (kind, release, where the issuer and the vault answer,
  how this run is signed in) and speak HTTP and MCP. Getting the first sign-in is the one step that differs between
  doors on purpose, so it happens in `harness/doors/` (a box's login form; cloud's sign-up; a personal door's owner
  key over NIP-98). Everything after it goes through the account door, which every door has.
- **Everything local runs in the sandbox**, on one private loopback: the built box and both workers of each cloud
  checkout (`wrangler dev`, with the always-remote Workers AI binding taken out of the config it runs from). Nothing
  reaches the network. A cloud checkout needs its dependencies installed and its engine pin materialised.
- **Two checks.** Each contract passes on each door. And each run records a *fingerprint*: what an app could
  branch on without any contract noticing. That is every MCP tool, its input schema and its words, the discovery
  documents, the status, error code and hint of each refusal, the keys and value types of each reply, the exported
  files of a fixed made-up note. `harness/doors/compare.ts` compares doors on the same release line fact by fact.
- **A difference passes only if `suites/door/deliberate.json` names it**, with why and who decides. `deliberate`
  means meant; `drift` means not meant and not yet fixed. An entry that excuses nothing fails the run, so the list
  can't outlive the differences. A contract skips itself only through an entry (`lacks`).
- **Across repos**, the box's fingerprint is kept in `suites/door/golden/`, one file per release line. CI here builds
  the box from this branch and fails when it no longer matches its file (`box-0.9.jsonl` on `next`; after a meant
  change, `bun run doors:keep box-0.9` and commit the diff). parachute-cloud's CI runs its own door from its pin of
  this folder and compares with the kept box of the release it runs (`box-0.8.jsonl` while cloud is on 0.8; that
  file was kept from `next` at 53f956f plus this suite's one fix to the box, the last 0.8 on `next`, and is checked
  again by building `release/0.8`: `CANDIDATE_DIR=<that build> bun run doors -- --doors box --check-golden`).
  Neither repo builds the other's door.
- **A deployed door** is run from a door file written by hand (`kind`, `label`, `release`, `issuer`, `vaultOrigin`,
  `signIn: {how: "nostr", secretKeyFile}`), with `DOOR_REMOTE_HOSTS` naming its hosts. The run makes two vaults of
  its own there and removes them. A `parachute.computer` host is always refused: these contracts create and delete
  vaults.

Results go to `DOOR_RESULTS` (default `.cache/doors`): `MATRIX.md` (every contract on every door), `COMPARE.md`
(every difference and its verdict), and per door the output, the junit file and the fingerprint.

`bun run moves` (`harness/doors/moves.ts`) is the same idea for moving a vault: [`tools/move`](../tools/move/README.md)
run as a person would run it, a made-up vault through box, cloud and a personal door in all six directions, each
arrival checked by digest, then the refusals (a taken name, a changed target, a source written to before it is
deleted, a note the export format can't carry).

| File | What it holds |
|---|---|
| `door/rest.test.ts` | Notes over REST: exact round trip, unique paths, 428/409 on updates, field merge, batches that keep nothing when half bad, paging by offset and by cursor, who may do what, CORS for a browser app, what a vault says about itself. |
| `door/types.test.ts` | Types: declare and read back, strict and loose fields, find by typed field with every operator, rename and delete. |
| `door/links.test.ts` | Wikilinks both ways, typed links and find-path, search that forgets, versions and restore, what an admin can list and forget. |
| `door/mcp.test.ts` | The cold 401 and both discovery addresses; per level, every tool with its schema and words; a write, a read and the refusals through the official SDK; the root `/mcp`. |
| `door/connect.test.ts` | Discovery, registration, PKCE, the token and its claims, refresh rotation and replay, read-only and admin approvals, revoke, the published keys; the account door (credential, list, mint, make and remove a vault). |
| `door/files.test.ts` | Upload, attach, byte-equal download, a ranged read, refused active content, tickets over MCP, `read-attachment` (an image block; a text window). |
| `door/exit.test.ts` | The export: every note, type and file; the bytes of a fixed made-up note are compared across doors (a box's come from its own command). |
| `door/records.test.ts`, `door/keys.test.ts` | 0.9 doors: the record door over MCP and REST. 0.9.1 doors: the owner's key (NIP-98), named app keys that stop when revoked. |

### 0.9.2: the dial works (`suites/v092/`)

Door contracts for ROADMAP 0.9.2, written before the code, one file per roadmap row. They use the door suite's
client (`door/_door.ts`) and run on the box with `bun run doors -- --doors box suites/v092` (CI's `doors` job runs
them after the door suite). Each is `red()` with the reason it fails today; the lane that makes one pass removes its
`red()` in the same pull request. They record no fingerprint, so the kept box fingerprint doesn't move. Wire shapes
not yet decided are written at the top of each file, marked proposed.

| File | What it holds |
|---|---|
| `v092/query.test.ts` | Filter and sort any field: every operator on a field that isn't indexed gives its indexed twin's rows, with a warning that it scanned (REST and MCP); a field no type declares; a word that is only in a field value is found by search. |
| `v092/schema-change.test.ts` | A retype that would strand records is refused and says how many; a dry-run migrate over REST (admin) and MCP says what would change and writes nothing. |
| `v092/field-types.test.ts` | A record with two types is checked against both; `doctor` reports a field holding two data types, declared or not. |
| `v092/teaching.test.ts` | The nearest existing name on a new type or field (a warning); `vault-info`'s tag map capped (700 types fit in about 4,000 tokens); manage-types' own schema names `reference`, `required`, `strict`, `cardinality`; search says it needs every word. |
| `v092/doctor.test.ts` | `doctor` finds a field that names records but isn't a declared reference, and names one letter apart; it counts indexed fields against 88, and the 89th is refused with what to prune. |

`suites/bench/query-092.bench.ts` is the 0.9.2 bench, not a contract: made-up records at `BENCH_N` on the box, every
operator, search, a type PUT and a retype, timed (`BENCH_N=94000 bun run doors -- --doors box suites/bench/query-092.bench.ts`).

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
| `safety/*.test.ts` | **Fixes 2, 5–8, 13–15** (PLAN §5): loopback by default, `/view` scope, scoped writes attach or detach no tag the pass can't read and can't publish (REST and MCP), every reference resolves among the notes the caller may read, deletes only to subscribers who could see the note, search answers that don't depend on hidden notes, a mint never widens, unknown permission keys refused. Fixes 5–8 and 13–15 are green on the core build (lane F, in `packages/vault` and `packages/hub`) and red on the stock build (`CANDIDATE_DIR=.cache/candidate-stock`); loopback (fix 2) is green too since lane C. They stay here, not in `today/`, because `today/` runs against the pinned stock code. |
| `safety/bare-equality.test.ts`, `safety/since.test.ts`, `safety/export-roundtrip.test.ts` | **Three things that returned a wrong answer with no error** (T-395). A bare filter finds a stored boolean or number (`{done: true}`, `?meta[done]=true`), and a string filter still means the string. `since` on MCP `query-notes` finds notes edited since then, and `date_from` still means `created_at`. Export then import gives equal digests when a list item holds a colon, and an export written before the fix restores right. Here because the pinned stock code has all three bugs. |
| `safety/forget.test.ts` | **Deleting can forget** (T-412). `DELETE /notes/:id?erase_history=true` and MCP `delete-note` with `erase_history` (and `ids`) delete a note and every version of it, need admin, and delete nothing when a list names a missing note; `GET /history/deleted` lists what plain deletes left, for an unscoped admin only. A plain delete still keeps its tombstone. Here because the pinned stock code has none of it. The wake and path-index fixes of the same task are pinned by engine tests (`packages/vault/core/src/row-costs.test.ts`) and by cloud's billed-row test, since rows read aren't visible at the door. |
| `safety/import-confine.test.ts` | **Import reads only the repo it was given** (T-419, audit L3-02). `POST /.parachute/mirror/import` refuses a local path, `file://`, `http://`, `git://`, `ext::` and a leading `-` with 400, and still takes https and ssh; a cloned repo's symlinks (a note, a folder, a sidecar, a schema, an attachment) don't bring a server file into the vault. The https remote is honest without the network: the box's own git config (`url.<repo>.insteadOf`, in the throwaway box's HOME) points one made-up https URL at a local repo. Here because the pinned stock code has both bugs. |
| `embedded/*.test.ts` | **Embedded mode for Prism** (PLAN §3): serve, issuer (fix 1), JSON outputs, newer data (fix 4), modes (fix 3), bootstrap, refusals, ready and stop, offline (outbound trap), rollback to stock, hostile local callers. Green since lane C: serve, issuer, refusals, ready-stop (its "nothing outside the home" case with lane D's bundle), hostile-local. Rollback is green too (lane C stopped the embedded vault rewriting services.json). Green since lane E: bootstrap (Prism's installer with no password, Prism's suite with `--username --password-file`, idempotent), and the embedded cases of json, modes and offline; every embedded contract now sets its home up with `bootstrap --embedded` (`embeddedHome()`). |
| `embedded/bundle.test.ts` | **The bundle as shipped** (PLAN §3 "The bundle", "Signing"): the tarball's layout; its own pinned Bun with no Bun on PATH; the tarball and `SHA256SUMS` against the tree; the embedding stack and its pinned model, no dev tools, native code only for the platform; notices for every package and the source commit; a run from a path with a space (argon2 sign-in, admin page, a write and a read); on macOS, every Mach-O signed ad hoc with the hardened runtime and only `runtime/bun` entitled (allow-jit). Green from lane D. |
| `embedded/embeddings.test.ts` | **Semantic search from a fresh install** (T-418): with it turned on and no network, a note written gets an embedding from the bundled model and a semantic search finds it; `/health` and the vault's info say `ready`. The bundle without `@huggingface/transformers` (what 0.8.0-pre.1 shipped) says `failing` on `/health` and names why in the vault's info, before any note is written. `harness/npm-package.ts` checks the same embedding from a fresh `npm i -g` and `bun add -g`. |
| `lifecycle/shutdown.test.ts` | **One shutdown coordinator** (PLAN §2.2, §7.4): every stop path keeps acknowledged writes, checkpoints the WAL, closes every port and removes its run files. |
| `lifecycle/takeover.test.ts` | **First-run takeover** (PLAN §8.0): on a machine with the old 0.7 programs installed as `bun add -g` lays them out and a fake `systemctl`: detect, dry run, `serve` refusing with exit 7, backup with a sha256 manifest, refuse while an old process holds the data (exit 7), pause only the old units that are on, same data and old passes under core, a takeover from the old box's shell, rollback with writes kept. Green since lane E. |
| `lifecycle/probe.test.ts` | **A box probe** (audit L6-03): `parachute probe` on a healthy vault prints one ok line with timings and exits 0; a vault whose database can't open (while the hub's `/health` stays green), a vault the box doesn't have, a pass for another vault, a missing canary note and a closed port each exit 1 naming the step; a pass given as an argument is refused (exit 2). The line holds no note content and no pass, and the probe touches no home. |
| `lifecycle/identity.test.ts` | **The new name** (PLAN §2.5; the command `parachute`, Aaron 10-27): `@openparachute/core`, bins `parachute` and `parachute-core`, with `parachute-vault` inside the folder only; the vault serve starts is core's own even with the old one first on PATH (green on the core build); installing it with `parachute install --prefix` links `parachute` and `parachute-core`, leaves the old global packages byte-identical, and names `parachute-core` when the old hub's `parachute` comes first on PATH (green from lanes D and R). |
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
