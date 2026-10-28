# Releasing @openparachute/core

Two ways out, both built by CI from the same commit:

- **npm:** `@openparachute/core`, commands `parachute` and `parachute-core`. For a person with Bun:
  `npm i -g @openparachute/core@next` or `bun add -g @openparachute/core@next`. Built by `release/npm.ts`.
- **The bundle:** `parachute-core-<version>-<platform>.tar.gz` plus `SHA256SUMS`, with its own pinned Bun. What Prism
  ships. Built by `release/bundle.ts`, attached to a GitHub release.

The npm name `parachute` belongs to someone else, so the package stays `@openparachute/core`; its command is
`parachute`.

## Channels

| Version | npm dist-tag | Published |
|---|---|---|
| `0.8.0-dev.N` | none | never (not a release) |
| `0.8.0-pre.N` | `next` | on its own, when the merge that brings that version reaches `main` |
| `0.8.0` | `latest` | only after an approval on the GitHub environment `npm-latest` (below) |

**A merge to `main` that changes the version is the release.** `.github/workflows/release.yml` runs on it:

1. `plan` (`scripts/release-plan.ts`, unit-tested) decides. It skips a version npm already has, and a package npm
   has never seen (the first publish is by hand, below). It refuses when npm can't be read, when a dist-tag would
   move backwards, for a prerelease of a version that already shipped stable, and for a stable `X.Y.Z` unless
   `X.Y.Z-pre.N` is already on npm and nothing changed since the tag `vX.Y.Z-pre.N` but `CHANGELOG.md`,
   `RELEASING.md` and the `"version"` lines of `package.json`, `packages/cli/package.json` and `bun.lock`.
2. `build` builds the linux-x64 bundle, packs the npm package from it, and tests that `.tgz` the way the contracts
   job `npm` does: `npm i -g` and `bun add -g` into scratch prefixes, then Benjamin's suite on the npm install (0
   FAIL). That `.tgz` is the one published, checked by its sha256.
3. `publish-next` (a prerelease) or `publish-latest` (a stable, after approval) runs
   `npm publish package.tgz --tag <next|latest> --access public --provenance`. No token: npm trusted publishing
   (OIDC). Provenance is added because the repository is public.
4. `tag-record` tags `v<version>` (kept if the GitHub pre-release already made it).

To cut a prerelease: a PR that bumps `version` in `package.json` (and `packages/cli/package.json`) to the next
`0.8.0-pre.N`, CI green, merged. To promote: a PR that only drops the suffix (`0.8.0`), merged; then the approval.

## Who approves a `latest`

`publish-latest` runs in the environment `npm-latest`. Its one required reviewer is the GitHub account
`unforcedagi` (the account Uni works as), and it deploys from `main` only.

**Uni approves only after Aaron taps the approval card.** When a `latest` run waits, Uni posts an approval card to
Aaron (the version, the prerelease it promotes, the run link). Only after his tap does Uni approve the deployment,
as `unforcedagi`. Nothing else approves it. "Prevent self-review" is off on purpose: Uni both merges and approves
as `unforcedagi`, so the human step is Aaron's tap, not a second GitHub account.

The environment was made with (for the record):

```bash
gh api -X PUT repos/ParachuteComputer/parachute-core/environments/npm-latest --input - <<'EOF'
{"reviewers":[{"type":"User","id":305537573}],"prevent_self_review":false,
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF
gh api -X POST repos/ParachuteComputer/parachute-core/environments/npm-latest/deployment-branch-policies -f name=main -f type=branch
```

## One-time setup (Aaron, on his own machine and npmjs.com)

