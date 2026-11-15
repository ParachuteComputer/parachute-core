# The v1 move plan (history)

This was section 1 of `PROCESS.md` until 2026-11. It records the plan for moving today's vault and hub into one
program, as written at the start (T-289). The line counts are from the T-289 module map, an internal planning file
that isn't in this repo (commits vault `42fbf93`, hub `53d327b`). Steps 1 and 2 have happened: the vault and hub
moved in with their history (`packages/`), and the hub runs the vault in-process. For where things stand now, read
the root README and `PROCESS.md`.

## Reuse or rewrite, module by module

Today's code is about 238,000 lines across vault, hub and cloud, not counting tests. The rule: **move what already
works and has tests; rewrite only where today's shape is the problem.** Every move lands behind the contracts.
The groups and line counts are from the T-289 module map (§2).

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
