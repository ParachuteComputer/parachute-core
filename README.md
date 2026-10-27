# parachute-core

**Steady core, living surface.** Parachute's core is a plain vault: notes (markdown plus typed fields), tags with
schemas, links, files, history, identity and access, and a change feed. It has no opinion about how a life or a team
is organised. Apps such as Uni and Prism bring their own shape and declare what they need from the vault; the core
checks those needs and keeps every app honest about who may see and change what. The core changes slowly and is held
by tests. The surface (apps, screens, agents) can change every day on top of it.

This repo is where Parachute v1 gets built as one program. Today it holds only the tests that say what that program
must do, written so they run against **today's** code first.

## What's here

| Path | What it is |
|---|---|
| [`contracts/`](contracts/) | A black-box contract suite (Bun + TypeScript). It talks to a running vault and hub over HTTP and MCP, the same doors real clients use. It never imports their code. |
| [`contracts/harness/`](contracts/harness/) | Starts a throwaway vault and hub from today's repos at pinned commits, on random local ports, in a temp home; stops and deletes them after. |
| [`PROCESS.md`](PROCESS.md) | How we build: what we reuse and what we rewrite, which tests we write, how a change lands, how people and agents work here together. |
| [`AGENTS.md`](AGENTS.md) | The short rules for any agent (Uni's workers, Benjamin's agent, reviewers) working in this repo. |
| `.github/workflows/contracts.yml` | CI: runs the contract suite against the pinned commits on every push and pull request. |

Run the suite (needs Bun 1.4 and git):

```bash
cd contracts
bun install
bun run today      # clones vault + hub at the pinned commits (once), starts them, runs every contract, stops them
```

`contracts/README.md` explains the pins, the two kinds of contract (`today` and `v1`), and how to point the suite at
a different build.

## What's not decided

- **The final shape of the code.** Nothing from the vault, hub or surface has moved in yet. The order of moves is in
  `PROCESS.md`; each move lands only when the contracts still pass.
- **The grants model in code.** "Sharing only adds up, private notes for exceptions" is decided (A13). Today's code
  has no grants, so the suite checks the part today's tag-scoped tokens already promise and keeps the rest as `v1`
  contracts, written but not yet required.
- **Licence terms beyond the AGPL.** The code is AGPL-3.0. Other terms are available on request, but only after the
  contributor licence agreement (CLA) has had a legal review and is in force. Until then this repo takes no outside
  code. Who holds the copyright (Aaron or OpenParachute PBC) is also still open.
- **Prism's part.** Benjamin's feedback on the shape (comments and suggestions as attached notes, B-questions) can
  change the `v1` contracts.

## Licence

[GNU Affero General Public License v3.0](LICENSE). Other licence terms are available on request, once the CLA
question is settled (open question A4 in the Parachute v1 notes). This repository is private.
