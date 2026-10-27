# Launch smoke — clean-machine install

Run this on a fresh macOS or Linux (or a VM) with nothing pre-installed under `~/.parachute/`. Confirms the full published-artifact chain works end-to-end. Estimated time: ~10 minutes.

## Prereqs the new-user has

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Tailscale](https://tailscale.com/download) 1.82+ installed and `tailscale up` run at least once
- macOS or Linux

## 1. Install the CLI from npm

```sh
bun add -g @openparachute/hub
parachute --version           # Expect: 0.2.0
parachute --help              # Lists install, status, start, stop, restart, logs, expose, migrate
```

**Pass criteria**: version prints, help prints, no errors. `parachute` bin on PATH.

## 2. Install and start the vault

```sh
parachute install vault       # Runs bun add -g @openparachute/vault, then parachute-vault init
cat ~/.parachute/services.json   # Expect: parachute-vault entry with port 1940, paths ["/vault/default"]
parachute start vault
parachute status              # vault row shows running + healthy

# Sanity: API responds
curl -s http://127.0.0.1:1940/vault/default/.parachute/info | head -5
```

**Pass criteria**: services.json written, vault process running, info endpoint returns JSON.

## 3. Install and start notes + scribe

```sh
parachute install notes
parachute install scribe
parachute start              # Starts all installed
parachute status              # All three rows: running + healthy

# Hub + info endpoints:
curl -s http://127.0.0.1:5173/notes/.parachute/info.json   # Once notes port lands on 1942, update to 1942
curl -s http://127.0.0.1:1943/.parachute/info
```

**Pass criteria**: all three services running, each responds on its info endpoint.

## 4. Expose on the tailnet

```sh
parachute expose tailnet
# Expected output lists:
#   /                    → hub
#   /notes/              → notes
#   /vault/default       → vault
#   /scribe              → scribe
#   /.well-known/parachute.json → discovery
```

**Pass criteria**: Open `https://parachute.<tailnet>.ts.net/` in a browser on any tailnet peer. Hub renders with cards for vault + notes + scribe. Each card shows name, version, tagline, icon.

## 5. Connect Notes to Vault via OAuth

- In the hub, click Notes → `/notes/`
- App loads, prompts for vault URL
- Enter `https://parachute.<tailnet>.ts.net/vault/default/` (or leave blank if probe-default works)
- Complete OAuth (password + optional 2FA)
- Land on empty note list

**Pass criteria**: Notes successfully completes OAuth + DCR, can create and list notes.

## 6. Create, edit, link, tag

- Create a new note with path `launch-smoke` and content `Hello [[world]]`
- Create another note at `world` to resolve the wikilink
- Tag the first note with `test/smoke`
- Confirm tag appears in the Tags page and note appears in the tag filter

**Pass criteria**: CRUD works, wikilinks resolve, tags filter.

## 7. Voice memo + transcription

- Open `/notes/memo`
- Record 5 seconds saying "this is a launch smoke test"
- Stop. Note gets created with audio attachment.
- **If scribe auto-wired**: wait ~10s, note content updates with transcript.
- **If scribe NOT auto-wired**: set `SCRIBE_URL=http://127.0.0.1:1943` in `~/.parachute/vault/.env`, `parachute restart vault`, re-record.

**Pass criteria**: transcript appears in note content. Audio attachment preserved or deleted per retention mode.

## 8. Discovery + MCP sanity

```sh
# Discovery doc
curl -s https://parachute.<tailnet>.ts.net/.well-known/parachute.json | jq .

# Vault OAuth discovery (needed by MCP clients for DCR)
curl -s https://parachute.<tailnet>.ts.net/vault/default/.well-known/oauth-authorization-server | jq .

# MCP server declaration (for claude.ai connector)
# Use the URL: https://parachute.<tailnet>.ts.net/vault/default/mcp
# (verify with an MCP-capable client; not scripted here)
```

**Pass criteria**: discovery JSON has all services listed, OAuth metadata includes `issuer`, `token_endpoint`, `registration_endpoint`.

## 9. Public Funnel (optional — requires Tailscale Funnel enabled on your tailnet)

```sh
parachute expose public
# Opens on the public internet — same URL, now reachable from cellular/non-tailnet devices
parachute expose public off    # Teardown
```

**Pass criteria**: URL loads from a non-tailnet device (phone on cellular).

## 10. Migrate + teardown

```sh
parachute migrate --dry-run   # Should be a no-op on a clean machine
parachute expose tailnet off
parachute stop
parachute status              # All services stopped
```

**Pass criteria**: migrate reports nothing to archive; stop cleans up PIDs; status shows stopped.

---

## Failure modes to watch

- `parachute expose public` failing with `flag provided but not defined: -funnel` → Tailscale < 1.82, upgrade.
- `GET /notes/notes/...` redirect loop → old cached service worker; hard-reload browser.
- `502 Bad Gateway` on /vault/default → vault stopped; `parachute start vault`.
- Voice memo doesn't transcribe → SCRIBE_URL not set in vault's .env or scribe not running.
- Permission denied when running `parachute` → stale chmod from a bad pull; `chmod +x $(readlink ~/.bun/bin/parachute)`.

Report any issue with the specific step + error output.