npm trusted publishing can't create a package. npm's docs, for the CLI form of the same setting: "The package
you're configuring must already exist on the npm registry"
([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)). The web form is on the package's own settings
page ([Trusted publishing](https://docs.npmjs.com/trusted-publishers): "Navigate to your package settings on
npmjs.com"), which exists only once the package does. So the first version is published once by hand, then the
trust is set. Until then `plan` skips every merge with that reason.

1. **Get the tested package.** From the GitHub pre-release `v0.8.0-pre.1` of ParachuteComputer/parachute-core,
   download `openparachute-core-0.8.0-pre.1.tgz` and `npm-SHA256SUMS`, then check it:
   `sha256sum -c npm-SHA256SUMS` (on macOS: `shasum -a 256 -c npm-SHA256SUMS`). CI built and tested this file.
2. **Publish it once.** Logged in as the npm owner of `@openparachute` (`npm whoami` says `unforced`; if not,
   `npm login`):

   ```bash
   npm publish openparachute-core-0.8.0-pre.1.tgz --tag next --access public
   ```

   npm asks for a one-time password (2FA). This one has no provenance (it was not published from CI); every later
   version has. Afterwards `npm dist-tag ls @openparachute/core` shows `next: 0.8.0-pre.1`. [inferred, check:] npm
   may also point `latest` at it, being the package's only version. Then a plain `npm i @openparachute/core` stays
   on 0.8.0-pre.1 until 0.8.0 ships (`latest` can't be removed, only moved): until then, tell people `@next`.
3. **Trust the workflow.** On npmjs.com → `@openparachute/core` → **Settings** → **Trusted Publisher** → "Select your
   publisher": **GitHub Actions**. Fill in exactly (case-sensitive; npm doesn't check them until a publish):
   - Organization or user: `ParachuteComputer`
   - Repository: `parachute-core`
   - Workflow filename: `release.yml`
   - Environment name: **leave blank** (one publisher covers both jobs; `publish-next` has no environment, and the
     `latest` gate is GitHub's `npm-latest` environment)
   - Allowed actions, if offered: `npm publish` (not `npm dist-tag`)

   Save. Or, with npm 11.15+ in a terminal (asks for 2FA once):
   `npm trust github @openparachute/core --repo ParachuteComputer/parachute-core --file release.yml`
4. **Shut the token door.** Same package → **Settings** → **Publishing access** → "Require two-factor authentication
   and disallow tokens" → **Update Package Settings**. Trusted publishing is not a token, so CI keeps working; a
   leaked token can't publish.

From then on, the next `0.8.0-pre.N` merged to `main` publishes itself to `next`, with provenance.

## If a publish fails

- `404` / `ENEEDAUTH` on publish: the trusted publisher is missing or doesn't match. Check the three fields above
  exactly (`ParachuteComputer` / `parachute-core` / `release.yml`); a renamed workflow file needs the rule changed.
- `plan` refused "older than next": two prerelease PRs merged out of order. Bump past the published one, merge again.
- `plan` skipped "never had this package": the one-time setup hasn't been done.

## The GitHub pre-release (the bundle)

The tarballs come from CI, never from a laptop: `bundle-macos` keeps the signed darwin-arm64 tarball and its
`SHA256SUMS`; the contracts job `npm` keeps the linux-x64 tarball, its `SHA256SUMS` and the npm `.tgz` (14 days).

```bash
gh run download <bundle-macos run id> -n parachute-core-<version>-darwin-arm64 -D dist/mac
gh run download <contracts run id> -n parachute-core-<version>-linux-x64 -D dist/linux
(cd dist/mac && sha256sum -c SHA256SUMS) && (cd dist/linux && sha256sum -c SHA256SUMS)
# one SHA256SUMS for both tarballs, one for the npm package
gh release create v<version> --prerelease --target <main commit> --title "<version>" --notes-file <notes> \
  dist/parachute-core-<version>-darwin-arm64.tar.gz dist/parachute-core-<version>-linux-x64.tar.gz dist/SHA256SUMS \
  dist/openparachute-core-<version>.tgz dist/npm-SHA256SUMS
```

A GitHub pre-release is not an npm publish and sends nothing to anyone.
