# Changelog: @openparachute/core

The 0.9 line ships from `main` to npm `beta` (RELEASING.md); the 0.8 line keeps its own CHANGELOG on `release/0.8`.
Each section says what changed since the one below it, for someone running Parachute. Pull request numbers are in
brackets. The hub's and the vault's own changelogs (`packages/hub/CHANGELOG.md`, `packages/vault/CHANGELOG.md`) carry
the wire-level detail.

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
- Parachute Cloud and a personal door now behave as a box does here: write may define a type (#145), and a key for an
  AI can be held to some types, with the one list of who reaches a vault and End (#148). The door contracts check both
  on every door. One difference remains: a Cloud vault token also says the account's address was proven (#148).
  On the way back, Cloud differs from a box: a Cloud worker from before its typed keys serves a key held to types as
  a whole-vault key until the key is ended, so end typed keys before rolling Cloud back.

## 0.9.0-pre.1

The first 0.9 prerelease, on npm `beta` since 2026-11-16. What it changes from 0.8, and the way back:
docs/UPGRADE-0.9.md and `parachute changes`.
