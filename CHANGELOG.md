# Changelog: @openparachute/core

The 0.8 line ships from `release/0.8` (RELEASING.md). Each section says what changed since the one below it, for
someone running Parachute. Pull request numbers are in brackets.

## 0.8.0-pre.4 (the code 0.8.0 ships)

0.8.0 is this prerelease with the suffix dropped: the same code, only the version lines and these notes change.

**Semantic search works from a fresh install.**
- The bundle carries the embedding stack for its own platform (`@huggingface/transformers`, `onnxruntime-node`,
  `sharp`) and the model it uses (`Xenova/bge-small-en-v1.5`, q8, pinned by revision and sha256). The vault reads the
  shipped model and never downloads it, so it embeds offline. 0.8.0-pre.1 left the stack out, so a home with semantic
  search on failed every embed with one log line per note while it looked healthy (#50).
- When it can't embed, it says so. The vault's own `/health` carries `embeddings.state` (`off`, `loading`, `ready`
  or `failing`); the vault's info (`/vault/<name>/api/vault`) and `/vault/<name>/api/health` add the reason. The
  hub's `/health` on a box doesn't carry it (#50).
- The cost: the linux-x64 tarball grows from about 62 MB to 118 MB. The npm package makes the stack an optional
  dependency (about 650 MB across platforms; on linux-x64 onnxruntime-node's install script also downloads), so a
  machine where sharp can't build still installs, and the vault's info says why search is failing (#50).

**Safer by default** (from the 11-08 audit):
- Changing a vault's description needs an admin pass. Every AI connection reads it, so a write pass could plant
  instructions there. A config-only change (the Notes app's audio retention) still needs only write (#53).
- A pass scoped to some tags can't reach the whole-vault routes (triggers, mirror, config, embeddings,
  transcription), its stats count only the notes it can see, and the bare vault root needs read (#53).
- The consent page shows where the app will send you back. App names that pass for Parachute's own are refused at
  sign-up, and an approval you gave one app no longer carries over to a stranger's app of the same name (#54).
- Mirror import takes only `https://` and ssh remotes and never follows a symlink out of the clone (#52).

**Right answers.**
- A bare metadata filter finds booleans, numbers and null (`{done: true}`, `{streak: 4}` found nothing before).
  A stored string that reads the same still matches. A live subscription's bare filter now accepts exactly what
  the query finds; it used to take a stored 5 for `"5"` (#47).
- List items with a colon round-trip; `since` means "changed since" (#47).
- A batch that fails part-way keeps nothing on a Durable Object (cloud), as it already did on a box. Its hooks run
  after the commit (#58). Cloud and the box run the same live-update matcher (#59).
- A vault description of several paragraphs is read back whole (#63).

**Lighter and easier to run.**
- Restarting no longer renames a note whose path differs from another's only by case or extension (the second
  became `<path>-1`). Notes already renamed that way stay renamed (#48).
- Waking a vault writes nothing and path lookups use an index, which cuts the rows cloud bills for. An admin can
  now delete a note together with its history, on request; a plain delete still keeps it (#48).
- `parachute probe` opens one vault through the hub (REST and MCP) and prints one line, ok or the step that failed.
  `docs/probe/` has a canary vault, a read-only pass and systemd units that run it every five minutes (#56).
- An MCP tool that crashes leaves one line in the server log, with no note content in it (#57).
- 0.8 reports its own version in `parachute status`, `/health` and doctor, instead of 0.7's (#46).
- A browser MCP client can call a box: CORS allows the MCP request headers (#63).

**How it ships.** CI runs on `next` and `release/0.8`, and npm publishes only after every contracts job passed on the
same commit (#55). 0.8.x ships from `release/0.8`; `next` and `main` carry 0.9 (#61).

## 0.8.0-pre.3

- A fresh `parachute init` runs 0.8's own vault. Before, it installed npm's 0.7 vault beside it, and `parachute
  upgrade` reached for 0.7 packages (#42).
- Export: attachment links in an exported note point at the exported files, so pictures show in a file browser,
  an editor or Obsidian (#35). A note with no path exports under its title, not its id (#41).
- docs/PRISM.md says what Prism's host meets today and how to install from npm (#34, #40).
