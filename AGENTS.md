# Working in parachute-core (for agents and people)

Read `PROCESS.md` first. The short version:

- **Contracts first.** A change in behaviour starts as a change in `contracts/`. A bug fix starts with a contract
  that fails.
- **Black box only.** Contracts talk HTTP and MCP to a running service. Never import vault or hub code into
  `contracts/`, and never mock a Parachute module to make a test pass.
- **Prove a new test can fail.** Break the service or the expectation once, watch it go red, restore it, and say how
  in the pull request.
- **`today` contracts must pass** against the pinned commits in `contracts/pins.json`. `v1` contracts describe
  decided behaviour today's code lacks. Moving one from `v1` to `today` is its own pull request.
- **One branch per task**, named `<owner>/<task>-<slug>` (for example `uni/t308-contracts`, `ben/b6-anchors`),
  from `next`. Open a pull request against `next`; never push to `next` or `main`. `next` is the trunk. `main` is
  what's released: a merge to `main` that changes the version publishes to npm (`RELEASING.md`), so work reaches
  `main` only by a pull request from `next`.
- **CI green before merge**: every `contracts` job (`PROCESS.md` §3).
- **Review by someone who didn't write it.** In practice that is a fresh Claude reviewer (an agent that didn't write
  the code), recorded in a `## Review` section of the pull request body with its verdict, round cap 3. GitHub
  approvals aren't used: Uni opens and merges pull requests as `unforcedagi`, after the review says ship. Changes to
  what a contract *means* need Aaron or Benjamin.
- **Test data is made up.** No real notes, journals, keys or `.env` contents, ever. The harness runs on random
  local ports in a temp home; never point the suite at a live vault or hub.
- **This repo is public.** Everything in code, tests, commits and pull requests is world-readable: no private
  notes, names from anyone's journal, internal hostnames or secrets.
- **No outside code** until the CLA is reviewed and in force (see README, Licence).
- **Releases happen here, deploys don't.** npm releases publish from `main` (`RELEASING.md`); don't publish by hand.
  The hosted door deploys from parachute-cloud, which pins a core commit.
