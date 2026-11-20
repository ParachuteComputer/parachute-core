# packages/hub: the hub

The part of Parachute that people and apps meet first: accounts and sign-in (the OAuth issuer, passwords, Nostr
keys), keys and their scopes, the vaults' front door (`/vault/<name>/…` on port 1939), the admin page, and the
service the Parachute app reads. It ships as part of the one program, `parachute` (npm `@openparachute/core`), which
runs the vault in the same process. It came here from the archived
[parachute-hub](https://github.com/ParachuteComputer/parachute-hub) repo, history kept; `@openparachute/hub` on npm
is that 0.7 package and gets no new releases.

**Using Parachute or building on it:** [parachute.computer/docs](https://parachute.computer/docs/). **Running a
server:** the [top-level README](../../README.md) and
[parachute.computer/docs/run/self-host](https://parachute.computer/docs/run/self-host/).

## Commands

`parachute help` lists them; `parachute help --all` lists every one. The 0.9 names:

| | |
|---|---|
| `status`, `logs [-f]` | is it up, where, which vaults; the server's log |
| `vault list\|new\|rename\|rm\|…` | the vaults |
| `keys list\|new\|revoke\|approve` | keys and the apps waiting for approval |
| `user list\|password\|2fa\|pubkey add` | the people who sign in |
| `setup [expose\|mcp\|transcription]` | make something work, once |
| `serve`, `start\|stop\|restart` | run in the foreground, or the background service |
| `upgrade`, `backup`, `doctor [--fix]`, `config` | keep it well |
| `changes [<old name>]` | what 0.9 renamed (`auth mint-token`, `vault create`, `expose`, `install <service>`, …) and what replaced it; the old names still work through 0.9 |

A home that 0.7 kept (`@openparachute/hub` and `@openparachute/vault`) moves onto this program with
`parachute-core takeover`; until then `serve` refuses it.

## What's here

`src/` the server and commands, `web/` the admin page, `packages/door-contract` the contract a door (a box, or
Cloud) answers to. The `Dockerfile` and `.github/` in this folder are from the 0.7 standalone hub and aren't built
or run by this repo's CI.

## Tests

`bun test` here binds fixed ports and has written into a live home before: run it only in CI or a machine without a
live Parachute (top-level README). The contract suite in `contracts/` is the one that says what the program must do.

## Licence

AGPL: see [LICENSE](LICENSE) here and the repo's own [LICENSE](../../LICENSE).
