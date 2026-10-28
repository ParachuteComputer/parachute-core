# release

How the v0.8 bundle is built (PLAN §3 "The bundle", §2.5). The tarball Prism ships is this tree, and it is the
candidate every contract suite runs, so what is tested is what ships.

```
parachute-core-<version>-<platform>/
  bin/parachute-core               the one command (a link into lib/packages/cli/bin)
  bin/parachute, bin/parachute-vault   the same program under its old names, for Prism and Benjamin's suite only
  runtime/bun                      the pinned Bun (bun.json), sha256-checked
  lib/                             the workspace: sources, bun.lock, a production node_modules, built admin pages
  entitlements/bun.plist           allow-jit, for runtime/bun under the hardened runtime
  package.json                     @openparachute/core, bin parachute-core
  LICENSE  THIRD-PARTY-NOTICES.txt  SOURCE.md  VERSION
  CANDIDATE.json                   what was built, and the sha256 of every other file
```

| File | What it does |
|---|---|
| `bun.json` | The Bun the bundle ships: an exact version and each platform zip's sha256, from Bun's `SHASUMS256.txt`. |
| `runtime.ts` | Downloads that zip once, refuses it unless the sha256 matches, unpacks `bun`. |
| `payload.ts` | Prunes `node_modules` to what the workspace reaches without `@huggingface/transformers` (the local embedding stack: onnxruntime, sharp, ~500 MB) and TypeScript; writes `THIRD-PARTY-NOTICES.txt`. |
| `bundle.ts` | The production install and the tree's layout. |
| `sign.ts` | macOS: signs every Mach-O ad hoc with the hardened runtime; `runtime/bun` with `entitlements/bun.plist`. |
| `pack.ts` | `<name>.tar.gz` with one top folder, and `SHA256SUMS` next to it. |
| `bun-LICENSE.md` | Bun's licence document at the pinned version (it lists the libraries Bun links), copied into the notices. |

## Build

```bash
bun install
cd contracts && bun install
bun run build:core                 # tree in .cache/candidate-core, tarball + SHA256SUMS in .cache/dist
bun run build:core -- --sign       # on macOS: signed ad hoc with the hardened runtime before it is hashed
bun run candidate                  # every suite on it; embedded/bundle checks the tree and the tarball
```

The bundle runs on its own Bun, whatever Bun is on PATH, and from any folder, a path with spaces included. The
wrappers turn Bun's transpiler cache off unless `BUN_RUNTIME_TRANSPILER_CACHE_PATH` is set, so nothing is written
outside `PARACHUTE_HOME`.

**Left out:** local semantic search (`@huggingface/transformers` and what only it needs). Semantic search is off by
default since vault 0.7.3; with it turned on and no external API, that provider fails and the vault keeps running.
An external embedding API (`EMBEDDING_API_URL`) works.

## Install for a person

`parachute-core install [--prefix <dir>]` copies the unpacked bundle to `<dir>/<version>/` and links
`<dir>/bin/parachute-core` (default `~/.local/share/parachute-core`). It touches nothing else: not the old
`~/.bun` global install, not npm's prefix, and `parachute` / `parachute-vault` are never linked anywhere
(`lifecycle/identity`).

## Signing (macOS)

Prism re-signs every Mach-O in its app with its Developer ID and the hardened runtime, and gives entitlements only
to its runtimes. The CI job `bundle-macos` does the same ad hoc, so the tree that runs there is the one that will
run inside Prism: `runtime/bun` gets `com.apple.security.cs.allow-jit` (Bun's JIT); everything else, the argon2
addon included, gets none. Ask of Prism: treat `parachute/runtime/bun` like its Node runtime.

## Publishing (not done from here)

Nothing in this repo publishes. CI keeps the signed darwin-arm64 tarball and its `SHA256SUMS` as a workflow artifact
(`bundle-macos`, 14 days). Attaching them to the Nov 9 pre-release is a separate step that needs Aaron's go. The
step, for the record (not run):

```bash
gh run download <bundle-macos run id> -n parachute-core-<version>-darwin-arm64 -D dist/
(cd dist && shasum -a 256 -c SHA256SUMS)
gh release create v0.8.0-pre.1 --prerelease --title "Parachute v0.8.0-pre.1" --notes-file <notes> \
  dist/parachute-core-<version>-darwin-arm64.tar.gz dist/SHA256SUMS
```
