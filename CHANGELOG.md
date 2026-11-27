# Changelog: @openparachute/core

The 0.9 line ships from `main` to npm `beta` (RELEASING.md); the 0.8 line keeps its own CHANGELOG on `release/0.8`.
Each section says what changed since the one below it, for someone running Parachute. Pull request numbers are in
brackets. The hub's and the vault's own changelogs (`packages/hub/CHANGELOG.md`, `packages/vault/CHANGELOG.md`) carry
the wire-level detail.

## Unreleased

**The sign-in screen.**
- A connected AI gets read and write, not admin, unless you tick admin. claude.ai asks for every scope a vault lists,
  and the consent page had admin ticked, so pressing Approve gave Claude the vault's tag schema, settings, triggers,
  backup and key minting. Discovery now lists read and write only (as Parachute Cloud does); admin starts unticked on
  the consent page, marked powerful, also when offered as additional access, for every app (Parachute's own app's
  Manage now takes one tick). If you ticked admin for an AI, a Reconnect shows the page again rather than silently
  dropping it. An app that registered itself is labelled "Self-registered" in plain words, not "External, a
  third-party app" in red. Connections approved before this keep what they were given: to take admin back from one,
  end it in the vault's list and connect again (T-476).

**The connect-time words.** The brief and the attachment tools tell an AI that `attachment-url` is for a client that
can reach the vault's host, and that from a code sandbox (as in claude.ai, whose sandbox can't reach it) a file is
stored with `add-attachment` (T-476).

**Parachute applets inside Claude.** The applets you approved in the Parachute app show in Claude as their own tiles
(an MCP App): each opens full screen and can be pinned. It runs in the app's sealed frame and reaches only the folders
its manifest names. An applet you didn't approve, or one whose code changed since, isn't offered (T-476).

**One way to refuse.** Every MCP refusal, on every door and both MCP versions, is a normal tool result marked
`isError` with `structuredContent {error_type, message, …}`. Hosts such as Claude's artifacts now see the vault's own
words instead of a generic error. Clients that read the old JSON-RPC error should read the result (T-476).

**Live pages stay current.** The `live-page` skill now tells an AI to build a page that reads again every 30 seconds
while it is on screen (`refetchInterval: 30000`, claude.ai's shortest), shows when it last read, and has a Refresh;
the brief's live-pages line names the interval. Measured in claude.ai: a page with no interval reads only when it
opens and when it calls `invalidate`; one with an interval pauses while hidden and catches up in about a second on
return. Before, Claude chose 60 seconds on its own (T-476).

## 0.9.0-pre.2

No schema number moves (hub.db stays 24): going back to 0.9.0-pre.1 is code-only (docs/UPGRADE-0.9.md). On the way
back a key held to types stops working; it never reaches more.

**Keys for an AI, held to some types of a vault.**
- `POST /account/keys` takes `types` (one vault, read or write) and `kind: "agent"`. The vault keeps the grant and
  checks it on every request (REST, MCP, `/view`, the socket); an ended or unknown grant is `401 grant_ended` on the
  next request. The key list and the write stamp say an AI wrote it (#140, #144).
- A vault admin credential that is narrowed in any way (to tags, types or a permission the hub doesn't know) can't list
  or end who reaches the vault; a mint that fails ends the grant it filed (#143).

**Sharing a vault with a person.**
- The owner invites someone to one vault by name (`invite-to-vault`, `take-back-invite`): a link that works once,
  for 7 days. The friend accepts with their own key and becomes a member (read and write, never admin). A vault's
  people are named by the stamp their writes carry (#141).
- One list of who reaches a vault: each person is one row, their sign-ins folded in; ending the row ends the
  membership and every credential of theirs for that vault (#144).
- Taking a member's vault away, or lowering their role, stops their apps at once: the tokens above what they still
  hold are revoked with their refresh tokens and the consent is narrowed. The 401 for a revoked key carries the
  vault's CORS headers, so a browser app reads "revoked" rather than a network error (#130).
- Revoking a token at `/oauth/revoke` ends the consent behind it, so the app asks again before it gets that scope
  back (#131).

**The sign-in screen.**
- The consent page grants only what is left ticked. Its boxes sat outside the form, so unticking a scope (admin for
  an AI's connector, say) still granted it (#138, security). This holds for new approvals only: a connector approved
  before this release may hold a scope you unticked. End it in the vault's list and connect again.
- Parachute's own app is no longer called "External" or "a third-party app". When the app (named exactly Parachute,
  returning only to this device, the hub, or Parachute's own sites) asks to sign in, the consent page says it is
  Parachute's own app (on this device, when it returns only here) and drops "goes to the company that runs it". With
  no hub session, the first page leads with signing in, not "send this link to your hub admin" (#147).
- After signing in, the hub only sends you on to a page of its own. A crafted sign-in link (`/login?next=/\evil.example`)
  could send a person to another site straight after they signed in. The same check now guards every place the hub
  redirects to an address given in a link: sign-in, change-password, the Nostr door, return-to and the admin app's
  approve page (#151, security).

**The setup wizard speaks plainly.** It shows the hub's real address; its last page leads with the app and the address
to give an AI (`<hub>/mcp`), with the developer items folded away; and a sign-in started in the app comes back to it
after setup (#149).

**Vault mirrors keep committing.**
- If Parachute was stopped in the middle of a mirror commit, the git mirror stopped committing for good (a stale
  `index.lock`), and only the log said so; status showed nothing. The mirror now clears a lock its own earlier run left, runs one commit at a
  time per mirror, and shows a failed commit in the vault's status until a commit lands (#150).

**Write access does more without an admin key.**
- Write may add a new type, and add fields to a type it made, over MCP (#134) and over REST, `PUT /api/types/<name>`
  (#139). Everything else about types stays admin.
- Write may list a vault's deleted records (`GET /history/deleted`), and a record put back from deletion counts as
  changed now, so syncs and Changes see it return. It comes back without its tags and type (#135).

**Upgrading a box taken over from 0.7.**
- The takeover fences off the old units it pauses (a systemd drop-in that refuses every start), and core's `serve`
  fences any such unit left by an earlier release at its first start. Before, a paused `parachute-hub.service` could
  start during an upgrade and serve the home with 0.7 (#128).

**For door builders.**
- The door harness runs a one-address personal door as one address (#142).
- Parachute Cloud and a personal door now behave as a box does here: write may define a type, and a key for an AI can
  be held to some types, with the one list of who reaches a vault and End. The door contracts now expect this on every
  door (#145, #148); the code is in parachute-cloud (#434–#441). One difference remains: a Cloud vault token also says
  the account's address was proven (#148).
  On the way back, Cloud differs from a box: a Cloud worker from before its typed keys serves a key held to types as
  a whole-vault key until the key is ended, so end typed keys before rolling Cloud back.

## 0.9.0-pre.1

The first 0.9 prerelease, on npm `beta` since 2026-11-16. What it changes from 0.8, and the way back:
docs/UPGRADE-0.9.md and `parachute changes`.
