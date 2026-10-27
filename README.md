# parachute-core

**Steady core, living surface.** Parachute's core is a plain vault: notes (markdown plus typed fields), tags with
schemas, links, files, history, identity and access, and a change feed. It has no opinion about how a life or a team
is organised. Apps such as Uni and Prism bring their own shape and declare what they need from the vault; the core
checks those needs and keeps every app honest about who may see and change what. The core changes slowly and is held
by tests. The surface (apps, screens, agents) can change every day on top of it.

One path is first-class from day one. Someone whose only AI is a consumer app (the Claude app, ChatGPT, a Dots-like
app) should be able to own one vault, connect that app to it over MCP, and have the app read, write and search it.
That path has its own contract, the consumer connector, and nothing ships that breaks it.

This repo is where Parachute v1 gets built as one program. It holds today's vault and hub, moved in with their
history, as one workspace with one command (`parachute-core`, npm package `@openparachute/core`), and the tests that
say what that program must do, written so they ran against **today's** code first.

## What's here

| Path | What it is |
|---|---|
| [`packages/vault/`](packages/vault/) | Today's vault, moved in with `git subtree` at `42fbf93` (vault 0.7.9), history kept. |
| [`packages/hub/`](packages/hub/) | Today's hub, moved in with `git subtree` at `53d327b` (hub 0.7.19), history kept. |
| [`packages/cli/`](packages/cli/) | The one command, `parachute-core`: the hub's commands, `vault <command>` for the vault's, and `version [--json]`. `parachute` and `parachute-vault` are aliases inside the built folder only. |
| `package.json`, `bun.lock` | One Bun workspace over `packages/`. `bun.lock` keeps the versions the two repos had locked, except seven listed with their reasons in `scripts/check-dependency-tree.ts` (one otpauth and its @noble/hashes for both, the hub's @emnapi/runtime, and type packages). |
| [`contracts/`](contracts/) | A black-box contract suite (Bun + TypeScript). It talks to a running vault and hub over HTTP and MCP, the same doors real clients use. It never imports their code. |
| [`contracts/harness/`](contracts/harness/) | Starts a throwaway vault and hub from today's repos at pinned commits, on random local ports, in a temp home; stops and deletes them after. |
| [`PROCESS.md`](PROCESS.md) | How we build: what we reuse and what we rewrite, which tests we write, how a change lands, how people and agents work here together. |
| [`AGENTS.md`](AGENTS.md) | The short rules for any agent (Uni's workers, Benjamin's agent, reviewers) working in this repo. |
| `.github/workflows/contracts.yml` | CI: on every push and pull request, the moved code's own checks and tests, the contract suite against the pinned commits and against the core build, Benjamin's suite, then the mutants that prove it can fail. |
| [`docs/walkthrough/`](docs/walkthrough/) | The script and code for the short narrated walkthrough video. |

Run the suite (needs Bun 1.4 and git):

```bash
bun install          # the workspace (packages/)
cd contracts
bun install
bun run today        # clones vault + hub at the pinned commits (once), starts them, runs every contract, stops them
bun run build:core   # builds packages/ as a candidate (.cache/candidate-core)
bun run build:stock  # builds the pinned 0.7 programs, which takeover and identity need as "the old programs"
bun run candidate    # every suite against the core build, in a sandbox
bun run mutants      # breaks today's vault five ways; the contracts must catch each
```

Never run `bun test` inside `packages/vault` or `packages/hub` on a machine with a live Parachute: their tests bind
fixed ports, and history shows they have written into a live home before. CI runs them on its own runner.

[`contracts/README.md`](contracts/README.md) explains the pins, what each contract holds, the two kinds of contract
(`today` and `v1`), and how to point the suite at a different build.

## What's not decided

- **The final shape of the code.** The vault and hub have moved in as they were (lane A1), and the hub still starts
  the vault as a child process. The order of the next moves is in `PROCESS.md`; each lands only when the contracts
  still pass.
- **The grants model in code.** "Sharing only adds up, private notes for exceptions" is decided (A13). Today's code
  has no grants, so the suite checks the part today's tag-scoped tokens already promise and keeps the rest as `v1`
  contracts, written but not yet required.
- **Licence details (pending legal review).** The licence is AGPL-3.0-or-later, and the copyright line is "the
  Parachute contributors". Both are defaults until a lawyer has looked. Other terms are possible because the CLA
  lets ParachuteComputer offer them, but the CLA is still a draft. Until it has been reviewed and is in force, this
  repo takes no outside code. Who holds the copyright (Aaron or OpenParachute PBC) is also open.
- **Prism's part.** Benjamin's feedback on the shape (comments and suggestions as attached notes, B-questions) can
  change the `v1` contracts.

## Licence

Copyright © 2026 the Parachute contributors.

Licensed under the [GNU Affero General Public License, version 3 or later](LICENSE) (`AGPL-3.0-or-later`).

**Other terms on request.** The contributor licence agreement (CLA) lets ParachuteComputer offer this code under other
terms as well, for example to a company that can't use the AGPL. Ask, and we'll talk. Two things are pending legal
review: the CLA itself (open question A4 in the Parachute v1 notes), and the choice of "or later" and of the
copyright line.

This repository is private.
