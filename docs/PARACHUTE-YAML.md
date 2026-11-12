# parachute.yaml: one settings file for the home (0.9.3)

`$PARACHUTE_HOME/parachute.yaml` (default `~/.parachute/parachute.yaml`) holds settings that used to be spread over
environment variables and per-vault files. It is optional: with no file, every setting comes from where it always did.

```yaml
# Settings for this home. Comments are kept when `parachute config set` edits the file.
server:
  port: 1939                      # the hub's port (env PORT)
  bind: 127.0.0.1                 # the address the hub listens on (env PARACHUTE_BIND_HOST)
  origin: https://hub.example.com # the issuer the hub signs tokens with (env PARACHUTE_HUB_ORIGIN)
  accepted_issuers:               # older issuers that stay valid (env PARACHUTE_HUB_ORIGINS, comma-separated)
    - https://old-hub.example.com
vaults:
  notes:
    description: "What this vault is for."  # beats `description` in vault/data/notes/vault.yaml
```

## Which value wins

1. an environment variable (`PORT`, `PARACHUTE_BIND_HOST`, `PARACHUTE_HUB_ORIGIN`, `PARACHUTE_HUB_ORIGINS`);
2. `parachute.yaml`;
3. the old file (`vault.yaml`'s `description`);
4. the default (port 1939, bind 127.0.0.1, nothing for the others).

`parachute config get` says which one is in force:

```
$ PORT=1939 parachute config get server.port
server.port = 1939 (env PORT, overrides parachute.yaml 47000)
```

## Commands

- `parachute config get [key]`: the value in force and where it came from; with no key, every setting.
- `parachute config set <key> <value>`: write it. Lists take commas: `config set server.accepted_issuers https://a.example,https://b.example`.
- `parachute config unset <key>`: remove it (and any parent key it leaves empty).

Writes are atomic and the file is mode 0600. Only the edited key's own line changes; other lines and comments stay (a
comment at the end of the edited line goes). An unknown key is refused with the nearest known name. A file that is not
valid YAML stops `parachute serve` with `parachute.yaml: line N: …`; other commands say so and go on without it.

## The format

A small YAML subset: nested maps by indentation (spaces), `key: value`, `- item` lists (indented under their key) or
`[a, b]`, plain, `"double"` or `'single'` quoted text, `|` block text, and `#` comments. Anchors, folded text (`>`) and
tabs are errors. Keys this version does not know are left alone.

## Not in the file yet

`config.yaml`, `vault/.env`, hub settings in `hub.db`, `VAULT_BIND`, and the rest of `vault.yaml` (`private_tags`,
`published_tag`, `transcription`, `history`) stay where they are; `parachute changes` lists each as planned. A hub origin
set from the admin page (`hub_settings`) is not read by `parachute config get` yet. A host-managed home
(`serve --embedded`) takes its settings from the host's flags and environment, not from this file.
