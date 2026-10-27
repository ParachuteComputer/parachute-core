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
bun run typecheck
```

`bun run today -- suites/today/notes.test.ts` runs one file. `--keep` keeps the temp home afterwards. The first
run clones the pinned vault and hub into `.cache/repos/` (set `PARACHUTE_REPOS` to use clones you already have).
A full `today` run takes about a minute; half of that is one contract waiting out a 30-second window.

## What runs, and where

`harness/services.ts` starts both services from the commits in [`pins.json`](pins.json):

- **hub** `53d327b`, started with its module supervisor off, so it can't spawn or re-port anything;
- **vault** `42fbf93`, started by the harness, registered with the hub through the temp home's `services.json`.

Both listen on 127.0.0.1, on random ports between 47000 and 49500, with `HOME` and `PARACHUTE_HOME` in a fresh temp
dir that is deleted afterwards. The harness never uses ports 1939–1946, and it points every issuer setting at the
throwaway hub, because today's code otherwise falls back to the live hub on 1939 (the comments in `services.ts`
say where). Test data is made up.

To run the contracts against something else (a build of this repo, a cloud deployment), write a services file in
the `Services` shape and run `CONTRACT_SERVICES=<file> bun test ./suites/today`.

## The contracts

| File | What it holds |
|---|---|
| `today/notes.test.ts` | Notes keep their body, fields, tags and path exactly. Paths are unique. An update must name the version it saw: blind writes get 428 and stale ones 409, never a silent merge. Fields merge, `null` removes. Deletes are complete. No token, no notes. |
| `today/tags.test.ts` | Types are tags with fields. Strict fields refuse bad values on create and update, including adding the type later. Loose fields accept but warn. Notes can be listed by tag (all, any) and found by a typed field. Two types that disagree about a shared field are refused. |
| `today/links-search-history.test.ts` | `[[wikilinks]]` become links both ends see. A link to a missing note resolves when the note is made, and goes away when the text does. The neighbourhood is followed two steps out. Search finds by body and forgets old words and deleted notes. Every change keeps the version before it, readable and restorable, with who made it. |
| `today/access.test.ts` | **Property tests** (fast-check). Random populations of notes with random tags. Every tag-scoped pass must see exactly the notes under its tags on list, search, get, history, links and MCP, never learn hidden tags, and never see less than a narrower pass ("only adds up", for today's passes). Scoped writers can't touch or create outside their scope; read passes can't write. A failure prints its seed; `FC_SEED=<n>` replays it, `FC_RUNS=<n>` runs more. |
| `today/consumer-connector.test.ts` | **The consumer connector**, end to end, as a consumer AI app does it: MCP 401 → protected-resource metadata → server metadata → dynamic registration → sign in and consent → PKCE code → token. Then it writes, searches, reads and updates over MCP with the official SDK. It refreshes the token, and checks that replaying a used refresh token after the 30-second retry window ends the session. A read-only approval can't write. A forged token gets 401. |
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
