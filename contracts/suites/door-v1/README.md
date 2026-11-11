# door-v1: door contracts for behaviour decided and not built

These are door contracts (`suites/door/` rules: HTTP and MCP only, one file for every door, made-up data) for
behaviour that is decided and that no door has yet. Today that is **1.0 grants**:
[`docs/SPEC-1.0-grants.md`](../../../docs/SPEC-1.0-grants.md).

They sit apart from `suites/v1/` because they need a door, not the pinned stock run: the same file must be red on
a box and on a personal door, and green on both the day the behaviour ships.

## Run

```bash
bun run build:core
bun run doors -- --doors box suites/door-v1                                  # CI: every contract red for its reason
PERSONAL_REPO=<a checkout with deploy/personal> bun run doors -- --doors box,personal suites/door-v1
RED_SHOW=1 bun run doors -- --doors box suites/door-v1                       # run them plainly, to read why each fails
```

## How they are marked

Each contract is wrapped in `red()` (`suites/lib.ts`): it passes only while its body fails for the stated reason.
If the body passes, the test fails with "now green", and the pull request that made it pass removes `red()` and
moves the file to `suites/door/`. If the body fails for another reason, the test fails too.

Most are red for one reason: **no door takes a signed statement yet** (`NO_GRANTS` in `_grants.ts`; a box answers
405 and a personal door 404 to `POST /account/vaults/<name>/statements`). Every body starts by filing a grant that
must be taken, so a later "is refused" can't pass because nothing is ever taken. The reason matches only those two
statuses, so once the route exists a 400, 401, 403 or 409 from a contract's own mistake shows as red for the wrong
reason.

Two say that same absent route in words of their own, because what they file or read isn't `granted()`:

| Contract | Today |
|---|---|
| `grant.test.ts`: the grantee can carry its own grant to the door | the door has no statements route for the grantee's key to post to (405 or 404) |
| `grant.test.ts`: every credential is a row in the list | the door has no statements route to list (405 or 404) |

Three are red for a reason of their own, because today's doors do something the spec forbids or lack one named
thing:

| Contract | Today |
|---|---|
| `applets.test.ts`: asking as an applet nobody granted is refused | the door ignores `{applet}` and hands back the owner's full token |
| `custodial.test.ts`: the on-behalf header without the permission is refused | the header is ignored and the write is stamped as the owner's (0.9.1's write stamp fixes this first) |
| `grant.test.ts`: a vault says its own id | a vault has no id |

Each file also has a plain test that the setup it leans on works today, so a broken setup can't hide behind an
expected failure.

**What these don't prove yet.** A body's lines after its first failure have never run against a door that has
grants. They were read against the spec by a reviewer and they typecheck; the build will be the first to run them.

## The wire they assume (a proposal: spec §7)

`_grants.ts` holds the routes, the event kinds and the tag names most contracts use. If the build picks others,
change them there first, then in the places that call a route or build an event themselves:

- `applets.test.ts`: the token call with `{applet}`, by NIP-98 or a bearer credential (`askAsApplet`);
- `grant.test.ts`: a hand-built grant for another vault; `POST <issuer>/account/keys`; `GET /api/export`;
- `ending.test.ts`: hand-built revokes, to name exact addresses;
- `custodial.test.ts`: `POST /api/notes` with the on-behalf header;
- `leaks.test.ts`: links, versions, attachments, files, tags, find-path and stats over `/api/notes…` and its
  neighbours; `GET /api/export`;
- `move.test.ts`: `GET /api/export` and `.parachute/statements.jsonl`.

| Call | Shape |
|---|---|
| File a statement | `POST <issuer>/account/vaults/<name>/statements` `{event}` → `201 {kind, id, state}` |
| List them | `GET <issuer>/account/vaults/<name>/statements` → `{grants, links}` |
| A grantee's token | `POST <issuer>/account/vaults/<name>/token` with NIP-98 by the grantee key; or the signed-in grantor with `{applet}` |
| Writing for a person | header `Parachute-On-Behalf-Of: <name>` |
| Names in stamps | `GET /vault/<name>/api/stamps` → `{stamps: [{name, key, state}]}` |
| A person's records | the record list with `by_person=<key>` |
| The vault's id | `id` in `GET /vault/<name>/api/vault` |
| A grant row | `{id, origin, state, signer, grantee, by, types, deny, expires_at, event}`: `types` is `{<type>: [verbs]}`; `by` is `"signer"`, `"self"` or `{names: "<prefix>"}`; `event` is the signed event, or null for a door grant |
| The export | statements in `.parachute/statements.jsonl`, one signed event per line; the vault's id in `.parachute/vault.yaml` |

Records are written through the note door (`/api/notes`), because `/api/records` isn't on a box until 0.9.1 and
`/api/notes` is gone at 1.0. `records()` in `_grants.ts` covers most record calls and is the main place to move;
`leaks.test.ts` and one call in `custodial.test.ts` use `/api/notes…` directly. `grant.test.ts` also calls three
routes that exist today and stay admin (`PUT /api/tags/<name>`, `PATCH /api/vault`, `GET /api/history/deleted`).

## The files

| File | The behaviour it holds | Spec |
|---|---|---|
| `grant.test.ts` | an owner-signed grant opens exactly the types it names to the key it names; one grant per key; an id is never reused; a grant that isn't the owner's, is changed, names another vault, has no date or carries an unknown tag is refused; a vault credential can't file one; every credential is a row in the list | §2, §4.4, §7 |
| `verbs.test.ts` | each verb alone; create without read is a form that can't choose a path; `:own` and `was`; subtypes; a denied tag; adding and removing a type; `*` | §4 |
| `ending.test.ts` | a grant stops at its date; a signed revoke stops it on the next request, is final and needs no order; a revoke ends one exact address; who may sign one | §3 |
| `people.test.ts` | a member writes as themselves; an agent writes for its person; a member signs for their own agent, which never passes the member and ends with them; ids a member may use | §5.1, §5.2 |
| `applets.test.ts` | the owner's shell asks as an applet: held to the applet's grant, stamped `applet:<id>`; only the grantor may ask | §5.3 |
| `custodial.test.ts` | a `names` grant stamps its prefix; the header without it is refused; bad names and reserved prefixes; a link shows as the person's only after their own key claims it; "not mine"; the owner's void; replay from another vault; key rotation | §6 |
| `leaks.test.ts` | a narrow grant learns nothing of a hidden type by search, links, counts, type lists, history, files, the names in stamps, or a lookup | §4.1 |
| `move.test.ts` | the export holds every statement word for word, the vault's id, and no credential (skips on a box, whose export is a command: `deliberate.json`, `export-over-http`) | §9 |

## One older contract describes another model

`suites/v1/sharing.test.ts` (and the wire table in `suites/v1/README.md`) describes grants as subject × target ×
level with groups, links and page subtrees, at `POST /vault/<name>/api/grants`. The 1.0 spec is keys × types ×
verbs, filed as signed statements at the door. Which one stands is a decision for Aaron or Benjamin (spec, open
decision G). Until then neither file is changed.
