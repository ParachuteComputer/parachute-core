# A box probe: does the vault really open?

The hub's `/health` says the process is up. It never opens a vault, so a vault whose database won't open (a bad
restore, a disk fault, data written by a newer version) still looks healthy. `parachute probe` goes the way a client
goes, through the hub, with a read-only pass for one vault, and checks five steps in order:

| Step | Request | What it proves |
|---|---|---|
| `health` | `GET <url>/health` | the hub answers |
| `vault-health` | `GET <url>/vault/<name>/api/health` | the hub routes to this vault, the pass is accepted, the vault opens |
| `read` | `GET <url>/vault/<name>/api/notes?limit=1` (or `?id=<note>` with `--note`) | a REST read works (and that note exists) |
| `mcp-initialize` | `POST <url>/vault/<name>/mcp`, `initialize` | the MCP door answers |
| `mcp-tools-list` | `POST <url>/vault/<name>/mcp`, `tools/list` | it lists at least one tool |

It prints one line and exits 0, 1 or 2:

```text
probe ok vault=canary health=1ms vault-health=8ms read=12ms mcp-initialize=13ms mcp-tools-list=9ms tools=7 total=43ms
probe FAIL vault=canary step=vault-health: status 500 (health=3ms vault-health=3ms total=6ms)
parachute probe: no pass: set PARACHUTE_PROBE_TOKEN or pass --token-file <path>      (exit 2: set up wrong)
```

The line never holds note content or the pass, and nothing the server sent is echoed. The probe never follows a
redirect and touches no Parachute home, so it can run as any user, or from another machine on your tailnet.

## Set it up

**1. A canary vault.** A vault of its own, so the probe's pass can read nothing real:

```bash
parachute vault create canary --no-mirror
```

Any vault works (`--vault journal`), but then the pass can read that vault's notes. The probe only lists one note's
metadata, with content off.

**2. A read-only pass for it**, in a file only you can read. `mint-token` prints only the token on stdout. The default
lifetime is 90 days and the cap is 365 days (`--expires-in` takes seconds). When the pass expires, the probe fails at
`vault-health` with status 401, which also tells you to mint a new one.

```bash
mkdir -p ~/.config/parachute-probe && chmod 700 ~/.config/parachute-probe
(umask 077; parachute auth mint-token --scope vault:canary:read --label probe-canary --expires-in 31536000 \
  > ~/.config/parachute-probe/token)
```

To replace it, mint again (`--json` also prints the new pass's `jti`), and revoke the old one with
`parachute auth revoke-token <jti>`.

**3. Optionally, a canary note**, so `--note canary` checks that a named note is readable:

```bash
w=$(parachute auth mint-token --scope vault:canary:write --ephemeral)
printf 'authorization: Bearer %s\n' "$w" | curl -sf -H @- -H 'content-type: application/json' \
  -d '{"path":"canary","content":"made up: the probe reads this note"}' \
  http://127.0.0.1:1939/vault/canary/api/notes >/dev/null
```

(`printf` is a shell builtin, so the pass doesn't show in `ps`; `-H @-` reads the header from stdin.)

**4. Run it by hand:**

```bash
parachute probe --url http://127.0.0.1:1939 --vault canary --token-file ~/.config/parachute-probe/token
```

`--url` is the hub's origin: `http://127.0.0.1:1939` on the box, or `https://<box>.<tailnet>.ts.net` to check the
`tailscale serve` path too. Each flag has an environment twin (`PARACHUTE_PROBE_URL`, `PARACHUTE_PROBE_VAULT`,
`PARACHUTE_PROBE_NOTE`), and `PARACHUTE_PROBE_TOKEN` can hold the pass instead of a file. A pass given as an argument
(`--token`) is refused, because arguments show in `ps`. `--timeout <ms>` bounds each request (default 10000).

## Every five minutes, with systemd

This folder has three user units:

- [`parachute-probe.service`](parachute-probe.service): one run, `Type=oneshot`, with `OnFailure=` pointing at the
  alert unit;
- [`parachute-probe.timer`](parachute-probe.timer): two minutes after boot, then `OnUnitActiveSec=5min`;
- [`parachute-probe-failed.service`](parachute-probe-failed.service): the `OnFailure=` hook. As shipped it copies the
  failing line into the journal under the tag `parachute-probe-alert`. Replace its `ExecStart` with your own alert
  (mail, a chat webhook, a push). It runs once per failed probe, so every five minutes while the vault is broken.

```bash
cat > ~/.config/parachute-probe/env <<'EOF'
PARACHUTE_PROBE_URL=http://127.0.0.1:1939
PARACHUTE_PROBE_VAULT=canary
EOF
cp docs/probe/parachute-probe*.service docs/probe/parachute-probe.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now parachute-probe.timer
loginctl enable-linger "$USER"     # so user timers run when nobody is logged in
journalctl --user -u parachute-probe.service -n 5 -o cat
```

The service runs `~/.local/share/parachute-core/bin/parachute`, where `parachute install` links it. With npm or bun,
put the path `command -v parachute` prints in `ExecStart`.

The probe watches one vault. Each vault is its own database, so a canary shows that the box can open and serve a
vault. To watch a particular vault as well, copy the service and timer under new names (and fix the `Unit=` and
paths they name), with their own env file and pass.
