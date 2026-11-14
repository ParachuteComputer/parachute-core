# 0.8 → 0.9 on a home, and back

What happens to a Parachute home when 0.9 first opens it, how to go back, and the rule for when a release may move a
schema number. Code: `packages/cli/src/release.ts` and `upgrade.ts`. Contract: `contracts/suites/lifecycle/upgrade.test.ts`, which runs
the real 0.8 (`pins.json` `previous_core`, built by `bun run build:previous`).

## The rule: a schema number moves only when an older program would misread the data unsafely

The 0.8 takeover decides what a "migration" is by schema numbers alone (`takeover.ts` `detect()`): a database below
the program's number is migrated, and then rollback means restoring a backup. Every older program also refuses a
database above its own number (exit 6). So a number is a promise to older programs: "don't open this".

- **Additive and safe to ignore → no number.** 0.9.0 adds a `kind` column to the vault's tags and a `keys` table to
  the hub. 0.8 never reads either. Anything 0.8 writes meanwhile, 0.9 re-derives on its next open: a tag 0.8 made
  gets its `kind` from the rule (fields or parents → type), and a token 0.8 minted becomes a key. So 0.8 → 0.9 has
  no migration in the takeover's sense, and going back is code-only. Both are proved against the real 0.8.
  0.9.1's owner keys (T-414) are the same kind: `keys.last_used_at` is one more additive column, and an app key
  (`POST /account/keys`) is an ordinary hub token scoped `vault:<v>:read[ write]` with a registry row, so 0.9.0 and
  0.8 honour it exactly as scoped and refuse it once revoked (through the revocation list, within its 60 s cache;
  only 0.9.1's door refuses at once). No number moves. The write stamp (0.9.1) keeps that: a named key's name rides a
  top-level `key` claim an older vault ignores (its writes say `api` there), and each revision's `via_kind` is one
  more additive column. Only a key the owner let write on behalf of others carries `permissions.acts_for`, which 0.9.0
  and 0.8 refuse, as they must: they would write its custodial writes unstamped.
- **Something an older program would misread unsafely → a number.** The first is planned for 0.9.1: keys enforced by
  type, with explicit denies. 0.8 would ignore a key's type scope and let its token read the whole vault. That is
  a leak, so 0.9.1 must move the hub's number (25), and 0.8 must refuse that `hub.db`.

## Try it first: `parachute upgrade --check [--json]`

Run 0.9's own `parachute` (the unpacked bundle's `bin/parachute`, or `bunx @openparachute/core@<0.9> upgrade --check`)
on the home, also while 0.8 is serving it. It runs the step below on a **throwaway copy** and reports:

1. a scratch folder beside the home (`.parachute-upgrade-check-*`, removed however the command ends, and by the next
   check if this one was killed);
2. every database copied consistently (`VACUUM INTO`, read the way the newer-data check reads, so not a byte of the
   home changes) and the small files a command reads (settings). Attachments, mirrors and logs are left out: the
   step doesn't read them. The release record goes along without its paths: it names the home's real backup
   folder, and nothing on the copy may write there;
3. 0.9 run on the copy as the home's first command would run: the newer-data check, the backup, the record, then
   every database opened by this release;
