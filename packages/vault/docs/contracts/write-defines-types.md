# Write access may add a new type

**Status:** contract, 0.9 (T-476, 11-20). Default chosen by Uni; Aaron or Benjamin may overrule (it changes what
`vault:write` means for types). Enforced by `core/src/type-write.ts`; pinned by `contracts/suites/mcp/write-types.test.ts` (MCP) and
`contracts/suites/compat/types-write-rest.test.ts` (REST, `/api/types`).

## Why

1.0 is "Cloud, the AI connection, typed records and one simple app". The everyday path is any AI writing to a
person's vault over MCP with the write access the person grants, and the person's own app showing it. Before this,
defining a type was admin-only: with write access `manage-types` was not even in `tools/list`, so an AI asked for "a
reading tracker" could make records but not say what a book is. It kept state in note bodies, and the app and the AI
disagreed after one tap (the Claude audit of 11-20, walk 4). Asking every person to grant admin to every AI, to get
typed records, would give away rename, merge, delete and keys too.

## The rule

A caller holding `vault:write` (or `vault:<name>:write`) and not `admin`, with no tag scope, may:

1. **Make a new type**: `manage-types {action: "update"}` (MCP) on a name nobody has defined yet, with `fields`, `description` and `kind: "type"`. "Not defined yet" means no row, or a row records
   already made by naming it (`create-record {types: ["book"]}`) that has no fields, description, parents or
   relationships and is no other type's parent. A plain label (`tags: ["pinned"]`) is not such a name: making a
   label into a type stays admin's.
2. **Add fields to a type it made**: a type whose creator stamp equals the caller's own write stamp, both parts
   (`by` and `via`, the same two facts its record writes carry; [`nostr-principal-attribution.md`](./nostr-principal-attribution.md),
   core `write-stamp.ts`). It may add field names the type doesn't have, and set its description. It may not change or
   remove a field it already declared.

**Never through write: what other types' records inherit.** `_default` (every record's implicit parent) and any name
starting `_`, and a name some type lists in its `parent_names` (with or without a row of its own), including the
caller's own type once another type names it as a parent: fields declared there would reach records the caller didn't
type. `fields` must be an object of field definitions; any other shape is refused and nothing in the call lands.

Everything else on types stays **admin**: changing or removing any field, any change to a type it did not make (or
one made before this rule, which has no creator stamp), `parent_names`, `relationships`, `kind: "tag"`, rename,
merge, delete, prune and migrate. A refused call changes nothing and says so: "needs `vault:<name>:admin`", with
what write access may do instead.

**The account door** (one key over several vaults, the hub's `/mcp`) lists `manage-types` only to a key that holds admin
on the vault, as before: its writer list keeps to a 4,000-token budget (`contracts/suites/door/multivault.test.ts`). A
write key there makes a type at the vault's own address, the one the app's Connect screen gives.

**REST: the record door's `/api/types/:name` takes the same rule** (T-476, 11-21; default chosen by Uni, for Aaron or
Benjamin to confirm, since it changes what a write pass may do over REST). `PUT /api/types/:name` with write and not
admin may do exactly what `manage-types {action: "update"}` may: define a type nobody has defined yet (`description`,
`fields`, `kind: "type"`), and add fields to a type whose creator stamp is the caller's. Everything else answers 403
"needs admin" with what write may do instead (changing or removing a field, `replace_fields`, `parent_names`,
`relationships`, `kind: "tag"`, a type it didn't make, a plain label); a malformed `fields` answers 400 and nothing
lands. DELETE, rename, merge and migrate on `/api/types` stay admin. Why: the person's own app holds write and talks
REST, and a newcomer's one tap ("Add a pack") has to make the pack's types with no AI
(`parachute` docs/VAULT.md). Pinned by `contracts/suites/compat/types-write-rest.test.ts`.

**`PUT /api/tags/:name` is unchanged: admin.** Benjamin's Prism compatibility suite (`contracts/suites/compat/prism.test.ts`)
pins a write pass's 403 there, and Prism calls that route. A client that wants the rule uses the record door.

The stamp is the credential's, and its `via` can differ by door. A named key (`key:<name>`), a signing key (`nostr:…`)
and the operator stamp the same `via` on both, so a type one of them made over MCP takes its fields over REST, and the
reverse. A hub sign-in with no key name stamps `api` over REST and `mcp` over MCP, so a type it made over one door is
not "its own" over the other (fail closed: an admin still can).

A **tag-scoped** credential (`permissions.scoped_tags`) gets none of this: types sit above every tag scope, so a
scoped writer's types stay the admin's to make (as in `tag-scoped-tokens.md`). `vault:read` gets nothing.

The alias `update-tag` (deprecated, gone in 1.0) is unchanged: admin only. The rule rides `manage-types`, which a
write session now sees in `tools/list`; its other actions are refused per call.

## The creator stamp

A type made through `manage-types` (any scope) or `PUT /api/tags/:name` (admin) records `created_by` and
`created_via` on its `tags` row, once, when it is first defined. The values are the caller's write stamp at that moment: for the owner over
MCP, their account and `mcp`; over REST, their account and `api`; a named key is `key:<name>`; the operator bearer
is `operator`. The stamp is a label, never an access grant on its own.

What "a type it made" can tell apart is what the stamp can. Two plain MCP sign-ins by the same person share
`by` and `via`, so each may extend a type the other made. A named key, a signed grant (1.0) or an applet has its own
`via`, and is told apart. A type made over REST carries REST's `via` (`api`), so an MCP write session doesn't extend it.

Storage: two nullable columns on `tags`, added like `kind` (additive, no schema number, `unnumberedStepsDone`). An
older engine ignores them. They are not exported: a vault restored from an export has types with no creator stamp,
which write access then can't extend (fail closed; an admin still can). A rename or merge (admin) doesn't carry the
stamp to the new name either.

One edge is accepted: a type an admin made with only `kind: "type"` (no fields, description or parents) before this
rule has no stamp and reads as not yet defined, so a write session may define it. An admin who wants a name kept gives
it a description or a field.

## Not changed

- What a record write may do: `create-record {types}` with a brand-new name still makes the name (a type with no
  fields), as before.
- Admin's `manage-types` and `PUT /api/tags/:name`: every action as before.
- 1.0 grants (`docs/SPEC-1.0-grants.md` §4.4): type management stays outside every narrow grant. This rule is about
  the plain `write` verb a person gives a connected AI.
