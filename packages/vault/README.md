# packages/vault: the vault engine

The vault inside Parachute: records (a markdown body with typed fields), types and tags, links, files, history, and
the MCP and REST doors over them. One SQLite database per vault. It ships as part of the one program, `parachute`
(npm `@openparachute/core`); it is not installed on its own any more. It came here from the archived
[parachute-vault](https://github.com/ParachuteComputer/parachute-vault) repo, history kept.

**Using Parachute, connecting an AI, writing records, types and applets:** the docs at
[parachute.computer/docs](https://parachute.computer/docs/) (every page also as markdown; an AI connected over MCP
reads them with the `docs` tool). **Running a server:** the [top-level README](../../README.md) and
[parachute.computer/docs/run/self-host](https://parachute.computer/docs/run/self-host/).

## What's here

| Path | What it is |
|---|---|
| `core/src/` | The domain: schema, store and query, wikilinks, paths, history, the MCP tools (`mcp.ts` the engine's, `mcp-surface.ts` the 0.9 record surface every door lists, `mcp-short.ts` their short descriptions, `docs-tool.ts` the `docs` tool). Shared with Parachute Cloud (`@openparachute/core/src/…`). |
| `src/` | The server and CLI around core: HTTP routes, MCP over HTTP and stdio, scopes and keys, triggers, backups. |
| `web/ui/` | The admin page. |
| `docs/` | Reference: [HTTP_API.md](docs/HTTP_API.md), [auth-model.md](docs/auth-model.md), [external-packs.md](docs/external-packs.md), design notes. |
| `deploy/`, `Dockerfile`, `docker-compose.yml`, `fly.toml`, `render.yaml`, `railway.json` | From the 0.7 standalone vault. They run the vault without the hub (no sign-in, no admin page) and aren't built or tested by this repo's CI. Use the release bundle or `parachute` instead. |

## The doors

- **MCP:** `<hub>/vault/<name>/mcp`. Tools: `query-records`, `create-record`, `update-record`, `delete-record`,
  `list-types`, `vault-info`, `docs`, `doctor`, `read-attachment`, `attachment-url`, `manage-types`, `manage-keys`
  (by level: read, write, admin). The 0.8 note-named tools still answer through 0.9 and go in 1.0.
  `vault-info { "help": "<tool>" }` returns any tool's full reference.
- **REST:** `<hub>/vault/<name>/api/records` (0.9) and `/api/notes` (0.8 words), `Authorization: Bearer <key>`.
- **Commands:** `parachute vault list|new|rename|rm|import|export|history|schema|pack|channel`, `parachute keys …`.
  The 0.7 `parachute-vault <command>` names aren't on your PATH; inside the release they answer as `parachute vault`.

A new vault starts empty. `parachute vault pack add <name>` adds a seed pack on purpose (`core/src/seed-packs.ts`).

## Tests

`bun test ./core/src/` and `bun test ./src/` (Bun); the admin page under vitest (`cd web/ui && bunx vitest run`).
Never run them on a machine with a live Parachute outside the test preload's temp home: see [CLAUDE.md](CLAUDE.md).

## Licence

AGPL: see [LICENSE](LICENSE) here and the repo's own [LICENSE](../../LICENSE).