4. the report: the backup taken, each vault's notes, types and tags, the hub's keys, any schema number that moved
   (which would make the way back a restore), the old names the home's usage log has seen, and anything the step
   would refuse (a database it can't read, a broken `parachute.yaml`). A home the 0.7 programs still own is
   judged on the home itself, before any copy: it is the takeover's, and the check says so (exit 1).

The home itself gets no backup, no `run/release.json` and no lock, and its existing upgrade backups are not written
to. No server starts, so nothing listens and no module runs. It needs room for the databases twice (the copy, then
the step's backup of it). Exit 0: the step ran clean on the copy; 1: it failed or would be refused; 5: no room; 6:
the home was written by a newer release. Every vault database it copied must also have been opened: one it could not try (its folder is a link, or has no
`vault.yaml`) is a problem, not a pass; so is a home whose parent can't be written, where the real backup would
have nowhere to go. A database being written hard while it is copied can read as torn; the
copy is tried three times, then reported as unreadable (the home is never changed by the attempt).

**`upgrade` reads its arguments before it touches anything.** An unknown flag or service exits 2 with the home byte
for byte as it was. Found by the 0.9 beta rehearsal (2026-11-13): before `--check` was built, `upgrade --check`
backed the home up, recorded it as moved to 0.9 (`state: current`), and only then said `unknown service "--check"`.
The hub's own upgrade (a module by name, or its sweep) is handed the arguments as they were understood, and its own
lookup is asked first whether it will find the service and can read `services.json` (the same code the command
runs, without its write-back), so it can't refuse them after the step. `vault upgrade` is
refused the same way (the vault is part of this program). Every other command still takes the step first, as below.

## What 0.9 does the first time it opens a home

Every command (not only `serve`) checks `run/release.json` first. When it names another release, or is missing on a
home with data:

1. **Back up first.** Every database is copied with `VACUUM INTO` (a consistent copy even beside a `-wal`) to
   `<home>/../parachute-upgrade/<from>-to-<to>-<time>/home/<same path>`, with `manifest.json`: a sha256 and the
   schema number per file. It refuses with exit 5, changing nothing, when there is no room.
2. **Record the step** in `run/release.json`: `{version, previous, since, backup, state, channel}`. `previous` is
   the exact version where the install knows it (the versioned installer records which version its links ran
   before: `<prefix>/.store/links.json`), else the line (`0.8`). `channel` is the npm dist-tag `parachute upgrade`
   follows.

**Never under a running server.** While a Parachute server holds the home's databases, the command that would take
the step stops with exit 7 and changes nothing: a home is not recorded as moved while the older release still
serves it, and gets nothing from this one, not even a lock file. (`upgrade --check` is the way to try the step
meanwhile.) `stop`, `restart`, `status` and `logs` still run from the newer release without taking the step: right
after `parachute upgrade` installed it, the links name the newer release while the older server runs, and those
are the commands that stop it. Its next start, as the newer release, takes the step.
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

**One at a time.** Every command holds `run/release.lock` shared for as long as it runs. A backup, a catch-up and a
rollback take it alone. So a rollback never moves a database under a running command (it exits 7 and says to stop
Parachute), and a command waits while a backup or rollback runs. Once it holds the lock, a command runs the
newer-data check (exit 6) again, because a newer release may have moved the home while it waited. Known limits: a
command on a home that doesn't exist yet, or on a home the 0.7 programs still own (the takeover's), takes no lock.

## Going back: `parachute upgrade --rollback [--restore [--forget-revocations]] [--yes] [--json]`

- **Code-only (the default).** It checks that every database is at a number the previous release opens (the number
  it had in the backup) and that nothing holds the data (exit 7 names the pid). Then it changes nothing on disk,
  records `rolled-back`, and says to start the previous release. Every 0.9 write is kept: 0.8 serves notes, keys
  and tags written under 0.9 (the contract reads them back through 0.8).
- **`--restore`.** For a release that moved a number, or when 0.9 damaged data:
  1. it asks first (or takes `--yes`), then checks nothing holds the data;
  2. it stages the backup's databases and checks each against the manifest, before anything moves; then it carries
     every revocation made since the backup into the staged hub.db (below), and says how many (`revocations_kept`
     in `--json`, with `revocations_kept_by_kind`);
  3. it exports every note that differs from the backup (`changed-since-<time>/<vault>.json`, the takeover's
     export: each note's content, metadata, tags and outgoing links; a note whose only change is a tag or a link
     counts) and checks again that nothing has started;
  4. it records `restoring`, moves the live databases aside (`after-<version>-<time>/`) and puts the staged ones
     in place. Every command refuses a home left `restoring` until the restore is run again to finish.
- **The links go back too.** Where 0.9 was installed beside the previous release by the versioned installer
  (`<prefix>/bin/parachute-core` → `../<version>/bin/…`), the rollback points `<prefix>/bin` at the previous copy
  again, so a unit that runs `<prefix>/bin/parachute-core serve` (the takeover's unit) runs it at its next start,
  unchanged. A unit that starts a fixed copy instead (`parachute init` writes
  `ExecStart=<bun> <prefix>/.store/<version>-<id>/…`) does not follow the links: the rollback and `upgrade` name
  such a unit and say what to set its ExecStart to. Run again on a home already rolled back, `--rollback` only
  finishes the links if they couldn't be moved the first time. Links in `<prefix>/bin` that this installer didn't
  make are never replaced. Where no previous copy is kept (an npm
  or bun install, an unpacked tarball), it says exactly what to reinstall. The contract goes through a unit
  (`lifecycle/upgrade-unit`): after `--rollback` and a restart the unit runs 0.8 and serves every record 0.9 wrote.
- **0.9 refuses a rolled-back home.** Every 0.9 command, `serve`, the host's `serve --embedded` and `bootstrap`,
  and `config` included, stops with exit 7 and opens or writes nothing, so
  a unit still pointing at 0.9 can't move the home forward again at its next restart. The release the home was
  rolled back to serves it as its own.
- **Forward again is `parachute upgrade`, run with 0.9** (`<prefix>/<version>/bin/parachute upgrade`): refused
  while a server holds the data, then a new backup, the record, and the links on 0.9.

## Upgrading: `parachute upgrade [--channel latest|next|beta] [--json]`

With no service named, `upgrade` is this program's own (a module the hub installed is `upgrade <service>`):

- **On a home this release serves**, it asks the npm registry which version the home's channel names
  (`run/release.json` `channel`; a prerelease made or moved the home: `beta`, a stable: `latest`; `--channel`
  changes it) and installs it when it is newer. A prerelease channel also looks at `latest`, so a box on `beta`
  reaches the stable release when it ships. It never installs an older version.
  - Installed under a prefix: it downloads that version's bundle and `SHA256SUMS` from the GitHub release, checks
    the sum, and runs the new bundle's own `install --prefix`. The links switch; the old copy stays (the way
    back). A wrong sum, or a release with no bundle yet, installs nothing. The registry and the release host
    must be https (loopback excepted). The sum guards the download's integrity; the bundle is not signed, so
    its authenticity rests on GitHub's release, as a download by hand does (open: sign `SHA256SUMS`, or take the
    hash from the npm package, which has provenance).
  - Installed with npm or bun: it runs `bun add -g` / `npm install -g` with the exact version.
  - It does not restart the server. The next start runs the new release, which backs up first.
