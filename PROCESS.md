# How we build Parachute v1

Short and plain on purpose. Change it by pull request, like code.

## 1. Reuse or rewrite, module by module

The rule: **move what already works and has tests; rewrite only where today's shape is the problem.** Every move
lands behind the contracts. The original plan, module by module, is in
[`docs/history/v1-move-plan.md`](docs/history/v1-move-plan.md).

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

1. **One branch per task**: `<who>/<task>-<slug>`, e.g. `uni/t308-contracts`, `ben/b6-anchors`, from `next`.
   Never push to `next` or `main`. `next` is the trunk; `main` is what's released.
2. **Contracts first.** A behaviour change starts with the contract that describes it; a bug fix starts with a
   contract that fails.
3. **Pull request against `next`** with what changed, why, the suite's summary lines, and, for a new test, how you
   made it fail.
4. **CI must be green**: every job in `.github/workflows/contracts.yml` (the moved code's typecheck and tests,
   `today` and `v1`, the harness self-tests, every suite on the candidate build, Benjamin's suite, the npm package,
   and both mutant jobs).
5. **Review by someone who didn't write it.** Today that is a fresh Claude reviewer, recorded in a `## Review`
   section of the pull request body (who reviewed, the rounds, the verdict; round cap 3). GitHub approvals aren't
   used: Uni opens pull requests and merges them into `next` as `unforcedagi`, so the review section is the record. Changes to what
   a contract *means* (a rule, not a typo) need Aaron or Benjamin.
6. **Squash-merge** into `next`.
7. **Releases** are a pull request from `next` to `main` that bumps the version, merged by Aaron (`unforced`; an
   agent never merges into `main`) with a merge commit, not a squash, so the branches don't diverge. The merge publishes
   `@openparachute/core` to npm once that commit's contracts jobs pass (`RELEASING.md`). Nothing deploys from this
   repo: the hosted door (parachute-cloud) pins a core commit and deploys from there.
   While `next` carries 0.9 (npm `beta`), the 0.8 line ships from release/0.8 (cut at 53f956f): a 0.8.x fix is a
   pull request against release/0.8; one there that bumps the version is merged by Aaron and publishes 0.8.x to
   `next`/`latest` (`RELEASING.md`, "Two lines").

Pins move in their own pull requests. If a pin bump turns a contract red, someone decides whether the code or the
contract is wrong, and says so in the pull request.

## 4. Working together: Uni's workers and Benjamin's agent

- **Same rules for everyone.** `AGENTS.md` is the short version. Agents and people use the same branches, the same
  pull requests and the same CI.
- **Work arrives as a brief.** Uni writes briefs for its workers. Benjamin's agent takes work from Benjamin. Each
  pull request names its brief or issue.
- **Split by contract, not by file.** A task names the contracts it will make pass (or add). Two agents don't take
  the same contract at once. The issue says who has it.
- **Cross-review.** A pull request is reviewed by an agent that didn't write it: today a fresh Claude reviewer that
  Uni starts, and Benjamin's agent when it reviews. The reviewer runs the suite, not just reads the diff.
- **Questions go up, not around.** When a contract's meaning is unclear, the agent asks its own person (Aaron
  through Uni, or Benjamin). It doesn't guess and it doesn't edit the contract to fit the code.
- **Public repo, private data.** The repo is public. No real notes, journals or keys in tests, logs or pull
  requests. Until the CLA is reviewed and in force, only people and agents working for Aaron or Benjamin contribute.
