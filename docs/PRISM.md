# Running Parachute v0.8 inside Prism

For Prism's host (`packaging/host/`) and its compatibility suite (`scripts/parachute-compat/run.mjs`). It says how
v0.8 runs embedded, what changed from 0.7 and what didn't, and what we'd like to ask of the suite. Every request is
yours to take or leave; until you say yes, we pass your suite as it is (it runs on every pull request here, on Linux
and on the signed macOS tree, at 0 FAIL).

## Get it

v0.8 is one program, the npm package `@openparachute/core`. Its command is **`parachute`** (`parachute-core` is the
same program under another name, kept for now). `parachute-vault` is there too, for `PARACHUTE_VAULT_BIN`.

**The bundle** (what Prism ships): a GitHub pre-release of
[ParachuteComputer/parachute-core](https://github.com/ParachuteComputer/parachute-core/releases), built by CI:

```
parachute-core-0.8.0-pre.1-darwin-arm64.tar.gz   signed ad hoc with the hardened runtime (bundle-macos)
parachute-core-0.8.0-pre.1-linux-x64.tar.gz
SHA256SUMS
```

```bash
grep darwin-arm64 SHA256SUMS | shasum -a 256 -c     # on Linux: grep linux-x64 SHA256SUMS | sha256sum -c
tar -xzf parachute-core-0.8.0-pre.1-darwin-arm64.tar.gz
PARACHUTE_BIN="$PWD/parachute-core-0.8.0-pre.1-darwin-arm64/bin/parachute"
PARACHUTE_VAULT_BIN="$PWD/parachute-core-0.8.0-pre.1-darwin-arm64/bin/parachute-vault"
```

The tree: `bin/parachute`, `bin/parachute-core`, `bin/parachute-vault` (links into `lib/`); `runtime/bun` (Bun 1.4.4,
sha256-pinned; the bundle runs on it, never on a Bun from `PATH`, and refuses to start without it, exit 69); `lib/`
(sources and a production `node_modules`, argon2 for the platform, no onnxruntime or sharp);
`entitlements/bun.plist` (`com.apple.security.cs.allow-jit`, for `runtime/bun` only); `LICENSE`,
`THIRD-PARTY-NOTICES.txt`, `SOURCE.md` (the exact commit), `VERSION`, `CANDIDATE.json` (the sha256 of every file).
It runs from any folder, a path with spaces included.

When Prism re-signs the payload, please treat `parachute/runtime/bun` like your Node runtime (the hardened runtime
plus `allow-jit`); nothing else in the tree needs an entitlement.

**npm** (for a machine with Bun 1.4+): published; `latest` and `next` are both `0.8.0-pre.1` today. It runs on the
Bun on `PATH`. `parachute-vault` is not linked into a `bin` folder; it is in the package:

| Install | `parachute` | `parachute-vault` |
|---|---|---|
| `npm i @openparachute/core` (in a project) | `node_modules/.bin/parachute` | `node_modules/@openparachute/core/packages/cli/bin/parachute-vault` |
| `npm i -g @openparachute/core@next` | `<prefix>/bin/parachute` | `<prefix>/lib/node_modules/@openparachute/core/packages/cli/bin/parachute-vault` |
| `bun add -g @openparachute/core@next` | `$BUN_INSTALL/bin/parachute` | `$BUN_INSTALL/install/global/node_modules/@openparachute/core/packages/cli/bin/parachute-vault` |

## Run it embedded

```bash
parachute bootstrap --embedded --json                     # once; Prism's installer shape: no password
parachute serve --embedded --home "$PARACHUTE_HOME" \
  --listen 127.0.0.1:<hub port> --vault-listen 127.0.0.1:<vault port> --parent-pid <prism pid>
```

**`serve --embedded`**: one command for the whole of Parachute. It starts the vault itself (today a child process
of serve, run from this install, never from `PATH`) and stops it with itself.
- `--home <dir>`, else `PARACHUTE_HOME`; with neither it exits 2 and creates nothing.
- Hub port: `--listen`, then `PORT`, then 1939. Vault port: `--vault-listen`, then `port` in
  `$PARACHUTE_HOME/vault/config.yaml`, then 1940. Only `127.0.0.1` binds; any other address exits 2. A port in use
  exits 4.
- Issuer: `PARACHUTE_HUB_ORIGIN` exactly (it must be exactly an origin, `scheme://host[:port]`, else exit 2), else
  `http://127.0.0.1:<hub port>`, decided again on every start. Every earlier issuer is kept in `embedded.json`'s
  `accepted_issuers`, so tokens minted before a port change keep verifying. `expose-state.json` and
  `hub/run/hub.port` are never read. `bootstrap --embedded` has no `--listen`: run before serve, it takes the issuer
  from `PARACHUTE_HUB_ORIGIN`, then `PORT`, else `http://127.0.0.1:1939`, and that issuer stays accepted. Give it
  the same origin or port that serve gets.
- Readiness: the hub's `/health` is 200 only once the vault answers. `GET /api/ready` is 200 once both databases are
  migrated and the vault answers. By then `run/ready.json` exists (written atomically, removed on a clean stop):

  ```json
  {"ready": true, "pid": 4242, "listen": "127.0.0.1:5100", "vault_listen": "127.0.0.1:5101",
   "issuer": "http://127.0.0.1:5100", "version": "0.8.0-pre.1", "started_at": "2026-11-05T09:00:00.000Z"}
  ```
- While it holds the home, a second serve, `parachute-vault serve`, and the install, upgrade, expose, migrate and
  module commands exit 2 with `managed_by_host`; the matching HTTP routes answer 409
  `{"error":{"code":"managed_by_host",…}}`.
- Stop: SIGTERM or SIGINT, or the `--parent-pid` process (without it, the process that started it) going away.
  `ready.json` goes, the vault stops, then the hub; exit 0 within 10 s.
- Files: folders 0700, files 0600 (WAL and SHM too), loosened modes put back on start.
- Nothing outside the home: Bun's transpiler cache is off unless you set `BUN_RUNTIME_TRANSPILER_CACHE_PATH`.

**Exit codes**, the same for `serve --embedded` and the commands around it:

| Code | Meaning |
|---|---|
| 0 | clean stop, or done |
| 2 | bad flags, or `managed_by_host` |
| 4 | a port in use |
| 5 | the home can't be used (or can't be checked without changing it) |
| 6 | the home was written by a newer Parachute. Checked read-only before anything opens it; the home is byte-identical afterwards. Only `version` still answers |
| 75 | a part (the vault, the hub) failed to start |

