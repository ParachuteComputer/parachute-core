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
- **One branch per task**, named `<owner>/<task>-<slug>` (for example `uni/t308-contracts`, `ben/b6-anchors`).
  Open a pull request; never push to `main`.
- **Review by someone else.** The author never approves their own pull request. Changes to what a contract
  *means* need Aaron or Benjamin.
- **Test data is made up.** No real notes, journals, keys or `.env` contents, ever. The harness runs on random
  local ports in a temp home; never point the suite at a live vault or hub.
- **No outside code** until the CLA is reviewed and in force (see README, Licence).
- **This repo is private.** Don't change its visibility, cut releases or deploy from it.
