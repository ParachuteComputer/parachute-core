# parachute-move

Move one vault from one Parachute door to another, and prove it arrived the same. A door is a box, Parachute Cloud,
or a personal door on your own Cloudflare account. Every direction between them works.

```bash
cd tools/move && bun install
bun move.ts plan  <from.json> <to.json> --vault <name>             # changes nothing
bun move.ts run   <from.json> <to.json> --vault <name> --out <folder>
bun move.ts verify <folder>                                        # any time later: do both doors still match?
bun move.ts close  <folder> --keep "<why>" | --disconnect | --delete
```

## A door file

JSON that names a door and where its credentials are kept. It never holds a secret, only paths to files that do.

```json
{ "kind": "personal", "issuer": "https://me-identity.example.workers.dev",
  "vault_origin": "https://me-vault.example.workers.dev", "owner_key_file": "/home/me/.keys/owner.key" }
```
```json
{ "kind": "box", "home": "/home/me/.parachute", "cli": ["parachute-vault"] }
```
```json
{ "kind": "cloud", "issuer": "https://…", "vault_origin": "https://…",
  "ops_token_file": "…", "owner_email_file": "…" }
```

- **An owner** signs in with `owner_key_file` (a Nostr key, on a 0.9.1 door), or `session_file` (a browser session's
  cookie and CSRF value as JSON), or `account_token_file` (a credential already held; ten minutes on cloud).
- **An operator** moving a vault for someone adds `--operator` and names the door's operator token and the owner's
  address in files. That is how the friends box was moved into Parachute Cloud.
- **A box** is moved with its own command on the machine it runs on. Its importer needs the database to itself: the
  box is stopped for an import (`parachute stop`), and the tool says so if it isn't.
- `--production` is needed for a `parachute.computer` host, `--live-box` for this machine's own `~/.parachute`.

## What a move is

A **portable-md export** (what `GET /api/export` streams and `parachute-vault export` writes: one markdown file per
note, `.parachute/schemas/` for types, `.parachute/attachments/` for files) plus **`MOVE.json`**, the manifest:
where from, where to, the tar's sha256, every attached file's path, size and sha256, the digests before and after,
what does not travel, the verdict, and how the old door was closed.

`run` does, in order:

1. **Plan.** Both doors answer, the name is free, every file's bytes are there and fit, and every note is in a
   shape the format carries exactly. A note that isn't stops the move until you pass `--accept-format-loss`; the
   verdict then excuses exactly those notes and no others.
2. **Digest the source** (below). **Export.** Each attached file in the export must have the bytes the source has.
3. **Import into a new vault.** Never into one that exists. On an HTTP door the notes go in one tar through the
   account door (`POST /account/vaults/import`) and each file follows on its own, checked by sha256.
4. **Digest the target, and the source again.** All three must agree. A source written to during the move voids it.
5. Write `MOVE.json`, `REKEY.md` and `VERIFY.txt`. The digests' lines (ids, paths, tag names; never text) stay in
   `private/`, mode 0700.

`close` is a second command on purpose: the old door is touched only after you have looked at the new one.
`--delete` and `--disconnect` first check that nothing was written to the old door since the move, and refuse if
something was. `--delete` takes the old vault's history and the door's backups of it. `--disconnect` stops every
connected app and named key there and keeps the vault. `--keep "<why>"` records that it stays.

## The digest

Counts and a sha256 per section, read the same way at every door: over REST (notes with body, links and files;
types; each file's bytes), or from a box's database file. On a box the two readers give the same digest
(`contracts/harness/doors/moves.ts` checks it), so the database reader stands in for the door when the box is stopped.

| Section | One line per |
|---|---|
| `notes` | id, path, extension, sha256 of the body (trailing newlines aside), fields, tags, created and updated times |
| `links` | source, target, relationship |
| `attachments` | note, path, mime type, sha256 of the bytes |
| `tags_in_use`, `tag_schemas` | each name in use; each type's description, fields, relationships and parents |
| `attachment_meta`, `link_meta` | metadata on a file row or a link, when there is any |
| `bare_types` | 0.9: a type by declaration alone. 0.8 can't hold these; going down a release says how many become tags |

A difference passes only when it was named before the move. A count never excuses one.

## What does not travel

- **Earlier versions of notes.** The export doesn't carry history yet (0.9.4). The old door keeps it until closed.
- **Who wrote each note** (`created_by`, `created_via`). Counted in the manifest.
- **Credentials.** A token names the door that signed it. `REKEY.md` lists every connected app and named key at the
  old door and the new addresses. Your own Nostr key signs in at any 0.9.1 door that lists it as the owner.
- **A file's id.** Files keep their paths and bytes; their ids are new.
- **What lives on a door, not in the vault:** a box's triggers and git mirror, cloud's snapshots, published links
  that name the old host. The vault's description is set again on an HTTP door, and by hand on a box.

## Limits

- One file over 50 MiB can't enter an HTTP door (the import's limit; the same door accepts uploads up to 100 MiB).
  The plan stops and lists them.
- A box has no HTTP export or import yet, so a move to or from a box runs on the box's machine.
- On cloud, a name deleted moments ago answers "just deleted" for up to a minute; the tool waits and asks again.