**`bootstrap --embedded`** `[--home <dir>] [--username <u>] [--password-file <p> | --password-fd <n>] [--vault <name>] [--json]`:
the account (default `owner`; the password is optional, and without one there is no web sign-in until
`parachute auth set-password` is run: interactive, or `--password <pw>`), the vault (default `default`, no git mirror), and the operator
token in `$PARACHUTE_HOME/operator.token` (0600, returned by path, never printed). It runs before or while serve
runs. A second run writes nothing and says `"created": false`.
`--json` → `{created, admin, vault, operator_token_file, issuer, account_created, vault_created, operator_token, web_sign_in}`.
Exit 2 also when an account with another name exists.

**Tokens and versions**, as your suite and `apps/server/src/mcp-token.ts` call them:
- `parachute auth mint-token --scope … [--expires-in s] [--service id] [--ephemeral] --json` →
  `{token, jti, exp, scopes, aud}`
- `parachute auth revoke-token <jti> --json` → `{revoked: true, jti}`
- `parachute version --json` → `{name: "@openparachute/core", version, schema, bun}`, under every name
- `parachute-vault create <name> --mint --scope write --no-mirror --json`, through `PARACHUTE_VAULT_BIN`

**Offline by default** in embedded mode (and with `serve --offline`): no update check, registry lookup, model
download, tunnel probe, Buzz poller, outbound webhook or mirror push. Our CI counts every packet that tries to leave
a private network namespace, and it must be zero.

## What stays the same from 0.7

- Under `parachute` and `parachute-vault`, every command 0.7's hub and vault had runs as it did: the names, flags and
  output shapes Prism calls are unchanged (`compat/prism` holds them).
- The HTTP API, MCP, the token format (hub-issued JWTs) and your verifier: a token minted by 0.7 still verifies.
- The home's layout and schemas: no migration on open beyond what 0.7.19 + 0.7.9 already ran. So a stock Prism home
  opens in place in embedded mode, and goes back: stop embedded, start stock 0.7.19 on the same home, and every
  write made meanwhile is there (`embedded/rollback`; pass `PARACHUTE_HUB_ORIGIN` to both, since stock works its
  issuer out differently).
- One launchd agent for Parachute instead of two (`cli/commands.ts`): `serve --embedded` starts and stops the vault.

## What else is in this build, and what comes next

- **First-run takeover:** on a machine where 0.7's hub and vault keep a home, `parachute-core takeover` says what it
  found, backs up, pauses the old programs, starts v0.8 on the same data and checks it, and keeps the old programs
  installed but off; `parachute-core takeover --rollback` goes back. A box `serve` on such a home refuses with exit 7
  until then. Embedded homes are not touched by it: Prism adopts in place, as above, and `serve --embedded` never
  refuses for this reason.
- **A signed macOS tarball every night**, so the Nov 9 build isn't the first you see. The `bundle-macos` workflow
  builds main at 06:17 UTC, runs your suite on the signed tree, and keeps the tarball and `SHA256SUMS` as an Actions
  artifact for 14 days: `gh run download <run id> -R ParachuteComputer/parachute-core -n
  parachute-core-<version>-darwin-arm64` (run ids: `gh run list -R ParachuteComputer/parachute-core -w
  bundle-macos.yml -b main`). Pull requests that touch the bundle get one too.

## Coming in 0.9 (a candidate, not released)

