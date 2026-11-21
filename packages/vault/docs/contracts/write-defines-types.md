# Write access may add a new type

**Status:** contract, 0.9 (T-476, 11-20). Default chosen by Uni; Aaron or Benjamin may overrule (it changes what
`vault:write` means for types). Enforced by `core/src/type-write.ts`; pinned by `contracts/suites/mcp/write-types.test.ts`.

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

**The account door** (one key over several vaults, the hub's `/mcp`) lists what a vault's own door lists at the same
level, `manage-types` to a write key included (T-476: it is the address an AI gets, so an AI there must be able to make a
type). Its writer list keeps to a 4,000-token budget (`contracts/suites/door/multivault.test.ts`) by listing the
note-named aliases (`query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`) to a Bearer connection under
their record names only; they still answer, and a NIP-98 caller (Uni's agents, `contracts/suites/compat/uni.test.ts`)
keeps them listed. *Changed from: listed only to a key that holds admin (core #134); needs Aaron's or Benjamin's sign-off
(core #136).*

**REST is unchanged**: `PUT /api/tags/:name` (and `/api/types/:name`) stays admin. Benjamin's Prism compatibility suite
(`contracts/suites/compat/prism.test.ts`) pins a write pass's 403 there, and nothing turns it red on purpose. The AI
connection is MCP; opening REST too is a later change, with Benjamin.

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
