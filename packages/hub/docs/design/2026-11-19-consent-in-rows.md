# The hub's consent page in rows (proposal, T-476)

Status: a proposal, nothing built. Aaron asked (11-19) for consent that feels like techne.town's Authorize page: "not
copy exactly, but use it as an example of what a more elegant solution might look and feel like." The Parachute app
now draws its own applet card this way (ParachuteComputer/parachute#66); this is the same shape for the hub's
`/oauth/authorize` page (`src/oauth-ui.ts` `renderConsent`), so a person sees one system on both sides of a sign-in.

## Today

`Approve Parachute?`, the return address, "This app is requesting access…", an EXTERNAL badge, the `client_id`, then
"Permissions requested" as raw scopes (`vault:home:read`) each with a sentence, a vendor note, an optional extras
fold, and Approve / Deny stacked. Everything is shown at once, and the first thing read is technical.

## Proposed

```
 ┌────────────────────────────────────────────────┐
 │ ⁂ Parachute                                    │
 │ Let «Parachute» use your Parachute?            │  serif heading, the app's name only
 │ An app on this device · sends you back to      │  where it comes from, plainly
 │   127.0.0.1:47219                              │
 │ ┌ Not registered through this hub. Only      ┐ │  tinted, only when sameHub === false
 │ └ continue if you trust the people behind it.┘ │
 │ ─────────────────────────────────────────────  │
 │ ▤  Read your home                          (?) │  one row per scope family:
 │    every note, tag and attachment              │  icon, plain name, one short line
 │ ✎  Write in playground                     (?) │
 │    add and change notes there                  │
 │ ─────────────────────────────────────────────  │
 │                     [Back] [Deny] [ Allow ]    │  Allow the strong one
 └────────────────────────────────────────────────┘
```

1. **One screen, a few rows.** A row per vault (read, or read and write), one for the account list
   (`account:vaults`), one per module scope (Scribe, surfaces). Each row: an icon, a plain name ("Read your home",
   "Write in playground", "List your vaults", "Send audio to Scribe"), one line from `scope-explanations.ts`, and a
   **(?)**. The vault's name goes into the row's name, not only the generic sentence.
2. **Detail on demand, exact.** The (?) opens (`<details>`/`<summary>`: the page stays script-free) with the real scopes (`vault:home:read`) and, for a vault, a
   table of what the token may do there: Read / Create / Update / Delete, ticked. Last line: **Towards:** the vault and
   this hub's address. The `client_id` and the return address move into a "This app" sheet behind the heading's (?).
3. **Who made it, plainly, at the top.** Same-hub clients get no badge at all. An external one gets the tinted line
   above, worded for a person ("Not registered through this hub…"), replacing the EXTERNAL badge. Admin scopes keep
   their stress (their row's name says what it does: "Manage this hub's accounts").
4. **Back, Deny, Allow** on one row, Allow the strong one. Back returns to the app without an answer (today the only
   way out is Deny).
5. **The hub's own look**: warm off-white, serif heading, as `baseDocument` already sets. No new colours.

The vault picker, the per-vault levels (`levelsSection`) and the extras fold stay; each becomes rows of the same shape
(a level is a choice inside its vault's row: none / read / write).

## Tests to change or add

`src/__tests__/oauth-ui.test.ts`: a row per scope with the vault's name, the (?) detail holding the exact scope string,
the tinted line only for an external client, three buttons. `account-scope-consent.test.ts` stays as it is.

## What doesn't change

The form posts, the CSRF field, the hidden inputs, the scope narrowing (`canonicalConsentScope`), what is minted.
Only what is drawn. Tests that read the page by its text (`oauth-ui.test.ts`, the e2e consent clicks) change with
the words; a test should check that every requested scope appears, exactly, in some row's (?) sheet.

## Open

- **Delete in the table.** `vault:<name>:write` lets a token delete notes; the app's applets can't (they never get
  delete). The table should say so per token, which means the hub states it rather than the app.
- **Back** needs a redirect with `error=access_denied` and no state change, or a plain return to the referrer; the first
  is the RFC's way, and the app already reads it as "not now".

Subtract: this note replaces the app repo's copy (ParachuteComputer/parachute `docs/design/HUB-CONSENT.md`, now a
pointer here). The EXTERNAL / First-party badges, the stacked buttons and the always-open scope list go when this lands.
