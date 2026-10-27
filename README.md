# parachute-core

**Steady core, living surface.** Parachute's core is a plain vault: notes (markdown plus typed fields), tags with
schemas, links, files, history, identity and access, and a change feed. It has no opinion about how a life or a team
is organised. Apps such as Uni and Prism bring their own shape and declare what they need from the vault; the core
checks those needs and keeps every app honest about who may see and change what. The core changes slowly and is held
by tests. The surface (apps, screens, agents) can change every day on top of it.

One path is first-class from day one. Someone whose only AI is a consumer app (the Claude app, ChatGPT, a Dots-like
app) should be able to own one vault, connect that app to it over MCP, and have the app read, write and search it.
That path has its own contract, the consumer connector, and nothing ships that breaks it.

This repo is where Parachute v1 gets built as one program. Today it holds only the tests that say what that program
must do, written so they run against **today's** code first.

## What's here

| Path | What it is |
|---|---|
| [`contracts/`](contracts/) | A black-box contract suite (Bun + TypeScript). It talks to a running vault and hub over HTTP and MCP, the same doors real clients use. It never imports their code. |
| [`contracts/harness/`](contracts/harness/) | Starts a throwaway vault and hub from today's repos at pinned commits, on random local ports, in a temp home; stops and deletes them after. |
| [`PROCESS.md`](PROCESS.md) | How we build: what we reuse and what we rewrite, which tests we write, how a change lands, how people and agents work here together. |
| [`AGENTS.md`](AGENTS.md) | The short rules for any agent (Uni's workers, Benjamin's agent, reviewers) working in this repo. |
| `.github/workflows/contracts.yml` | CI: on every push and pull request, runs the contract suite against the pinned commits, then the mutants that prove it can fail. |
| [`docs/walkthrough/`](docs/walkthrough/) | The script and code for the short narrated walkthrough video. |

Run the suite (needs Bun 1.4 and git):

```bash
cd contracts
bun install
bun run today      # clones vault + hub at the pinned commits (once), starts them, runs every contract, stops them
bun run mutants    # breaks today's vault five ways; the contracts must catch each
```

[`contracts/README.md`](contracts/README.md) explains the pins, what each contract holds, the two kinds of contract
(`today` and `v1`), and how to point the suite at a different build.

## What's not decided

- **The final shape of the code.** Nothing from the vault, hub or surface has moved in yet. The order of moves is in
  `PROCESS.md`; each move lands only when the contracts still pass.
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
