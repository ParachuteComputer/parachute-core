# The kept MCP App view

`applet-host.html.gz` is a build of `@openparachute/applet-host` (the view a host such as Claude shows for one of a
vault's approved applets; built in ParachuteComputer/parachute, `packages/applet-host`). `applet-host.json` says which
version, from which commit, and the HTML's sha256: `src/mcp-app.ts` serves it only when the hash matches.

A new build: `bun scripts/keep-applet-host.ts <dist/applet-host.html> <version> <app commit>` (from the repo root),
in its own pull request. When the package is on npm, this becomes a dependency instead.