[#21](https://github.com/ParachuteComputer/parachute-core/pull/21) is the 0.9.0-pre.1 candidate. Your suite passes
on it unchanged (46 pass, 0 fail, on the tarball and the npm install). What changes for Prism:

- **Your commands stay as they are.** Contract v1 (`serve --embedded`, `bootstrap --embedded`, `auth mint-token`,
  `revoke-token`, `version --json`, `parachute-vault create`) is unchanged. The new front door (`parachute help`,
  `setup --embedded`, `keys new`) maps onto the same code. On an embedded home the old names print no deprecation
  line and nothing is counted. `parachute changes --json` lists every old name and what replaced it.
- **MCP: 11 tools, the old names as listed aliases.** `request-attachment-upload` and `-download` become
  `attachment-url`; `find-path` becomes `query-notes` with `path_between`; the tag tools become `manage-types`;
  `manage-token` becomes `manage-keys`. Every old name is still in `tools/list` (its description starts
  "deprecated"), so your allowlists in `agent-profiles.ts` keep working. Add `attachment-url` when you move, and
  `manage-types` and `manage-keys` to the admin-only list (`lib.mjs:19`) so that check still covers them. The tool
  list a write key sees shrinks from about 61k to 10k characters.
- **Types and tags.** A tag with fields or parents is a type. Notes gain `types` (the types among their tags) next
  to `tags`, over REST and MCP; `tags` still lists every name. `tags: [...]` writes and `tag:` queries work as today.
- **Keys.** Every token becomes a key with the same scopes; `parachute keys list` shows them. Verification is
  unchanged: a token minted by 0.8 or 0.7 still verifies. Scoping keys by type comes in 0.9.1, which moves the hub's
  schema number.
- **Upgrades.** 0.8 → 0.9 changes no schema number, so going back is code-only. The backup 0.9 takes on its first
  open skips embedded homes (`docs/UPGRADE-0.9.md` on #21). Before 0.9.1 we need to agree who backs up an embedded
  home before a newer bundle opens it: Prism, or `serve --embedded`.

## Requests for your suite (PLAN §3.1)

Each is a suggestion with its reason. What your suite checks today stays checked either way. We can send any of
them as a small patch if you'd like one; it's your suite and your call.

1. **R1. Read the vault port from `ready.json`, and don't start a second vault.** When `serve --embedded` is
   advertised, take the vault port from `run/ready.json` (`vault_listen`). If the vault is slow, report a FAIL
   rather than starting `parachute-vault serve` yourself (`run.mjs` around lines 402–405). In one program the vault
   is part of `serve`; a second vault on the same home is exactly what embedded mode refuses (`managed_by_host`),
   so the fallback can only turn a slow start into a confusing second failure. Still checked: the vault answers
   `/health` within your timeout.
2. **R2. Pass ports as flags.** When the binary advertises `--listen` and `--vault-listen`, pass them instead of
   `PORT` and a hand-written `vault/config.yaml` (lines 310–321). Flags are the embedded contract, visible in `ps`
   and in `ready.json`; writing our config file couples your host to our file layout. We keep honouring `PORT` and
   the config file either way. Still checked: the same ports, loopback only.
3. **R3. Test the no-password bootstrap too.** Add the shape your installer uses (`packaging/host/cli/setup.ts`:
   `bootstrap --embedded --json`, no password) next to the `--username --password-file` case the suite runs (line
   334). Today only one of the two shapes is tested. Still checked: `created: false` on a second run, the 0600
   token file.
4. **R4. Look at listeners where there's no `lsof`.** Off macOS, find listeners and outbound connections with `ss`
   or `/proc/net/tcp` when `lsof` is missing, and mark the `launchctl` check SKIP rather than PASS (lines 141–170).
   On a Linux machine without `lsof` those checks pass without looking. Still checked: E6 loopback-only, E9 no
   outbound, no service unit registered.
5. **R5. Run `--artifact` on a signed tree.** Sign the unpacked tree ad hoc with the hardened runtime (or take your
   signed tree) before an `--artifact` run, since your README lists artifact signing as not covered. Prism ships the
   payload re-signed (`release/sign-bundle.sh`); an unsigned run can pass where the signed one fails. Our
   `bundle-macos` job already runs your suite on our own ad hoc signed tree. Still checked: everything, on the bytes
   you ship.
6. **R6. Fixtures for exit codes 4, 5 and 6.** Port in use, home unusable, and newer data with the home
   byte-identical afterwards. They are in your E1/E7 asks, but your README lists them as not covered. We can offer
   the fixtures as a patch.
7. **R7. Skip the stock issuer shim in embedded mode.** Don't write `hub/run/hub.port` when embedded (lines 353–368).
   Embedded mode never reads that file, so writing it could hide an issuer bug. Still checked: the CLI issuer equals
   `PARACHUTE_HUB_ORIGIN` (your E6).

Not a request: E2 (Bun's transpiler cache written into `$HOME`) was a real bug on our side; the bundle fixes it.