- **On a home another release served last, or one rolled back**, it takes the step with this release, as above.

**What `--restore` keeps, and what it doesn't.** Putting the backup's hub.db back must not make anything revoked
since work again (`release.ts` `keepRevocations`). It reads the live hub.db (and, on a retried restore, what an
earlier attempt moved aside), only if it is the same hub (it shares a signing key with the backup), and carries:

- **keys and tokens revoked since**, including refresh-token families revoked by a replay. A key minted *and* revoked
  since has no row in the backup, and a vault accepts any well-signed token its revocation list doesn't name, so its
  row is copied in, revoked. A token whose row is gone since (the client reaper deletes only dead rows) is revoked;
- **signing keys retired since** (the hub makes a new one when none is active);
- **approved apps removed or no longer approved**, with their grants; **consents removed or narrowed**;
- **sign-ins ended** (sessions), **invites revoked or used**, and each account's current **password and two-factor**
  secrets, so an old password doesn't work again.

A sign-in key (a Nostr pubkey) unlinked from an account since is unlinked too.

**If the later hub.db can't say what was revoked** (it can't be read, or it shares no signing key with the backup's:
another hub), the restore stops before anything moves. `--forget-revocations` restores anyway, and says that
whatever was revoked since works again.

What is not kept: whatever was *made* since the backup is gone from the hub: keys, approved apps, consents, refresh
tokens and accounts, so connectors and apps added since need adding again. A key or token minted since and still
live is revoked by the restore (`made_since` in `revocations_kept_by_kind`): the restored hub has no record of it,
so nobody could list or revoke it, and a vault would otherwise take it until it expired. Also not carried, on purpose:

- **accounts deleted since** come back, and the command names them (`not_carried` in `--json`) (their tokens and sign-ins stay revoked). Deleting an account touches every
  table that names it; delete it again after the restore;
- **changes to an account's vaults or role** (named the same way). Removing an account's last vault row means "no narrowing" to the hub,
  so carrying a removal could widen access; set them again after the restore;
- **the vault's own `tokens` table and `mcp_mint_ledger`**: vestigial since vault 0.5 (no path validates them); the
  hub's registry is what counts, and that is carried.

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
