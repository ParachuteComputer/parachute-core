# release

How the v0.8 bundle is built (PLAN §3 "The bundle", §2.5). The tarball Prism ships is this tree, and it is the
candidate every contract suite runs, so what is tested is what ships.

```
parachute-core-<version>-<platform>/
  bin/parachute                    the command (a link into lib/packages/cli/bin): the hub's 0.7 commands, and v0.8's
  bin/parachute-core               the same program under its other name (kept for now)
  bin/parachute-vault              the vault's commands under their 0.7 name, for Prism and Benjamin's suite
  runtime/bun                      the pinned Bun (bun.json), sha256-checked
  lib/                             the workspace: sources, bun.lock, a production node_modules, built admin pages
  entitlements/bun.plist           allow-jit, for runtime/bun under the hardened runtime
  package.json                     @openparachute/core, bins parachute and parachute-core
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

`parachute install [--prefix <dir>]` copies the unpacked bundle to `<dir>/<version>/` and links
`<dir>/bin/parachute` and `<dir>/bin/parachute-core` (default `~/.local/share/parachute-core`). It touches nothing
else: not the old `~/.bun` global install, not npm's prefix, not PATH or a shell's startup files, and
`parachute-vault` is never linked anywhere. When an older `parachute` (0.7's hub) comes first on PATH, it leaves it
there and says to use `parachute-core` until the takeover (`lifecycle/identity`). `parachute install <module>` is
still the hub's 0.7 module installer.

## Signing (macOS)

Prism re-signs every Mach-O in its app with its Developer ID and the hardened runtime, and gives entitlements only
to its runtimes. The CI job `bundle-macos` does the same ad hoc, so the tree that runs there is the one that will
run inside Prism: `runtime/bun` gets `com.apple.security.cs.allow-jit` (Bun's JIT); everything else, the argon2
addon included, gets none. Ask of Prism: treat `parachute/runtime/bun` like its Node runtime.

## Publishing

[`RELEASING.md`](../RELEASING.md): npm through trusted publishing (`release.yml`), and the GitHub release with the
CI-built tarballs. `npm.ts` makes the npm package from a built bundle: the same sources without `runtime/bun` or
`node_modules`, run on the Bun on PATH.
