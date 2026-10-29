# 0.8 → 0.9 on a home, and back

What happens to a Parachute home when 0.9 first opens it, how to go back, and the rule for when a release may move a
schema number. Code: `packages/cli/src/release.ts`. Contract: `contracts/suites/lifecycle/upgrade.test.ts`, which runs
the real 0.8 (`pins.json` `previous_core`, built by `bun run build:previous`).

## The rule: a schema number moves only when an older program would misread the data unsafely

The 0.8 takeover decides what a "migration" is by schema numbers alone (`takeover.ts` `detect()`): a database below
the program's number is migrated, and then rollback means restoring a backup. Every older program also refuses a
database above its own number (exit 6). So a number is a promise to older programs: "don't open this".

- **Additive and safe to ignore → no number.** 0.9.0 adds a `kind` column to the vault's tags and a `keys` table to
  the hub. 0.8 never reads either. Anything 0.8 writes meanwhile, 0.9 re-derives on its next open: a tag 0.8 made
  gets its `kind` from the rule (fields or parents → type), and a token 0.8 minted becomes a key. So 0.8 → 0.9 has
  no migration in the takeover's sense, and going back is code-only. Both are proved against the real 0.8.
- **Something an older program would misread unsafely → a number.** The first is planned for 0.9.1: keys enforced by
  type, with explicit denies. 0.8 would ignore a key's type scope and let its token read the whole vault. That is
  a leak, so 0.9.1 must move the hub's number (25), and 0.8 must refuse that `hub.db`.

## What 0.9 does the first time it opens a home

Every command (not only `serve`) checks `run/release.json` first. When it names another release, or is missing on a
home with data:

1. **Back up first.** Every database is copied with `VACUUM INTO` (a consistent copy even beside a `-wal`) to
   `<home>/../parachute-upgrade/<from>-to-<to>-<time>/home/<same path>`, with `manifest.json`: a sha256 and the
   schema number per file. It refuses with exit 5, changing nothing, when there is no room.
2. **Record the step** in `run/release.json`: `{version, previous, since, backup, state}`.
3. **A database that can't be read** is named on stderr, listed as `skipped` in the manifest and left out of the
   backup. Every readable one is still backed up first, and a restore leaves a skipped one where it is. The command
   then goes on and fails its own way if it needs the broken database (a vault that can't open stops `serve` with
   75). A home where nothing is readable records nothing. Found by the mutants job: the step used to crash first,
   which hid the vault's own start-failure path.

It leaves alone:
- a home 0.9 itself made (it already carries 0.9's structures);
- a host's embedded home (Prism's contract v1: the host keeps its own backups);
- a home the old 0.7 programs still own (the takeover's job);
- a home this release's own takeover just moved from 0.7 (`via: "takeover"`; `takeover --rollback` goes back).

Found while building it: 0.9 refused to serve (exit 7, "an older Parachute still owns") a home that 0.8 made itself,
because the takeover took any vault registered outside this exact install for the 0.7 programs. Any
`@openparachute/core` install now counts as ours.

## Going back: `parachute upgrade --rollback [--restore] [--yes] [--json]`

- **Code-only (the default).** It checks that every database is at a number the previous release opens (the number
  it had in the backup) and that nothing holds the data (exit 7 names the pid). Then it changes nothing on disk,
  records `rolled-back`, and says to start the previous release. Every 0.9 write is kept: 0.8 serves notes, keys
  and tags written under 0.9 (the contract reads them back through 0.8).
- **`--restore`.** For a release that moved a number, or when 0.9 damaged data:
  1. it asks first (or takes `--yes`), then checks nothing holds the data;
  2. it stages the backup's databases and checks each against the manifest, before anything moves;
  3. it exports every note that differs from the backup (`changed-since-<time>/<vault>.json`, the takeover's
     export) and checks again that nothing has started;
  4. it records `restoring`, moves the live databases aside (`after-<version>-<time>/`) and puts the staged ones
     in place. Every command refuses a home left `restoring` until the restore is run again to finish.
- Any 0.9 command on a rolled-back home moves it forward again, with a new backup first.

## What 0.9.1's number needs (not built; for Aaron and Benjamin)

- **The takeover contract gets a 0.9 version.** `lifecycle/takeover` asserts that a 0.7 home taken over by this
  build has no migration and a code-only rollback. With hub 25, a 0.7 home taken over by 0.9.1 *is* migrated, and
  its rollback is the restore. That changes what the contract means, so it needs Aaron or Benjamin.
- **The rollback from 0.9.1 to 0.9.0 is `--restore`**, or a down step that revokes every key narrowed by type before
  it lowers the number, so that no token becomes broader on the way back.
- **Prism's homes:** embedded homes are not backed up by this step. Before 0.9.1, decide with Benjamin whether Prism
  backs up before it hands a home to a newer bundle, or whether `serve --embedded` should.

## Rehearsal (2026-10-29, on a copy of a 0.8 home with made-up data)

See `docs/rehearsals/2026-10-29-upgrade-0.8-0.9.md`.
