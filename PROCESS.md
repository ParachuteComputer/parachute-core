# How we build Parachute v1

Short and plain on purpose. Change it by pull request, like code.

## 1. Reuse or rewrite, module by module

Today's code is about 238,000 lines across vault, hub and cloud, not counting tests. The rule: **move what already
works and has tests; rewrite only where today's shape is the problem.** Every move lands behind the contracts.
The groups and line counts are from the T-289 module map (`deep/core/MODULE-MAP.md` §2, commits vault `42fbf93`,
hub `53d327b`).

| Part of v1 | Comes from | Reuse or rewrite | Why |
|---|---|---|---|
| **Vault core**: notes, types, links, history, query, hooks, MCP tools, portable markdown (~49k) | vault `core/` and storage | **Reuse**, moved as is | It's the best-tested code we have and already runtime-free (`core/src`). The contracts here are written against what it does. |
| **Tag scope → grants** | vault `src/tag-scope.ts` | **Rewrite** around one reader per identity | Today's scope is per-pass and per-path. v1 needs grants in the vault, "adds up", private notes, and one checkpoint every read goes through (deep/access). |
| **REST handlers** (5,344 lines) | vault `src/routes.ts` | **Reuse, then refactor** to take a `Host` | Tied to the machine through four imports. Making it take its host from outside ends the cloud's hand ports. |
| **Sign-in ("the door")**: OAuth, passwords, sessions, TOTP, Nostr, account pages (~35k) | hub | **Reuse** the handlers | They already take `(db, request)` and return a response. The consumer-connector contract pins their behaviour. |
| **Agent grants, Connections, hop passes, `pvk_` keys, the vault's own passwords** | hub, vault | **Drop** | The vault can't tell who acted (a renewed Connections pass has `sub = "connection"`). An agent becomes an identity with an owner and its own key. |
| **Supervisor, port table, proxy, surface host, module lifecycle** (~31k) | hub | **Drop** | One program has one router. Nothing to supervise or proxy. |
| **Host: Bun** (server, CLI, OS unit, backup, config) (~38k) | vault and hub | **Reuse**, merged into one host | Mostly glue; merge the two CLIs into one. |
| **Transcription, embedding** (~6.5k) | vault | **Reuse** as workers beside the core | Already behind provider interfaces. |
| **Built-in page** (sign in, keys, vaults, sharing, approving apps) | hub admin SPA (10k) | **Rewrite small** | Five jobs. The current SPA does many more. |
| **Live editing** | the T-271 spike, deep/live | **New** | No code in today's repos. |
| **Surface** (Notes UI and the surface host) | parachute-surface | **Stays outside** | Surfaces are apps. They talk to the core over HTTP and MCP like any other app. |
| **Buzz channel vaults** (3.4k) | hub | **Undecided** (A14) | Default: an outside agent keeps a group in step with a channel. |

The order: (1) `contracts/` against today's code (this repo, now); (2) move vault core and the door handlers in, with
a Bun host, while vault and hub keep shipping from their repos; (3) REST handlers take their host; (4) one router,
and delete the proxy and supervisor; (5) cloud depends on `core` as a package; (6) grants move into the vault;
(7) live editing. Each step lands when every `today` contract passes against the new build.

## 2. Which tests, and why unit tests are a minority

The promise Parachute makes is about behaviour at the door: what a person, an agent or an app can see and do. So
most tests stand at the door and call it.

1. **Contract tests (most).** Black-box, over HTTP and MCP, against a real running vault and hub. They are the same
   tests for today's code, for each step of the move, and later for the cloud host. They can't import our code, so
   a refactor can't quietly change them.
2. **Property tests for access.** Random notes, random tags, random passes. Every read path must agree with the
   rule, and a wider pass never sees less. Hand-written examples miss the corners where leaks live: an untagged
   note, a child tag, a note under two roots.
3. **End-to-end through the consumer path.** A consumer app connects from only the MCP URL, signs in, consents, and
   reads and writes with the official MCP SDK. It's the test of the foundation requirement.
4. **Mutants.** A test that can't fail proves nothing. `bun run mutants` breaks the vault in small, realistic ways
   and requires the right contract to go red. Every new kind of contract brings a mutant.
5. **Unit tests (few)**, only where the logic is dense and the point: the grant engine's rule, the markdown
   parser, the merge of field changes, scope parsing. Tests that restate the code or check a mock was called get
   deleted.

`v1/` holds contracts for decided behaviour that isn't built yet, marked failing. Building a feature means making one
of them pass, then moving it to `today/`.

## 3. How a change lands

1. **One branch per task**: `<who>/<task>-<slug>`, e.g. `uni/t308-contracts`, `ben/b6-anchors`. Never push to
   `main`.
2. **Contracts first.** A behaviour change starts with the contract that describes it; a bug fix starts with a
   contract that fails.
3. **Pull request** with what changed, why, the suite's summary lines, and, for a new test, how you made it fail.
4. **CI must be green**: typecheck, `today`, `v1`, mutants.
5. **Review by someone else.** The author never approves their own pull request. Code reviews can be agents.
   Changes to what a contract *means* (a rule, not a typo) need Aaron or Benjamin.
6. **Squash-merge.** Releases and deploys are separate decisions and don't happen from this repo yet.

Pins move in their own pull requests. If a pin bump turns a contract red, someone decides whether the code or the
contract is wrong, and says so in the pull request.

## 4. Working together: Uni's workers and Benjamin's agent

- **Same rules for everyone.** `AGENTS.md` is the short version. Agents and people use the same branches, the same
  pull requests and the same CI.
- **Work arrives as a brief.** Uni writes briefs for its workers. Benjamin's agent takes work from Benjamin. Each
  pull request names its brief or issue.
- **Split by contract, not by file.** A task names the contracts it will make pass (or add). Two agents don't take
  the same contract at once. The issue says who has it.
- **Cross-review.** A Uni worker's pull request is reviewed by Benjamin's agent or a different Uni worker, and the
  other way round. The reviewer runs the suite, not just reads the diff.
- **Questions go up, not around.** When a contract's meaning is unclear, the agent asks its own person (Aaron
  through Uni, or Benjamin). It doesn't guess and it doesn't edit the contract to fit the code.
- **Private by default.** No real notes, journals or keys in tests, logs or pull requests. The repo stays private.
  Until the CLA is reviewed and in force, only people and agents working for Aaron or Benjamin contribute.
