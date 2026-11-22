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

**For door builders.** The door harness runs a one-address personal door as one address (#142).

## 0.9.0-pre.1

The first 0.9 prerelease, on npm `beta` since 2026-11-16. What it changes from 0.8, and the way back:
docs/UPGRADE-0.9.md and `parachute changes`.
