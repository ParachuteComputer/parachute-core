# One address for an AI: `<hub>/mcp` (T-476)

**Status: proposed in core #137; needs Aaron's or Benjamin's sign-off.** Enforced by
`contracts/suites/door/one-address.test.ts` (box) and `packages/hub/src/__tests__/one-address-consent.test.ts`.

A person gives an AI one address, their hub's `/mcp`. Behind it the AI reaches every vault the person lets it reach,
names one on each call, and, when allowed, makes new ones. A vault's own `/vault/<name>/mcp` stays, as the narrow
choice: one vault and nothing else.

## The rule

1. **Discovery.** A request to `/mcp` with no credential gets 401. Its `WWW-Authenticate` names
   `/.well-known/oauth-protected-resource/mcp`, whose `scopes_supported` is `["account:vaults"]` alone. It is the same
   ask as `/account/mcp`'s, because an app copies the list whole and `account:vaults` can't sit beside a vault verb.
   This holds on a hub with no vault yet too.
2. **The ask.** At `resource=<hub>/mcp`, unnamed vault verbs (`vault:read` …) are an ask for the account door and become
   `account:vaults`. A named `vault:<name>:<verb>` asked on its own stays a one-vault ask; beside unnamed verbs it is dropped.
3. **The page.** For `account:vaults`, the hub's owner chooses between:
   - **All your vaults**: `account:self:vaults:*:write account:self:vault-create`. That is read and write in each
     vault, the ones made later too, and leave to make vaults. It is capped at write, never the owner's admin. It is the
     same grant Parachute Cloud's "Any vault, current and future" plus "Create new vaults" mints.
   - **Only these vaults**: `account:self:vaults:<vault>:<read|write>` per vault (0.9.1).

   All is where the page starts for the one address. Any other account-door ask (an app listing its person's vaults,
   `/account/mcp`) starts on Only these, each vault at read. A person who isn't the owner sees only the rows. An app
   never gets either kind of scope by asking for it; only the person's choice on the page mints them. A new choice
   replaces the app's earlier one, and narrowing ends the tokens the earlier, wider choice minted.
4. **The door.** `/mcp` answers an account-audience token, or a NIP-98 request, with the account door. It answers a
   vault-audience token (or a vault key) with that one vault. Existing grants and refreshes keep the audience they had.
5. **The name.** The hub's `/.well-known/parachute-account` says `mcp_endpoint: <issuer>/mcp`.
   `account_mcp_endpoint` stays `<issuer>/account/mcp`, because shipped apps check it.

## Changed from

Before this, `/mcp`'s protected-resource document listed `vault:read vault:write vault:admin`. A cold app got the
one-vault picker, whose "All assigned vaults" gave the level-less grant (the person's role, admin for the owner). A hub
with no vault answered `/mcp` with 404 `vault_module_not_running`.
