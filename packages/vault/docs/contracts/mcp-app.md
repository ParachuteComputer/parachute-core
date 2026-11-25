# A vault's applets as an MCP App (T-476)

Approved by Aaron 11-24 (inclaude proposal: "applets stay sealed and approved exactly as in our app"; "one tile per
applet"; "the view ships as a versioned package"). Code: `src/mcp-app.ts`, `src/applet-approvals.ts`; hub
`src/api-approval-keys.ts`. Contract: `contracts/suites/mcp/app.test.ts`. The view: `@openparachute/applet-host`
(ParachuteComputer/parachute `packages/applet-host`), kept here in `src/applet-host/`.

## What a host sees on the vault door (`/vault/<name>/mcp`)

- `initialize` advertises `resources` beside `tools`.
- For each applet the person approved by code hash, one tool:

  ```json
  { "name": "open-people", "title": "People",
    "description": "Open People, a Parachute applet in the home vault, as an interactive view: …",
    "inputSchema": { "type": "object", "properties": {} },
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
    "_meta": { "ui": { "resourceUri": "ui://parachute/applet/people" }, "ui/resourceUri": "ui://parachute/applet/people",
               "openai/ui": { "entrypoints": [{ "type": "global" }] } } }
  ```

  Calling it answers one line for the model (`Opened People from the home vault.`) and `structuredContent
  {vault, applet: {id, name}}` for the view. A name for an applet that isn't offered is `unknown_tool`.
- `resources/list` names each `ui://parachute/applet/<id>`; `resources/read` answers it as `text/html;profile=mcp-app`
  (`_meta.ui.prefersBorder: false`, no CSP domains: the view loads nothing from elsewhere), the view with the applet in
  it: `<script type="application/json" id="parachute-applet">{v: 1, vault, record: {id, path, extension, tags,
  fields}, code, approval: {code, at, device}}</script>`. An applet not offered: a JSON-RPC `-32602 No resource`.

Everything is read through the door's own `query-records`, so it is what the caller's key may read. A caller with no
approved applets sees the door as before, plus the `resources` capability with an empty list.

## Which applets are offered

An applet record (tagged `applet`, a `.tsx`, `.jsx` or `.html` note with `fields.applet` {id, name}) is offered when
the newest approval for it that counts approves its code as it is now. An approval is a kind 30479 Nostr event under
`fields.approval` of a record tagged `parachute-approval` in this vault (the app writes them at
`Parachute/Approvals/<host>/<vault>/<record id>`). It counts when:

- its id is its hash and its signature holds;
- its signer is one of the keys the hub linked to the token's subject (`GET /api/approval-keys`, below), never a key
  named in a record: anyone who can write the vault can sign an event;
- its subject names this hub (an origin the vault takes tokens from), this vault, this record and this applet, and its
  `d` tag says the same;
- it isn't dated more than ten minutes ahead, nor past its year.

The newest that counts decides (a taking back wins a tie); it must approve, with `code` equal to `<kind>:<sha256 of the
code>` (HTML: the bare hash), the app's `codeHash`. Not offered: code changed since, an applet nobody approved, one
approved by another key, one taken back, one that imports components (their code is in other records).

Not checked here: the asks' hash (`scope`), which only a device computes; in a host the applet can ask for nothing but
records in its manifest's folders, which the view's sealed frame holds it to. And no floor: a door keeps no state, so
deleting the newest approval to bring back an older one for the same code works here as it does on a new device.

## `GET /api/approval-keys` (hub)

Bearer: any access token the hub signed and hasn't revoked, with a `sub`. Answers `{keys: ["<64-hex>", …]}` (that
subject's linked keys, `no-store`); 401 without a valid token. The vault asks its local hub (as it fetches the JWKS),
forwarding the caller's own bearer, and keeps the answer a minute per bearer. A token with no subject, or a hub that
doesn't answer, approves nothing.

## The view

The kept build is served only when its sha256 matches `src/applet-host/applet-host.json`. `PARACHUTE_APPLET_HOST_HTML`
names another build (a plain `.html`, re-read when it changes) for working on the view. Cloud doesn't serve it yet.
