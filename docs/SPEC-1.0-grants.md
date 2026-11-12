# Parachute 1.0: grants

Uni, 2026-11-10 (T-448). The spec for 1.0's access model: who may do what in a vault, how the vault knows, and how
it ends. Nothing here is built. The contracts that hold it are in `contracts/suites/door-v1/` (§12).

**Marks.** **[decided]** Aaron's decisions of 11-07 and 11-10, or a requirement the 0.9 spec already recorded for
1.0. **[lean]** this spec's proposal, open until Aaron or Benjamin says otherwise. **[code]** read in code on core
`next` at `1af67d2d` or parachute-cloud `door/0.9` at `f2d1b8a`. Every name below is made up: Bo, Mara, Fernhill
Bakery, the `recipes` vault.

---

## For Aaron

**The shape, in five lines**

1. **A grant is one short signed statement from you:** "this key may do these things to these types in this vault,
   until this date." Your tap on the card in your shell is the signature.
2. **The vault keeps the statement and checks every request against it:** reads, writes, search, links, counts,
   files, history and the live socket all pass one checkpoint. A token only says which grant a request is under.
3. **One statement covers everyone you let in.** A friend writes as themselves. An AI or an applet writes for its
   person. A web app with users of its own writes for the people it names, always under its own name.
4. **It ends by its date, or by a signed revoke.** A revoke works on the next request and is final.
5. **It is the same at all three doors** (a box, Parachute Cloud, your own Cloudflare door), **and it travels with
   the vault** when the vault moves.

**What 1.0 lets you and your friends do**

- **Share a vault with a friend.** Bo signs in with his own key, from his own shell. His edits read "Bo", yours
  read "Aaron". You choose what he reaches: every type, or only `recipe` and `cook-log`.
- **Give an AI a part of a vault, not all of it.** Claude can read and add recipes and never sees your journal: not
  in a search, a link, a count or an old version.
- **Make a form.** A key that can add a `signup` record and read nothing.
- **Hold applets to their card.** Arcade can add a `reaction` and read `taste-card`. The vault holds it to that, so
  a bug in the shell no longer opens the vault.
- **Let a web app write for its people.** A client portal writes "for client-42" under its own name. When Mara gets a
  key and signs once, her history reads as hers.
- **See and stop all of it.** One list of every grant in a vault. One tap ends one.
- **Move the vault and keep it.** History, who wrote what, and the grants come along.

**Still open, each with a lean**

| # | The question | Lean | Why it's yours |
|---|---|---|---|
| A | The five event numbers and their layout (§2.1): the meaning in canonical JSON content, the grant frame Uni's keys use too. The shell can't sign a grant until they are fixed, and a signed one is honoured for good. | 37440 grant, 7440 revoke, 37441 link, 37442 claim, 37443 the vault's own record. None is taken in the Nostr list today. Freeze after one fresh security pass with Benjamin. | Permanent. Benjamin should see it. |
| B | Can someone with only an email (most of Cloud today) share a vault? | Yes. With no key to sign, the door vouches for the grant, the list says so, and it doesn't carry to another door. | It makes "signed by the owner" untrue for those vaults, plainly marked. |
| C | After a move, do your friends' grants work at the new door at once? | One tap, once: "bring these 5 grants over". Revokes apply at once with no tap. | A copy left at the old door would keep honouring them. The tap is you saying the old one is retired. |
| D | The longest a grant may last. | A year. The shell reminds you a month ahead. | Shorter is safer and asks you more often. |
| E | Who signs for a friend's AI in your shared vault? | The friend does, for their own AI, and it can never reach more than the friend can. | The other way, you approve every friend's every AI. |
| F | The first shared vault lives where? | Parachute Cloud, once it has key sign-in (it rides 0.9.1's keys). | From the shell note; friends aren't on the tailnet. |
| G | The sharing contract already in core (`v1/sharing.test.ts`) describes a different model: levels (view, comment, suggest, edit, manage), groups, links for anyone, pages. Does this spec replace it for 1.0? | Yes. 1.0 is keys, types and verbs. Groups, public links, page-level sharing and comment or suggest levels wait for 1.1. | It changes what an existing contract means, which is yours or Benjamin's call. |

**Two more, for Benjamin as much as you**

- **H. Every vault's id is its own Nostr key [decided, Aaron 11-12].** §2.3 says where the private key lives, how
  it moves, rotates and is retired after a leak. What is still open is only when: lean, in 0.9.3, as one additive
  field and one key file, so a grant the shell signs before 1.0 doesn't have to be signed again (§10).
- **I. A token carries the grant's id, not its rules** (§7.2). The 0.9 spec said the narrowing travels in the
  token. Here the vault reads the rules from the signed grant on every request, so a revoke or a narrower grant
  bites at once. The cost: a verifier that isn't the vault (Prism's) can't apply a grant itself; it refuses, or
  asks the vault.

---

## 1. Words

- **Owner key:** the Nostr key of the person who owns the vault. A door tells the vault which key that is (§8).
- **Grant:** a signed statement that one grantee may do named things to named types in one vault until a date.
- **Grantor:** who signed it. The vault's owner; or a member, for their own agents only (§5.2).
- **Grantee:** one key, or one applet running in the grantor's shell.
- **Member:** a second person on a vault. A grantee who writes as themselves.
- **Door:** one way of running Parachute: a box, Parachute Cloud, or a personal Cloudflare door.
- **Statement:** any signed event a vault files: a grant, a revoke, a link, a claim on a link, a vault record.
- **By and via:** the two stamps on every write since 0.9.1. *By* is who it was for. *Via* is what wrote it.

## 2. The grant

### 2.1 The event [decided: an addressable Nostr event, signed by the owner; the layout is this spec's lean]

**The meaning is in the content; the tags only address it.** A grant's content is one JSON object in one allowed
spelling. Its two tags repeat two of its fields so relays and clients can address and expire it, and a vault
refuses the event if they disagree. The same object, the *grant frame*, is what Uni's key minter and the shell's
card read for keys and applets (T-462), so the bytes the owner signs are the bytes every party reads.

```
kind        37440          addressable: (kind, pubkey, d) is one grant's address; a newer event replaces an older
pubkey      the grantor's key
created_at  when it was signed
tags        exactly [["d", "<id>"], ["expiration", "<until>"]], in that order
content     the grant, canonical JSON (below)
```

The content, laid out for reading (the signed text has no spaces or line breaks):

```json
{
  "v": 1,
  "id": "<the d tag's value>",
  "at": "parachute",
  "honors": "<the vault's id: its own public key, 64 lowercase hex (§2.3)>",
  "gives": "access",
  "to": {
    "kind": "key",
    "id": "<the grantee's public key, 64 lowercase hex>",
    "by": "self | signer | names:<prefix>",
    "was": ["key:<name>", "grant:<id>", "applet:<id>"]
  },
  "allow": [
    {"on": {"type": "<type> | *"}, "can": ["create", "delete", "read", "update"]},
    {"on": {"type": "<type>"}, "can": ["delete", "read", "update"], "only": {"own": true}}
  ],
  "deny": [{"tag": "<marker tag>"}],
  "under": "<on a member-signed grant: the member's own grant id>",
  "until": 1826000000,
  "purpose": "<one line saying what signing this allows; never read by a check>"
}
```

An applet grant's `to` is `{"kind": "applet", "id": "<applet id>", "author": "<author key>", "by": "signer"}`.

| Field | Meaning | Rule |
|---|---|---|
| `v` | the frame's version | `1`. Any other is refused (§2.2 line 4) |
| `id` | the grant's id, equal to the `d` tag | 1 to 64 of `[A-Za-z0-9._-]`. One id is one grantee, for good (line 6) |
| `at`, `gives` | which reader, what kind of thing | exactly `parachute` and `access`. Kind 37440 also carries the shell's own grants (devices, rooms), so a vault checks both |
| `honors` | the vault | equals this vault's id, character for character (line 2). Never its name |
| `to` | the grantee | `kind` is `key` or `applet`. A key is 64 lowercase hex. An applet has an `id` in the `id` charset and the `author` key the shell pins |
| `to.by` | whose name its writes carry (§5) | required: `self`, `signer`, or `names:<prefix>` (§6.1's prefix rule; it holds no colon) |
| `to.was` | earlier stamps it carries on from (§4.3) | 1 to 8, sorted, different; `key:`, `grant:` or `applet:` stamps. Owner-signed grants only |
| `allow` | rows: `on` one type (`*` is every record, typed or not), `can` its verbs, `only.own` for own records only | 1 to 64 rows, each different, sorted by their canonical text; verbs sorted. An own row is `"only": {"own": true}` exactly and carries only `read`, `update`, `delete` |
| `deny` | records carrying any of these tags are outside the grant, for every verb | optional; 1 to 16 `{"tag": …}`, sorted, different. Grant-wide, never on a row: grants only add, so a deny on one row would leave another row showing the record |
| `under` | on a member-signed grant: the member's own grant it hangs from (§5.2) | required there, refused elsewhere; an id with no dot |
| `until` | when it ends | unix seconds; equal to the `expiration` tag (NIP-40's, written as a decimal with no leading zero) |
| `purpose` | the asker's words, shown last on the card | 1 to 200 code points; no control (U+0000–U+001F, U+007F–U+009F), no U+061C, U+200B–U+200F, U+2028–U+202E, U+2060–U+2069, U+FEFF, or the frame's fixed list of blanks. No check reads it |

The verbs are **`read`, `create`, `update`, `delete`** [decided]. `read`, `update` and `delete` may each sit in an
own row: only records this grantee made [decided: own-records-only]. A type covers its subtypes as the vault defines
them today: a type declared under it, or named `parent/child` [decided, SPEC §3.5]. The 1.0 vocabulary is exactly
this: `on` holds `type` only, `only` holds `own` only, `deny` holds `tag` only. Anything else is refused (line 4),
including `on.path` (sharing a subtree is 1.1).

**One spelling.** The content is canonical JSON (RFC 8259, no duplicate keys): object keys are ASCII and sorted
byte by byte; no whitespace outside strings; `true` is the only literal (for `only.own`); numbers are whole, 0 to 2^53−1, written as plain decimal digits with
no sign, fraction, exponent or leading zero; in strings the only escapes are `\"` and `\\`, and every other
character is written as itself in well-formed UTF-8 (no control character can occur: §2.1's `purpose` rule and the
ASCII rule leave none); arrays of verbs, rows and denies are sorted as above. A content that isn't the canonical
spelling of what it says is refused, so one meaning has one digest. Everything a check reads (ids, keys, types,
tags, verbs) is printable ASCII; only `purpose` may be in any script. Type and tag names outside ASCII
can't be granted or denied by name at 1.0 (§13). Test vectors for the spelling (accepted and refused, with
their digests) are a precondition of the freeze (open decision A): they are written and run by the shell, the
minter and every door before the first signature. They are #systems' `vectors/frame-1.0.json` in the shell-keys
core (branch `t335-frame-1.0`, at bf607e4: 198 signed cases, sha256 `9cba3adf18e39baf85d6d7d9ef0fd9aa80786c74e2c1cae69689151268b17faf`); its README section "The
vectors, for a vault" says how a vault replays it. A door pins a commit and the file's sha256 when it takes it.
Round 7 (Appendix D) changed four answers the file pinned at bf607e4: a disagreeing event ends its address in any
order, a member's `under` that isn't their own is `invalid_statement`, a control character other than NIP-01's
five makes an event malformed, and a grantee may give up a suspended grant. The file meets the precondition once
it carries those.

**Size.** The content is at most 6,000 bytes of UTF-8 and the event at most 8,192 bytes. Both are checked: the
event escapes the content's quotes and backslashes, so it is larger than the content. **An event's size**, here
and in every limit in this spec, is the length of the event as sent, which the vault computes itself from the
event's fields, whatever spelling the request used: one compact JSON object of its seven fields (`id`, `pubkey`,
`created_at`, `kind`, `tags`, `content`, `sig`), with no whitespace, strings escaped exactly as NIP-01's id
serialisation escapes them (`\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`), and every other character written as
itself in UTF-8 (never `\u`; line 1 leaves no other control). It is not NIP-01's serialisation for the id, which
leaves out `id` and `sig` and is 253 bytes shorter. A KB is
1,024 bytes.

Five kinds are reserved together [lean, open decision A]: `37440` grant, `7440` revoke (a regular event, never
replaced), `37441` link statement, `37442` link claim, and `37443` the vault's own record (§2.3). The grant frame's
other carriers keep their own numbers beside these, outside this spec: `24335` an order (one key or one act,
honoured once), `24337` a receipt, `37449` the owner's signed account lists. None appears in the kinds table of
nostr-protocol/nips as fetched on 11-12. A signature covers the kind, so these are fixed before the shell signs its
first grant.

### 2.2 When a vault takes a grant

A vault files a grant only if every line holds. It checks again on every request. Anything else is refused, with
the reason. The lines are checked in this order and the first that fails names the refusal.

Every statement passes line 1, is no more than ten minutes ahead of the vault's clock when it arrives, and names
this vault. What else each kind must carry:

| Kind | Tags | Content | Names this vault by | Spelling |
|---|---|---|---|---|
| 37440 grant | exactly `d`, `expiration` | §2.1 | `at` `parachute`, `gives` `access`, `honors` | strict: lines 2 and 4 |
| 7440 revoke | none read | `v`, `honors`, `ends`, optional `purpose` | `honors` | lenient (§3) |
| 37441 link | exactly `d` = `name` | `v`, `honors`, `name`, optional `is` | `honors` | strict |
| 37442 claim | exactly `d` = `name` | `v`, `honors`, `name`, `claim` | `honors` | strict |
| 37443 vault record | exactly `d` = `honors` | `v`, `honors`, `key`, optional `lives` | `honors` | strict |

"Strict" is line 4's rule for that kind: its tags, canonical content, and no unknown field. Size: a grant within
§2.1's limits; any other statement within 8,192 bytes, but for a revoke, read up to 64 KB (§3).

1. **The event is whole:** its tags are a list of lists of strings, as NIP-01 has them (an empty tag is fine), and
   every string in the event, the content included, is well-formed Unicode (no lone surrogate). Anything else is
   malformed (`invalid_statement`), whatever the kind: the id is a hash over these, and a number, an object or a
   lone surrogate hashes to other bytes in another language, or doesn't hash at all. For the same reason none of the event's
   own strings (tag values, the content's text as sent) holds a control character (U+0000–U+001F) other than tab, line feed, carriage return, backspace and form feed:
   NIP-01's text writes the rest as themselves, and `JSON.stringify` and `json.dumps` (so nostr-tools) write them as
   `\u00XX`. With them refused the two never meet, and the id is NIP-01's serialisation. A shell never signs one. These
   checks of line 1 come before the hash is computed. The id is the hash of its
   fields and the signature verifies (BIP-340).
2. **It names this vault:** `at` is `parachute`, `gives` is `access`, and `honors` equals the vault's own id as
   the string JSON reads (escapes undone; no case folding, no trimming). For a grant in its one spelling that is the
   same as byte for byte; it matters only to the lenient reads, where reading it as JSON holds or acts on more.
3. **The signer has standing.** It is one of the vault's owner keys today; or it is a member's key (§5.2).
   Standing is the signer's key alone; what a member's grant names is judged at lines 6 to 8. An admin key that signs in *as* the owner (a personal door's `ADMIN_PUBKEYS`) has none. The vault's own
   key has none (§2.3).
4. **It is in its one spelling and knows every field, verb and tag.** The tags are exactly `d` then `expiration`,
   equal to the content's `id` and `until`. The content is canonical. A grant with a field, a key, a verb or a tag
   the vault doesn't know is refused, never read around: an unknown field may be a limit the signer meant, and
   skipping it would open more than was signed.
5. **It ends:** `until` is in the future and at most 366 days after `created_at` [lean, open decision D].
   `created_at` is no more than ten minutes ahead of the vault's clock.
6. **The id is free or the same:** no revoke stands against its address (§3). Ids are one namespace per vault,
   shared with door grants (§7.3), and an id is never reused: an `id` that was **ever** on file under another
   signer or for another grantee is taken, ended or not, because `grant:<id>` stays on what it wrote. A member's
   own grant (`by self`) has an id with no dot. A member's agents' ids start with that id and a dot (`bo.claude`),
   and nobody else may use that start, so a member can't take an id the owner will want. If an event with this
   address is on file, this one is newer by `created_at` (on a tie the lower event id wins, as in NIP-01, so two
   copies always merge to the same answer), it is signed by the same key, and its `to` and `under` are
   byte-identical to every event at that address the vault has seen that passes what holding needs (below), whatever
   its date: filed, held or superseded. They are compared as the bytes of each value as they stand in the event's
   content, never parsed and written again. One that differs is refused
   (`id_taken`, which outranks `superseded` within this line) and is never filed; but like any event the vault can't take, if it is the newest at its address it
   is held and suspends the address (below), so a changed `to` or `under` can never leave an older, wider grant in
   force. Once any two events at one address disagree on `to` or `under`, in whatever order they arrived (an older
   one arriving after a newer is counted too), nothing at the address is in force again; it lists as `suspended`,
   and comes back only by a revoke and a new id. So the grantor who signs two grantees under one id ends that id.
   Such an older event is kept with the statements (§3, §9), so the ending survives a restore or a move. When
   statements are filed in bulk (a restore, an import, the door filing its copy), grants, held events and those
   disagreeing events go in first, oldest first by `created_at`, ties by the lower event id; then every revoke, whatever its
   date; then line 7 (one grant per grantee) is judged again for every event held only because of it. So the same
   set always gives the same answer, a revoke always finds its address, and a key granted again after a revoke keeps
   its new grant. An owner with two keys replaces a grant with
   the key that signed it. A replacement may change rows, denies, the date and the purpose. It may never change who
   the grant is for, whose name it writes in, or what it counts as its own.
7. **One grant per grantee:** a key holds at most one grant in force in a vault, and a signer's applet id likewise.
   A second is refused until the first has ended. So a token never has two grants to choose between. An owner-signed
   grant for a key ends a member-signed one that key holds, so a member can't block the owner. A grantee is
   never one of the vault's owner keys, nor the vault's id or any key that has signed for the vault (refused as `invalid_statement`). To a member, a refusal about the grantee's key
   reads the same as `exceeds_grantor`, so a member can't use filing to learn which keys hold grants.
8. **It is coherent:** `update` or `delete` on a type comes with a `read` row on that type, own or not. An applet
   grant's `to.by` is `signer`, and it doesn't name `*`. `was` only on an owner-signed grant; `under` only, and always, on a member-signed one, and it names the
   signer's own grant. A member-signed grant's `to.by` is `signer`.
   A `names:` prefix is lowercase `[a-z0-9.-]`, holds a letter or a digit, and isn't reserved (§6.1). No verb
   reaches admin (§4.4).

A grant is **in force** while it is filed, valid by these lines, not past its date, not revoked, not suspended
(below), and its signer still has standing.

**The newest event at an address decides, whatever order events arrive in** [lean], except that events
disagreeing on `to` or `under` end the address in any order (line 6). Replacement plus refusal has
one gap: a narrowing replacement that this vault refuses, for any reason (a field from a later version, `v: 2`, a
size or date limit, a rule a later version relaxes), would leave the older, wider grant in force, and a rollback
makes every vault an older one. So, per address, the vault keeps the newest event it has seen that passes line 1,
line 3, the ten-minute bound on arrival, and a **minimal read**, filed or not. The minimal read is frozen for every
later version: the content is a JSON object with no key twice at its top level (inside a field, a repeat isn't
looked for), its `at` is `parachute`, its `honors` is this vault, and its `id` equals the first `d` tag's value (NIP-01's
address). Every key and string a frozen read uses (here and in §3) is read as JSON reads it, escapes undone (line
2); only line 6 compares the values of `to` and `under` as raw bytes. The fields it doesn't use are checked to be valid JSON without being
built, so a very long number or a very deep array in one can't make one parser refuse what another holds. The names and spelling of `to` and `under` are frozen with it,
so every later version's events can still be compared under line 6. An address is in force only while that newest event is one the
vault filed. If the newest is one it couldn't file, or events at the address disagree on `to` or `under` (line 6), the address
is **suspended**; every older event at the address
is `superseded` and never in force again, whether it arrived before or after, and whether the address was empty,
`carried` (§9) or suspended. So an order of arrival, a restore, or a move's tap can't revive the older grant. An
event that fails the minimal read is refused and suspends nothing, so an owner's grant at the same address for
another vault, or a shell grant on the same kind, never touches this one.

Standing (line 3) for holding is judged as for filing; at an import it is judged against the carried owner-key list
and its dates, so a narrowing isn't dropped because the owner's key isn't linked at the new door yet. A held event is
judged again in two cases only: after the vault is upgraded, and when someone files it again. If it can then be
filed, it is, and the address is in force under it. Nothing else brings a held event into force, so a grant the
owner meant to stay refused never arrives on its own. Otherwise the address comes back only with a newer event the
vault files. A member's held events count toward their cap of 20 (§5.2). A vault reads an event of up to 64 KB (as sent, §2.1) for
the minimal read, and a door accepts a request body of up to 72 KB; a shell never signs a grant
over 8 KB. Those three numbers are frozen for every later version, so a narrowing can't be lost to its size.

A signed event the owner handed out can be filed by whoever holds it until its date, as §3 says of a grant never
filed. That holds for a newer replacement too, wider or narrower: to take back one that was handed over and not
filed, sign a newer event at the address or revoke the address. The vault lists the grant as `suspended`, with the held event, and carries
held events with the statements (§3, §9). Only the grantor's key can sign at its address, so nobody else can suspend
a grant. A shell narrows with fields every vault it names knows, or by a revoke and a new id.

### 2.3 The vault's own key [decided 11-12: a vault's id is its own Nostr key]

A grant has to name a vault that is still the same vault after a rename or a move. Today nothing fits: a box has no
vault id, and Cloud's lives at the door, not in the vault [code: no `vault_id` in core `packages/`; cloud
`workers/identity/migrations/0020_vault_id.sql`].

**The id.** 1.0 gives every vault a Nostr key pair, made with the vault (or at the 1.0 upgrade). The vault's id is
the public key it was born with: 64 lowercase hex, stored in the vault, shown as `id` in the vault's info, and
written to the export's `vault.yaml`. **The id never changes,** even when the key that signs for the vault does
(below), so grants never have to be signed again because of a key. Cloud's existing `vault_id` stays an internal
row id. An import that is a **move** keeps the id. An import that is a **copy** gets a new key and so a new id, and
the grants it carries are history only.

**What the key is for, and what it isn't.** It names the vault, and it signs one thing at 1.0: the vault's own
record (kind 37443, below), which says which key currently signs for the vault and, for the vault map at 1.1, where
it lives. It never authorises: it has no standing to sign a grant or a revoke, it can't be a grantee, and nothing
in §2.2 needs it, because the vault checks the owner's signature itself. So the vault's private key reaches no
record. Losing it costs one owner tap (rotation); leaking it lets someone claim to be the vault, which an owner
ends (below).

**Where the private key lives.**

| Door | Where | Not |
|---|---|---|
| A box | a file per vault in the hub's home, `vault-keys/<id>`, mode 0600, owned by the hub's user | in the vault's database or data folder, in an export, or in `--restore`'s backups. A box that loses the file asks the owner to rotate |
| Parachute Cloud | the identity worker's database, encrypted under a key held as a Worker secret | in the vault's Durable Object: the engine that serves every request never holds it |
| A personal door | the same as Cloud, under that door's own Worker secret | the same |

The door signs for the vault. That changes nothing in §8's rule 3: the door mints every token and is trusted
anyway.

**The vault's record** (kind 37443, addressable, `d` = the vault id):

```json
{"v": 1, "honors": "<vault id>", "key": "<the key that signs for this vault now>", "lives": "<https URL, or absent>"}
```

Two kinds of signer may sign one, with different weight:

- **The vault** (its current key) signs its own: at birth (`key` = the id), when it moves door, and when `lives`
  changes. A vault's record may not change `key` to a key other than its own signer, except in a move handover
  (below).
- **An owner override** is the same kind signed by one of the vault's owner keys. It may name any `key` and any
  `lives`. This is how an owner rotates the key, and how an owner takes a vault back from a host that leaked or
  misused it.

**Which record counts, at the vault** [lean]. The vault (and its door) applies this rule; it knows its owner keys
with their dates (§8 rule 2). Every record must be no more than ten minutes ahead of the vault's clock when it
arrives, so none can be dated out of reach.

1. Take the newest owner override signed by a key that is on the vault's owner list now. It names a key K. With no
   override ever filed, K is the id. An override from a key taken off the list stops counting, as its grants do.
   **Once any override has been filed, the vault never returns to an earlier key:** if none from a listed owner
   counts (a key was taken off the list, or the vault has just moved), no record counts and the vault signs nothing
   as itself until a listed owner files one. After a move the same holds until the owner's tap files an override
   from a key listed at the new door, or, for an owner with no key, the import files the leaving door's handover
   naming the arriving door's key (§9). A handover counts only if the carried owner-key list holds no key at all
   and it is signed by the key this rule named at the leaving door. A vault whose overrides exist but no longer
   count, and whose owners have no key left, can never sign as itself again; its cure is a new id (below).
2. Then follow handovers newer than that override (or from the start): of the records K signed naming another
   key, the newest moves K to it. Repeat from the new K.
3. Records signed by the final K, newer than the override, say where the vault lives.

On a tie the lower event id wins, as in §2.2 line 6. **Once an owner override names a new key, nothing an earlier
key signs counts again, whatever date it carries,** so a leaked key can't backdate its way back past the override.

**Readers away from the vault** (the vault map at 1.1, a grantee's shell finding the vault) can't see the owner list
the vault holds, so they don't learn that an owner key was removed. 1.0 freezes the record's kind and layout only;
how a reader away from the vault trusts an override (lean: only as served by the vault at the `lives` it already
reached, with the owner list and its dates) is settled with the vault map. At 1.0 no reader routes by `lives`.

**How it travels in an export.** The export carries the vault id and every 37443 record, word for word, in
`.parachute/statements.jsonl`. It never carries the private key: an export is a file people copy, and a copy
holding the key could speak as the vault. On a **move**, the arriving door makes a new key pair. Then:

- *An owner with a key:* the owner's one tap that brings the grants over (§9) also signs an override naming the new
  door's key and `lives`. The id, and so every grant, stays.
- *An owner with no key* (open decision B): `tools/move` asks the arriving door for its new public key and has the
  leaving door sign a vault record naming it (the handover), then delete its private key. This is the only record a
  vault signs naming a key other than its own. A door signs one only through `tools/move`'s own call, never on its
  own; the statements route takes a handover only as part of an import. Such an owner trusts the doors already; the
  list says so.

**How it rotates.** An owner rotates at any time by signing an override naming a key the door made for the vault
(the door shows it; the owner's shell signs). The door installs the new private key when it files the override. It deletes
the private key the override retired; a retired key is never named again (the vault refuses an override naming one,
`invalid_statement`), so rotating "back" means a fresh key. A
leaving door deletes every private key it held for the vault. A door asked to file an override naming a key it doesn't hold files it and stops signing as
the vault: that is how an owner retires a host.

**If a host leaks the key.** Whoever holds a leaked key can sign vault records: claim the vault lives elsewhere
(the vault map would send readers there) or claim a new key. They can't sign or end a grant, read a record, or
mint a token at a door that doesn't hold the vault. The owner ends it with one override: a new `key` (made by the
door they trust), and `lives` where the vault really is. From then on the leaked key counts for nothing at the
vault. The vault lists every record it holds, with which counts, so an owner sees a stray one. **An owner with no
key can't override, and nothing outranks the key:** a leaked key, or one a leaving door kept after a handover, can
sign a newer handover and win. For such a vault the only cure is a new id: the door makes the vault a new key pair
and id, and its door grants are made again (they are the only grants such a vault has, open decision B). That is
the plain cost of having no key.

**Restores.** The door's copy (§3) keeps vault records like every statement, so a restore can't bring back a
record an override retired.

### 2.4 The grant frame and other readers

The content above is one instance of a frame that also carries Uni's keys (a Cloudflare or GitHub key handed to one
job, `gives: key`) and one-off actions (`gives: act`), read by a minter that knows no vault. A vault reads only
`at: parachute` and refuses the rest (line 2); a minter refuses `at: parachute`. Both read the same spelling, so a
card drawn from the bytes means the same thing at every honouring party. The frame's own spec and code live with
the key minter; this spec owns the vault's fields and vocabulary.

## 3. Ending a grant

- **By its date.** At `expiration` the grant stops, with no one acting.
- **By a revoke** [decided: a signed event]:

  ```
  kind     7440
  pubkey   who ends it (below)
  tags     none
  content  {"ends":"37440:<grantor key>:<id>","honors":"<vault id>","purpose":"<optional>","v":1}
  ```

  `ends` is the grant's address, exactly: the kind, the grantor's key (64 lowercase hex) and the id. It has one
  other form, `name:<prefix>:<name>`, the owner's void of a linked name (§6.2). None of an id, a prefix or a name
  holds a colon, so `ends` parses one way. (The grant frame's minter also reads a third form, a bare event id that
  ends an order; a vault refuses it.)
- **A revoke always reaches an older vault.** A revoke's `v`, `honors` and `ends` keep their names and spellings in
  every later version. A vault acts on a validly signed 7440 whose `honors` is itself and whose `ends` parses, from
  a key with standing for that address, even if the rest of its content is unknown, `v` is higher, it carries
  tags (lists of strings, line 1), or it isn't in canonical spelling: a revoke only closes, so it must never fail open because a vault is older
  than the shell. That read is still strict where it matters: the content is a JSON object with no key twice at its top level
  (inside a field it doesn't read, a repeat isn't looked for, so two vaults can't disagree on it),
  `v` is a whole number of at least 1, read from its literal however long (a 400-digit `v` still acts), `honors`
  is this vault as line 2 reads it, and `ends` is a string in its pinned spelling; the fields it doesn't use are
  checked as JSON without being built, as in the minimal read. A vault reads
  a revoke of up to 64 KB this way; a shell never signs one over 1 KB. `v` is a JSON integer literal (`1`, not `1.0`).
  Because an older vault applies a revoke whole, **no later version may add a field that narrows a revoke**: a
  partial ending is a new grant, never a qualified revoke.
- **A revoke is scoped by its vault.** An address doesn't name a vault, and an owner may use the id `claude` in
  two vaults. So a vault takes only a revoke whose `honors` is its own id, and keeps revokes per vault and address.
  The owner's revoke of `claude` in one vault, carried to another, is refused there (`wrong_vault`).

- **A revoke ends one address and nothing else.** The address is the kind, the grantor's key and the id together.
  A revoke that names `37440:<some other key>:claude` does nothing to the owner's `claude`.
- **Who may sign one.** One of the vault's owner keys. The signer of the grant on file at that address. Or its
  grantee, giving it up: the `to.id` of the filed events at the address, for a key grant (an applet grant has no
  grantee key), whether the grant is in force,
  suspended or past its date (so a held event filed after an upgrade can't hand a grant back to a grantee who left).
  From anyone else it is refused.
- **A revoke is final and needs no ordering.** Once a vault holds a valid revoke for an address, no event under
  that address is ever in force again, whatever its date. So a replayed old grant, a grant dated in the future, or
  a deleted relay copy can't bring access back. A new grant needs a new id; revoking an id doesn't ban the key.
- **A revoke may come first.** An owner key, or a member for an address of their own, may revoke an address the
  vault hasn't seen. It is kept and wins when the grant arrives. This is how to cancel a grant that was signed and
  handed over but never filed: until its date, its grantee could still file it. No one else's early revoke is
  kept: a key that puts itself in an address nobody has filed has no standing. A member's early revokes count
  toward their cap (§5.2).
- **A restore can't undo a statement.** The door keeps its own copy of every statement it has passed to a vault,
  and of every door grant row (§7.3), by vault id, apart from the vault. Statements include unfiled events holding an
address suspended (§2.2), every event line 6 counted that disagrees on `to` or `under` (so a split address stays
ended after a restore or a move), and vault records (§2.3). Statements only ever add: a newer event
  replaces an older, a revoke is final. So two sets merge safely. After any restore from a backup or import of an
  older export, before the vault serves a request, the door files its copy again, overwrites each door grant row
  with its current one, ends any door grant row it doesn't hold, and tells the vault its owner keys again. A grant
  that was narrowed stays narrow, a revoke stays, and a key taken off the owner list stays off.
- **A restore never rolls back the door's copy.** On a box the door's database sits in the same home as the
  vault's, and `--restore` puts every database back [code: `packages/cli/src/release.ts`]. So a restore reads the
  door's current copy, door grant rows and owner-key list before it puts databases back, and puts them in after:
  statements merge, and for the rows and the key list the current ones win. (After an import, door grant rows a
  door kept from an earlier stay are history, like any door grant that moved: §9.) (The 0.9.0
  roadmap asks the same of `--restore` for revoked keys; it isn't in core `next` yet.) The limit: a door lost together with its vault, or an old export
  brought to a new door when the old door is gone, has no later copy to merge. Then the owner's one-tap list (§9)
  is what stands between an old grant and the vault.
- **It works on the next request.** Tokens already handed out under it are refused, and its live sockets close.
  The vault checks its own table each time, so nothing waits for a token to run out.
- **Ending a member ends their agents.** A member-signed grant hangs from one grant of the member's (its `under`
  field) and is in force only while that one is. Bringing the member back under a new id doesn't revive them.
- **Nothing is deleted.** A revoked, replaced or expired grant stays in the vault, marked, because `grant:<id>`
  stays on everything it wrote. A relay may drop such events; a vault can't.
- **Never published.** Statements say who shares what with whom. They go to the vault and nowhere else.

## 4. What a grant opens

### 4.1 Reads: one checkpoint [decided, SPEC §3.5]

Every read goes through one filtered connection, so a new read feature can't leak. A record is **visible** to a
grant when one of its types (or `*`) carries `read`, or `read:own` and the record is the grantee's own, and it
carries no denied tag. Everything else behaves as if it didn't exist:

| Surface | Under a grant |
|---|---|
| Get, list, query, both searches | visible records only; a hidden record's id or path answers 404, the same as a missing one |
| Links, backlinks, the graph, find-path | a link to a hidden record reads as a link to nothing; paths never cross one |
| History | a version is visible only if the types it had *then* are granted and it carried no denied tag *then* (core #60's rule, moved from tags to types). A version with no recorded types (written before 0.9.4) is hidden from every narrow grant |
| The names in stamps (`/api/stamps`) | only names that appear on records the grant can see; an empty list for a grant with no `read` |
| Types and counts | only granted types are listed; counts and stats count visible records only |
| Files | a ticket is checked when it is made and again when it is spent |
| The live socket | each event is checked as it is sent; ending the grant closes the socket |
| MCP | the same tools, minus the ones its verbs can't use; the server's instructions say what it reaches |
| Export, type management, keys, settings, statements | never (§4.4) |

**Grants only add** [decided, SPEC §3.5]. A record with two types is visible when either is granted. To hold one
record back, mark it: a grant's `deny` names tags, and a record carrying one is outside that grant for every verb.
A grantee can't attach a tag its grant denies (`not_granted`). It can't detach one either: a record carrying it
is hidden, so the answer is 404. Renaming, merging and deleting tags are admin (§4.4), since a deny works by tag.

**One place where hidden is not the same as missing** [code: scope gap 9, 0.9 SPEC §3.3]. Paths are one namespace,
so creating or renaming onto a hidden record's path answers 409, and a grantee who can create can learn that a path
is taken. 1.0 doesn't fix that. It bounds it: a grant with `create` and no `read` (a form) can't choose a path at
all; the vault assigns one, and a path in its request is refused. A form is a grant with no read verb on the
type. One with `read:own` reads what it made, and may choose a path like any other grantee who can create.

### 4.2 Writes

- **Create** a record only with types the grant can `create`, all of them. A grant with `create` and no `read` is a
  form: it adds and reads nothing back but its own receipt [decided: SPEC §3.5's `submit`].
- **Update** and **delete** a visible record when one of its types carries the verb (or the `:own` form and the
  record is its own). A rename or a move of the record is an update.
- **Adding a type** to a record needs `create` on that type. **Removing one** needs `delete` on it. So a grantee
  can't move a record into or out of what it sees.
- **Links.** A grantee may write a link or a `[[wikilink]]` to any name. It resolves only among records the
  grantee can see, and the answer never shows whether a hidden record had that name (0.9.1's rule for scope gap 1).
- **A refused write changes nothing** and says which verb on which type was missing, if the record is visible. If
  it isn't, the answer is 404.

### 4.3 Own records

A record is a grant's **own** when its *created* stamps are the grant's:

- for a member (`by self`): created *by* `nostr:<their key>`. It stays theirs across any new grant, and it counts
  what their own agents wrote for them;
- for an agent or an applet (`by signer`): created *by* its signer's stamp **and** *via* this grant's stamp (or one
  in its `to.was`). Both, because `applet:arcade` in Bo's shell and in yours are the same *via*;
- for a service (`by names`): created *via* this grant's stamp, or one in its `to.was`.

`was` exists because stamps change: a named key `claude` that becomes a signed grant keeps what it made by carrying
`"was": ["key:claude"]`. Only `key:`, `grant:` and `applet:` stamps may be named. Only an owner-signed grant may
carry it, and a replacement can't change it: it says "treat those records as this grantee's", and that is the
owner's to say. A member's agent passes a request only if the member's own grant passes it too (§5.2), so its
`:own` can never reach past the member's.

"The signer's stamp" is one value per person per door: for the owner, the stamp that door puts on the owner's own
writes, whichever of their keys or sign-ins was used; for a member, `nostr:<their key>`. One key is one member.

### 4.4 What no grant opens

Type management, renaming, merging or deleting tags, keys, vault settings, connect instructions, export, deleting
history, and filing or reading other grantees' statements. Narrowing applies to read and write, never admin [decided, SPEC §3.5]. A grantee can't sign a
grant for someone else's key, and a write key can't edit a grant: statements sit in the vault's own table, not
among records.

## 5. Who: three kinds of grantee, one event

The `to.by` field says whose name the grantee's writes carry. It is the only difference between a friend, an AI and a
service [decided 11-10: one primitive, "by" reused].

| Grantee | `to.by` | "By" on its writes | "Via" on its writes | Who may sign |
|---|---|---|---|---|
| **A member** (Bo) | `self` | `nostr:<Bo's key>` | `grant:<id>` | the vault's owner |
| **An agent** (your Claude, Uni) | `signer` | the signer's own stamp | `grant:<id>` | the owner; or a member, for their own agent |
| **An applet** in your shell | `signer` | the signer's own stamp | `applet:<applet id>` | whoever holds the shell: owner or member |
| **A service** (a client portal) | `names:<prefix>` | `<prefix>:<name>` when it names one; else the owner's stamp | `grant:<id>` | the vault's owner |

Stamps 0.9.1 writes keep their meaning: the owner signed in is `nostr:<key>`, `api` or `mcp`; a named key or an
approved OAuth app is `key:<name>`. `grant:` and `applet:` are added, and both are reserved prefixes.

### 5.1 Members [decided: a second person on a vault; friends reach a shared vault by members plus key sign-in]

A member is a key with a `by self` grant. Bo proves his key at the door (NIP-98), the door hands him a short token
for that vault under his grant, and the vault holds him to it. He needs no account at the door for this, though on
Cloud he will usually have one, with his own home vault. His writes are *by* `nostr:<his key>`: a stamp that means
the same at every door, because the door witnessed his key. That is the 11-10 rule in its simplest case: history
reads as a person's once their own key has signed.

A member can't make another member, change types or see the grant list beyond their own row and their agents'.

### 5.2 Agents acting for their owner [decided: an agent is a principal with an owner; its grants can't exceed its owner's]

An agent is a key with a `by signer` grant. Its writes are *by* its person and *via* its grant, as an AI's are
today.

- **Its person signs for it.** The vault's owner signs for their agents. A member signs for theirs [lean, open
  decision E], and only `by signer` grants: a member can't make a member or a service (line 8).
- **It can never reach more than its person.** A member-signed grant names the member's own grant in its `under`
  field. Without one it is malformed; one that names a grant that isn't the signer's own is incoherent (line 8,
  `invalid_statement`). The member's key keeps its standing, so a newer event that changes `under` is held and
  suspends the address (line 6). At filing, one that names a type, a verb or a date beyond that grant is refused (`read` is beyond
  `read:own`). On every request the vault passes it only if **both** grants pass it: types, verbs, `:own` and
  denies. So narrowing the member narrows their agents at once, and a member's denied tag is denied to their agents
  whatever the agent's grant says.
- **One level.** An agent can't sign for another key.
- **A cap.** A member may have at most 20 grants, held events and early revokes on file that aren't ended, since nothing is
  deleted.

### 5.3 Applets [decided: in-shell applets write with the owner's or Uni's key; attribution travels in created_via]

An applet in a shell has no key and no token. The shell holds its person's key and makes the applet's calls. So an
applet grant names the applet, not a key: `"to": {"kind": "applet", "id": "arcade", "author": "<author key>", "by": "signer"}`.

- **How it is used.** The shell, signed in as its person, asks the door for a token "as applet `arcade`". The
  vault finds the grant in force for that signer and applet, narrows the request to it, and stamps the write *via*
  `applet:arcade`. Only the grantor's own sign-in can ask this. A caller with no access to the vault gets
  the 401 an unknown vault gives. A caller with access who isn't the grantor, or an applet with no grant in force,
  is refused (403), never answered with a wider token. Asking as an applet can only narrow.
- **What the vault can hold.** It holds the request to the grant's types and verbs, so a mistake in the shell's own
  check no longer reaches the rest of the vault. It can't know which applet the shell was really running: that
  stays the shell's word, as does checking that an update is signed by the author key the grant pins.
- **The manifest uses these words** [decided: Surface and the shell share one manifest]. An applet's manifest lists
  `vault`, `type` and verbs exactly as §2.1 does, so the card, the grant and the vault's check are one list.
- **A bundle is a record with attachments** [decided]. It lives in the vault it serves, so sharing the vault shares
  the app. The shell never grants an applet the type that holds bundles. A member whose grant covers that type
  can rewrite a bundle; what stops it running under your card is the shell's check of the author's signature, not
  the vault (§11).

**A web app holds a key of its own** [decided: web apps hold a custodial key]. In Surface or on its own server, it
is a key grantee: `by signer` when it only ever writes for the owner, `by names` when it has people of its own
(§6). A browser app that connects by OAuth gets the same narrowing from the consent screen (§7.3).

## 6. A service writing for its people

### 6.1 The permission [decided 11-10; first built in 0.9.1 on a named key]

A web app, `portal.example`, runs a portal for Mara of Fernhill Bakery. Its server writes to her portal's vault and
says who each write was for.

- **Only the vault's owner allows it.** In 0.9.1 the permission sits on a named key. At 1.0 it is the grant's
  `"by": "names:<prefix>"`, and 0.9.1's keys carry over as they are (§10).
- **How a write says it.** REST: the header `Parachute-On-Behalf-Of: client-42`. MCP: `on_behalf_of`. The vault
  adds the prefix itself, from the grant. A request never names one. The stamp reads *by* `portal.example:client-42`.
- **Refused, never ignored.** The header from a grantee without the permission is refused with the fix, so a
  service that believes it is stamping can't write unstamped. An empty or malformed name is refused too.
- **It can't pose as anyone real.** A prefix is lowercase `[a-z0-9.-]`, a name is `[A-Za-z0-9._-]`, each at most 64
  characters. Neither holds a colon or an `@`, so no request can produce an account id, a `nostr:` stamp or another
  service's name. The vault refuses the reserved prefixes: `nostr`, `key`, `grant`, `applet`, `agent`, `token`,
  `operator`, `migrate`, `surface`, `mcp`, `api`.
- **On-behalf-of never opens anything.** Access comes from the grant alone.
- **The prefix outlives the key.** A service that rotates its key gets a new grant with the same prefix. The vault
  keeps, per prefix, the service keys that have held it, with dates.

### 6.2 The link statement [decided 11-10: history shows as a person's only after they sign with their own key]

Mara later gets a Nostr key.

Like a grant, a link's meaning is its canonical JSON content; its one tag, `d`, addresses it and equals the
content's `name`.

```
kind 37441, signed by the service's key        "client-42 is this key"
  tags     [["d", "portal.example:client-42"]]
  content  {"honors":"<vault id>","is":"<Mara's key>","name":"portal.example:client-42","v":1}
           no "is": the service takes the link back
kind 37442, signed by Mara's key               "that is me" / "that is not me"
  tags     [["d", "portal.example:client-42"]]
  content  {"claim":"mine","honors":"<vault id>","name":"portal.example:client-42","v":1}
           or "not-mine"
```

- **Both name the vault.** One service key may serve many vaults, so without the vault a claim made in one
  could be filed in another. The id survives a rename and a move, so the link does too.
- **Who may file a link.** The signer must hold a `names` grant in force for that prefix, in this vault, when the
  link is filed. The link in force for a name is the newest by `created_at` among those. Ending the service's grant
  stops new links and leaves the filed ones: they are labels on history that stays.
- **Filed, nothing rewritten.** The vault stores the statement beside its grants. No record changes.
- **Unconfirmed is only a claim.** With the service's statement alone, the vault lists the link as `unconfirmed`.
  The name does **not** read as Mara's, and the filter by person doesn't find it.
- **Confirmed is hers.** Once the vault holds her `mine` for that name, the link is `confirmed`: the history reads
  "Mara, via portal.example", always both, and the filter by person finds it. Her claim is about the name and her
  key, not about the service's key, so it holds when the service rotates its key and signs the same link again. A
  link to a different key needs that key's own claim.
- **A claim counts only from the key the link names.** From any other key, or before any link names that key, it
  is refused.
- **Undone three ways.** The service signs a newer link with no person. Mara signs `not-mine`; her newest claim
  counts, so she can also take that back. The owner voids the name with a revoke (kind 7440) whose
  `ends` is `name:portal.example:client-42`. Only an owner key may sign that form. It
  is final for the name, whichever service key signs a link next.
- **A link never opens a vault and never moves one.** It is a label on stamps.

## 7. The wire [lean: a proposal the contracts are written to; change it there first]

### 7.1 Filing and listing

| Call | Who | Answer |
|---|---|---|
| `POST <issuer>/account/vaults/<name>/statements` `{event}` | the owner's account credential; or NIP-98 from the event's signer or the grantee it names | `201 {kind, id, state}` |
| `GET <issuer>/account/vaults/<name>/statements` | the owner: every row. A grantee: its own. | `{grants: [...], links: [...], records: [...]}` (`records`: the vault's own records, §2.3, each marked whether it counts; owner only) |
| `GET /vault/<name>/api/vault` | anyone with access | gains `id`; under a grant, also `grant: {id, types, deny, expires_at}` |
| `GET /vault/<name>/api/stamps` | anyone with access | `{stamps: [{name, key, state}]}`: the names with a link, among records the caller can see (none without `read`) |
| the record list with `by_person=<key>` | anyone with `read` | records written by that key, or for a name with a `confirmed` link to it |

A grant row: `{id, origin, state, signer, grantee, by, types, deny, expires_at, event}`. `types` is a summary the
vault derives from the signed rows, `{<type>: [<verb>, …]}`, with an own row's verbs written `read:own`,
`update:own`, `delete:own`; `deny` is the list of denied tags; `by` is `"signer"`, `"self"` or `{names: "<prefix>"}`; `event` is the signed event, or
null for a door grant. `origin` is `signed` or
`door` (§7.3). `state` is `in_force`, `expired`, `revoked`, `replaced`, `suspended` (§2.2: a newer event the vault couldn't take;
the row carries that event too), `carried` (§9) or `ended` (its signer lost standing).

**What a carrier is told.** The owner (the account credential, or NIP-98 from an owner key) gets the refusals of
§7.4. A member filing their own agent's grant gets them too. Anyone else, including the grantee carrying its own
first grant, gets one answer for every failure: the 401 an unknown vault gives. So a stranger can't use this route
to learn that a vault exists, whose it is, or what its id is.

One route takes every statement, because the event says what it is. It goes through the door, not the vault's own
API, for two reasons: a grantee has no vault credential before its grant is filed, and the door has to learn which
keys reach which vaults to answer "which vaults can I open".

### 7.2 A grantee's credential

| Call | Answer |
|---|---|
| `POST <issuer>/account/vaults/<name>/token` with `Authorization: Nostr <NIP-98 by the grantee key>` | a short vault token under the key's grant in force there. No grant: 401, the same answer as an unknown vault. |
| the same call from the signed-in grantor with `{applet: "<id>"}` | a short token under that applet grant. No such grant in force, or any other caller: refused, never a wider token (§5.3) |

The token carries `permissions.grant: "<id>"` and nothing about types. The vault reads the rules from its own
table, from the signed event, on each request. So a replaced grant narrows at once, and a token can't claim more
than was signed. This departs from the 0.9 spec's wording ("the narrowing travels signed in the token"): open
decision I. What it keeps is the point of that line: a verifier that doesn't know `grant` refuses the token.

NIP-98 proofs are single-use. A door that runs as many copies (Cloud, a personal door) keeps the used ids where
every copy sees them, not in one process's memory [code: the box's replay map is in-process,
`packages/hub/src/nostr-http-auth.ts`].

**Every verifier refuses a permission it doesn't know** [decided, SPEC §3.5]. A box does today. Cloud's and a
personal door's vault workers don't [code: no unknown-key check in cloud `workers/vault/src/auth.ts`]. They, and
Prism's verifier, gain the refusal before any door mints a grant token. That is also what makes a rollback to 0.9
fail closed.

### 7.3 Grants nobody signed

Two things make a grant with no owner signature: an OAuth consent screen (Claude, ChatGPT, a Surface app), and an
owner who has no key (open decision B). Both are recorded as a grant row with `origin: "door"`: the door's word
that the signed-in owner agreed.

- The vault enforces a door grant exactly as a signed one. There is one path.
- The list shows it as vouched by the door. Its id is the key's name, in the same namespace as signed ids.
- It ends when its credential does (a key's year, an OAuth authorization's own life); §2.2's date rule is for
  signed grants. A handover ends every one of them, as it ends every credential.
- It is never authority anywhere else: it doesn't carry on a move.
- Its id is given by the door and never reused. A name an app chose for itself never becomes a stamp that matches
  an earlier credential's records.
- The grantee of a signed grant is always a key. Only an OAuth app or a named key is a grantee without one.
- **The rollback rule.** No row that 0.9 can mint a token from may exist for anyone whose 1.0 reach is narrower
  than that row says. That covers an OAuth authorization, a named key, a box user's role, a pubkey's role and a
  roster row. So narrowing a door grant revokes its 0.9 row and issues a credential only 1.0 can mint from; a door
  grant born narrow at 1.0 never has a 0.9 row; and a signed member is never written into the 0.9 role tables.
  Otherwise a rollback to 0.9 would hand the same app or person the whole vault.
- At 1.0 the consent screen offers types and verbs, and says what the connection will see [decided, SPEC §3.4].

### 7.4 Refusals

| When | Status and `error` |
|---|---|
| malformed event (any kind: tags that aren't lists of strings, a string that isn't well-formed Unicode or holds a control other than tab, line feed, carriage return, backspace or form feed, §2.2 line 1); tags other than exactly `d` and `expiration`, or tags that disagree with the content; content not in its canonical spelling; an unknown field, key or verb; over the size limits; no date, a date already past or more than 366 days out; incoherent verbs; a reserved or malformed prefix; `was` or a missing `under` on a member-signed grant, an `under` that isn't the signer's own grant, or a `to.by` other than `signer` on one; a dot in a member's own id | 400 `invalid_statement` |
| the id or signature doesn't verify | 400 `bad_signature` |
| it names another vault (`honors`), or isn't `at: parachute`, `gives: access`; a revoke for another vault | 400 `wrong_vault` |
| the signer has no standing here; a revoke from a key that may not end that address; a claim from a key the link doesn't name | 403 `no_standing` |
| the grantee already holds a grant in force here, or is an owner key (told to the owner; a member sees `exceeds_grantor`) | 409 `grantee_has_grant` |
| any failure, told to a carrier who isn't the owner or the member who signed | 401, as for an unknown vault |
| a member's grant reaches past the member's own | 403 `exceeds_grantor` |
| a revoke stands against the address, or against the name (a link) | 409 `revoked` |
| a newer event for the id is on file | 409 `superseded` |
| the id was ever another signer's or another grantee's; `to` or `under` differs from any event seen at the address, older or newer; a member's id outside their own start | 409 `id_taken` |
| a request under a grant that has ended or is suspended | 401 `grant_ended` |
| a newer event at an address that this vault can't take (§2.2): refused with its own reason, and the address is suspended | the reason's status; the row's `state` is `suspended`; an older event arriving later is 409 `superseded` |
| the grantee is the vault's id or any key that has signed for the vault | 400 `invalid_statement` |
| an owner override naming a key an earlier override retired | 400 `invalid_statement` |
| a vault record (§2.3) not signed by the vault's current key or an owner key; a handover filed outside an import | 403 `no_standing` |
| a visible record, a verb the grant lacks; a denied tag attached or detached | 403 `not_granted`, naming the verb and the type |
| a form (create, no read) naming its own path | 400 `path_not_allowed` |
| asking as an applet with no grant in force, or from a caller with access who isn't the grantor (§5.3) | 403 `not_granted` |
| the on-behalf header without the permission; an empty or bad name | 403 `on_behalf_not_allowed`; 400 `invalid_name` |

## 8. The three doors

The checkpoint is the vault's engine, and the engine is one piece of code on all three doors (`packages/vault/core`;
Cloud pins it). So the rule is written once. The doors differ in who the owner is, who can reach them, and what
they must still build.

| | A box | Parachute Cloud | A personal Cloudflare door |
|---|---|---|---|
| **Issuer** | the hub | the identity worker | the identity worker, one owner |
| **The owner's key** | a key linked to the owner's account, with its signed proof | a key linked to the account (arrives with 0.9.1's keys); many owners have none (decision B) | `OWNER_PUBKEY`, set at deploy |
| **Verifies a statement** | the hub, then the vault again | the identity worker, then the vault's Durable Object again | the same as Cloud |
| **Holds the grants** | the vault's database; the hub keeps an index of key → vaults | the vault's Durable Object; identity keeps the index | the same as Cloud |
| **Holds the vault's private key** (§2.3) | a 0600 file per vault in the hub's home, apart from the vault | identity's database, encrypted under a Worker secret; never the Durable Object | the same as Cloud |
| **A grantee signs in** | NIP-98 at the hub. The hub already takes NIP-98 for people it knows [code: `nostr-http-auth.ts`] | NIP-98 at identity: **new**. Today there is no key sign-in on Cloud `next` | NIP-98 at identity. Today any key but the owner's is `unknown_pubkey`; at 1.0 a key with a grant in force gets a token for that vault and nothing else |
| **Who can reach it** | the tailnet, unless the owner exposes it | anyone | anyone |
| **Still to build** | a vault owner per vault (today any `write`-role user is an admin); roles, pubkey roles and room rosters become door grants (§10) | accounts hold keys; key sign-in; the unknown-permission refusal; used NIP-98 ids shared across copies; `list-vaults` shows vaults a key was granted | the unknown-permission refusal; the grantee sign-in; used NIP-98 ids shared across copies |

Three rules hold at every door:

1. **The vault checks the signature itself.** The door's check is for a fast, clear error. A grant the door passed
   and the vault can't verify is not filed.
2. **The door tells the vault its owner keys, with dates.** The vault keeps the list. A grant counts only while its
   signer is on it. A handover in place (0.9.1) changes the list: the old owner's grants become `ended` and stay
   readable.
3. **Honest limit: the door is still trusted.** A door mints every token, so a hostile door could always get in.
   Signing doesn't change that. What it gives is §11's list.

## 9. What carries on a move

A move is an export from one door and an import at another (`tools/move`). 0.9.4's export with history adds three
things under `.parachute/`: stamps, history and links. 1.0 adds statements to the third.

| Carries | How it arrives |
|---|---|
| Records, types, files, links between records | as today |
| The four stamps and the history | carried, marked with the import that brought them (0.9.4) |
| The vault's id | kept on a move, new on a copy (§2.3) |
| The vault's private key | **never.** The arriving door makes a new key pair. The owner's tap below also signs an override naming it; for an owner with no key, `tools/move` asks the leaving door for a handover record (§2.3). Until one of those is filed, the arriving vault serves but doesn't sign as itself. The leaving door deletes every private key it held for the vault |
| The vault's records (kind 37443) | in `statements.jsonl` with every statement, so the arriving vault can still follow the key from the id |
| Every statement, word for word: grants, revokes, links, claims, vault records, the unfiled events that hold an address suspended, and every event line 6 counted that disagrees on `to` or `under` | in `.parachute/statements.jsonl`, one signed event per line. Filed again and verified again on arrival, then merged with any copy the arriving door already keeps for that vault id (§3): its revokes apply; its grants don't come into force by themselves (below) |
| The owner-key list and each prefix's service keys, with dates | for reading history only: so an old statement can still be checked. A carried key has no standing at the new door |
| **Revokes** | **in force at once.** Carrying a revoke can only close. A carried revoke is judged against the carried owner-key list and its dates: if its signer had standing for that address when it was signed, it applies, though that key has no standing at the new door. The arriving door files the carried grants (as `carried`) before it judges the carried revokes, so a grantee's own giving-up and an early revoke find their address |
| **Links and claims** | **in force at once.** They open nothing. |
| **Signed grants still within their date** | **`carried`, not in force,** until the owner brings them over: one confirmation for the whole import, no new grant signed [lean, open decision C]; the same tap signs the vault's new-key override (§2.3). Only grants whose signer is an owner key *at the new door* can come into force; the rest are `ended` |
| **A signed grant that turns up later** | At a vault that arrived by import, every signed grant dated before the arrival is filed as `carried`, whoever files it and whenever, whatever copy the door kept from an earlier stay. At a vault restored in place, the same holds for a signed grant the door's current copy doesn't hold as in force. Only the owner's confirmation brings a carried grant into force. So a grantee can't walk an old grant past the tap |
| Door grants (OAuth apps, named keys, an email-only owner's grants) | history only. Each is made again at the new door. |
| Tokens, keys, sessions | never |

Why the tap: the export is a copy, so the old door may still hold a live vault with the same id that honours the
same grants, and a revoke filed at one never reaches the other. The owner's confirmation is the statement that
this is now the vault, and the override it signs (§2.3) means the old door's key no longer speaks for it. `tools/move` already refuses to finish while the source is written to; it gains this step,
and it compares the two doors' statement lists before it finishes, so a revoke filed at the source after the export
was cut isn't left behind.

A **handover in place** on Cloud (0.9.1) moves nothing. The owner changes, so the old owner's signed grants end as
authority and stay as history. The accept screen offers the new owner the list to sign again: under new ids,
since an id is one signer's for good, and with `was` so each grantee keeps what it made.

A **rollback** from 1.0 to the last 0.9.x locks narrow grantees out and lets no one in wider, by two rules. 0.9
ignores the statements table and refuses any token carrying `permissions.grant`. And a credential that was
narrowed at 1.0 no longer exists in a form 0.9 can mint from (§7.3). Whole-vault keys and connectors go on working
as they did. A `lifecycle/` contract holds this when the upgrade is built.

## 10. From 0.9 to 1.0

Nobody has to act on the day [decided, ROADMAP "How a cloud vault and each connector move"].

| Today | At 1.0 |
|---|---|
| An OAuth authorization (a Claude or ChatGPT connector) | a door grant, `*` at its level: what it reaches today |
| A named key (0.9.1), with or without the on-behalf permission | a door grant with the same reach; its stamps stay `key:<name>` |
| A box user with a role on a vault; a pubkey given a role; a room roster | door grants: `read` is `* read`; `member` is `* read create update delete`; an admin role stays an admin, outside grants |
| A token with a tag scope | not converted. Tag scopes end at 1.0 [decided, SPEC §10]. `doctor` lists them through 0.9; the 1.0 refusal names the fix: a grant by type. On our own box 0 of 29 tokens had one; Cloud refuses them already |
| A vault with no id | at the 1.0 upgrade, the vault makes its key pair; its id is the public key (§2.3). Open decision H ships this early, in 0.9.3, as one additive field and one key file |
| The shell's signed grant records (shell-enforced since the applet contract v2) | filed as they are **if** they are in §2.1's layout: content in the grant frame, one event per vault, `honors` naming the vault's id. The shell's frame today puts the vault in each row; a vault grant drops that and gains `to.by`. A grant signed before its vault had an id can't be filed, and is signed again once |

## 11. What this stops, and what it doesn't

| It stops | How |
|---|---|
| A script holding a write token editing or deleting a grant | statements aren't records; only a valid signed event changes one |
| A replayed, back-dated or future-dated grant after a revoke | revokes are final and order-free (§3) |
| A grant quietly widened by a field an old vault doesn't know | unknown tags, fields and token permissions are refused (§2.2, §7.2) |
| A narrowing an old vault can't read leaving the wide grant in force | the newer event suspends the address (§2.2) |
| A revoke an old vault can't fully read failing open | a revoke's three fields act whatever else it carries (§3) |
| One meaning signed in two spellings, read two ways | one canonical spelling (§2.1); its vectors, a precondition of the freeze, are run by every signer and vault |
| A revoke or grant for one vault used at another with the same owner | `honors` on every statement; revokes kept per vault (§2.2, §3) |
| A leaked vault key speaking for the vault | it can't sign or end a grant; an owner override retires it, whatever it backdates (§2.3) |
| A narrow key learning what it can't read | one checkpoint; hidden is the same as missing, but for a taken path (§4.1) |
| A service naming someone outside its prefix, or a real account | the vault builds the name; reserved prefixes (§6.1) |
| A custodian pinning its history on someone's key, here or in another vault it serves | unconfirmed links don't read as the person's; links and claims name the vault (§6.2) |
| A restore or an old export bringing back a revoked grant, a wider grant or an old owner | the door keeps every statement and door grant row by vault id, files them again and names the owner keys again (§3); after an import, old grants wait for the tap (§9) |
| A grantee ending someone else's grant, or burning an id | a revoke ends one exact address and only its owner, signer or grantee may sign it (§3) |
| A rollback to 0.9 widening a narrowed app | its 0.9 credential ended when it was narrowed (§7.3) |
| A stranger probing the statements route for vaults | one answer for every failure (§7.1) |
| A friend's applet update running under your grant | the shell pins the author key; the vault holds the request to the grant either way |
| A member's AI outliving the member, or reaching past them | overlap on every request; ending the member ends it (§5.2) |

| It doesn't stop | What holds it instead |
|---|---|
| A hostile or broken door | the door mints tokens and names the owner key. Signed grants make its record checkable afterwards; they don't confine it. Self-hosting is the answer to distrust of a door. |
| A door lost together with its vault | later revokes and narrowings that only that door held are gone. An old export then carries old grants; they wait for the owner's tap (§9). |
| A stolen grantee key | it reaches what the grant names until the date or a revoke. Short dates; revoke by one tap; every write still says `grant:<id>`, and 0.9.4's undo takes a write set back. |
| A leaked vault key, before the owner acts | it can claim where the vault lives or which key is current; readers that follow the vault map could be pointed elsewhere until the owner's override. It reaches no record and no grant. An owner with no key can't override (decision B) |
| A stolen owner key | everything. Recovery for a lost or stolen owner key is the shell's open item, not solved here. |
| A custodian lying about which of its people did something | "always both": the prefix is in *by* and a link never replaces it. |
| A shell lying about which applet ran | the stamp names; the vault confines the request, not the frame. |
| A member handing their agent's key to another person | that person reaches what the member's agent could, and writes as the member. It is the member's key to give; ending the member ends it. |
| A member rewriting an applet's bundle in a shared vault | the shell runs only bundles signed by the author key the grant pins. |
| A grantee who can create learning that a path is taken | scope gap 9, bounded for forms (§4.1). |
| A grantee changing the other half of a two-type record | a record that is both `recipe` and `journal` is fully visible, editable and deletable under a grant on `recipe` alone. That is "grants only add". The marker (`deny`) is the tool for a record that must stay back. |
| What a grantee does with what it read | nothing can. What an AI reads goes to its vendor; the consent screen says so (SPEC §3.4). |

## 12. The contracts

`contracts/suites/door-v1/` in parachute-core: door contracts for behaviour decided and not built. Each is
wrapped in `red()`: it passes only while it fails for the stated reason, and turns "now green" the day the
behaviour works. They run on any door: `bun run doors -- --doors box,personal suites/door-v1`.

| File | The behaviour it holds | Spec |
|---|---|---|
| `grant.test.ts` | an owner-signed grant opens exactly the types it names to the key it names; a grant that isn't the owner's, is tampered with, names another vault, has no date, carries an unknown field or tag, has tags that disagree with its content, or isn't in its one spelling is refused, and so is a revoke for another vault; a write key can't file one; every credential shows as a grant row; the vault's own key can't be a grantee and an owner's override names the key that signs for it | §2, §4.4, §7 |
| `verbs.test.ts` | each verb alone; create without read is a form; `:own`; a denied tag; adding and removing a type | §4 |
| `ending.test.ts` | a grant stops at its date; a signed revoke stops it on the next request and is final; a stranger's revoke does nothing; a newer grant the vault can't take suspends the address | §2.2, §3 |
| `people.test.ts` | a member writes as themselves; an agent writes for its person; a member's agent never passes the member and ends with them | §5.1, §5.2 |
| `applets.test.ts` | the owner's shell asks as an applet: held to the applet's grant, stamped `applet:<id>` | §5.3 |
| `custodial.test.ts` | a `names` grant stamps its prefix; the header without it is refused; a link shows as the person's only after their own key confirms | §6 |
| `leaks.test.ts` | a narrow grant learns nothing of a hidden type by search, links, counts, type lists, history or a file ticket | §4.1 |
| `move.test.ts` | the export holds every statement word for word, the vault's id, and no credential | §9 |

Not held by a contract yet, and why: the live socket (needs a socket client in the door harness); MCP under a
grant (the tools a grant's verbs leave, and the instructions; the REST contracts hold the same checkpoint); the `carried`
state after an import (open decision C); door grants for email-only owners (open decision B); the box's roles
becoming door grants, the rollback, and revokes surviving a restore (migrations and restores, tested in
`lifecycle/` when built); the export on a box (its export is a command, not HTTP, so `move.test.ts` runs on the
other doors only); and four small rules: the tie between two events of one second, a member's cap of 20, an
owner-signed grant ending a member-signed one for the same key, and a claim that arrives before its link.

**One existing contract changes meaning** if this spec stands: `suites/v1/sharing.test.ts` and its README table
(levels, groups, link and anyone subjects, subtree targets, `POST /api/grants`). Open decision G. It is untouched.

## 13. Not in 1.0

Groups. Links for anyone. Sharing one page or subtree. Comment and suggest levels. Field-level read rules (never,
SPEC §1). A member inviting a member. One event naming several vaults (an applet that reads two vaults has two
grants and two lines on its card). Taking your own history out of a shared vault (attribution note §2.5). Recovery
of a lost owner key. Granting or denying a type or tag whose name isn't ASCII (it needs a grantable id; no vault we
checked has such a name). The vault map that reads `lives` (§2.3) and signed receipts from the vault's key.

---

## Appendix

### A. Where each part comes from

- **Decided, and where:** the event, expiry and signed revoke, per-type verbs with own-records-only, members plus
  key sign-in, applet attribution in `created_via`, one manifest, bundles as attachment records (T-448's brief,
  from the shell note's six questions, 11-10). "By" reused; a person's history only after their own key signs;
  custodial "by" under the key's own name with the owner's permission (attribution note, 11-10). Allow by type,
  deny by marker, `submit`, agents as principals, one checkpoint, every verifier fails closed, narrowing never
  reaches admin (0.9 SPEC §3.5, ROADMAP 1.0).
- **Decided 11-12 (Aaron):** a vault's id is its own Nostr key (open decision H, as §2.3 specifies it).
- **From T-462, 11-12:** the content layout: the grant frame of Uni's keys work (`v at honors gives to allow until
  purpose`, one canonical spelling) with this spec's vault fields (`to.by`, `to.was`, `deny`, `under`, `id`); the
  two-tag rule; a revoke's frozen fields and its scope by vault; suspension by an unreadable newer event; the size
  limits in bytes; the fixed `purpose` rule; the vault's own record, overrides, handovers and where its key lives.
  Weighed and reviewed in T-462 (three fresh reviewers, then one on this text: §D).
- **This spec's own, all marked [lean]:** the kind numbers; revoke as its own final event; refusing
  unknown tags; the vault id; `by signer | self | names`; member-signed agent grants; `applet:<id>` as the via
  stamp; `was`; the wire; door grants; the one-tap carry on a move; a year's limit.
- **Changed from the attribution note §2.9:** the note had an applet hold a named key (`key:applet.arcade`).
  Aaron's reply the same day was that in-shell applets write with his key or Uni's, so here an applet grant has no
  key and its stamp is `applet:<id>`. The note said a re-grant "may narrow"; here a replacement may also widen,
  because the owner signs it, and may never change who it is for.

### B. Read for this spec

Core `next` `1af67d2d` and parachute-cloud `door/0.9` `f2d1b8a`, through a read-only mapper whose citations I
spot-checked against the files: `packages/hub/src/account-keys.ts`, `grant-access.ts`, `users.ts`,
`nostr-event.ts`, `packages/vault/src/auth.ts` (the enforced permission keys, the stamps), `routing.ts`,
`portable-md.ts`; cloud `workers/identity/src/account-keys.ts`, `workers/vault/src/auth.ts`. The door suite ran
unchanged on both doors before any contract was written (§C).

### C. Checked, and not

- **Ran:** the door suite on core `next`: box-0.9.1 passes (68 pass, 0 fail). The personal door from cloud
  `door/0.9` has 2 failures and 26 unexplained differences before this work (its engine pin is older than `next`).
  Each contract in §12 was run on both doors and fails for its stated reason (the pull request quotes the lines);
  `move.test.ts` on the personal door only. No contract body has run past its first failing line: there is no door
  with grants to run it on.
- **Not run:** nothing in this spec is implemented in a door. The Nostr kind numbers were checked against the
  public kinds table only, not against every client in use.
- **Not read:** Prism's verifier; the shell's code (the shell note only); Surface's current manifest.

### D. Second eyes

Each round was a fresh Fable reviewer that had not written the spec or seen the earlier rounds' work, asked for a
SHIP or NO-SHIP on the security design. The cap was three rounds.

| Round | Verdict | What it found, and what changed |
|---|---|---|
| 1 | **NO-SHIP**, 6 must-fix | A rollback to 0.9 re-widened narrowed apps. `:own` could be widened through `was` and a shared applet stamp. Links replayed across vaults. "Hidden is the same as missing" was false in three places. Shell grants "filed as they are" contradicted one vault per event. A restore undid revokes. All fixed (§7.3, §4.3, §6.2, §4.1, §10, §3). |
| 2 | **NO-SHIP**, 2 must-fix | A restore re-widened a narrowed grant and an old owner list. A revoke's target was ambiguous, so any grantee could kill or squat an id. Fixed (§3: the door's own copy; a revoke ends one exact address). |
| 3 | **NO-SHIP**, 3 text changes, "with these applied I would call it SHIP" | Door grant rows weren't in the door's copy. On a box the door's copy was restored with the vault. A grantee could file an old grant past the owner's tap. All three applied (§3, §9). |
| After the cap: a check of those three changes only | NO-SHIP by one clause, then **SHIP** | My wording of the third left a bypass when a vault returns to a door that kept an old copy. I took the reviewer's sentence instead (§9, "A signed grant that turns up later"), and a second narrow check confirmed it: "round 3's condition is now met by the text". |

So the SHIP is on the text as it stands, and it came after the three-round cap, through two checks that looked only
at the round-3 changes. No reviewer has taken a fresh adversarial pass over the final text. The contracts had their
own review: a fresh Fable reviewer ran them on both doors (round 1 NO-SHIP for two gaps: a narrow grantee could
export, and one status was over-tight; round 2 SHIP).

**Round 4, the respelling (T-462, 11-12).** The layout above (§2.1 content in the grant frame, §2.2's suspension,
§2.3 the vault's own key, §3's revoke) was weighed in T-462 by three fresh Fable reviewers on a verdict note, then
written into this file and reviewed here:

| Pass | Verdict | What it found, and what changed |
|---|---|---|
| A fresh adversarial Fable reviewer, the whole file | **NO-SHIP**, 10 findings | Suspension depended on arrival order; vault-record overrides had no date bound and handover forks no rule, and a keyless owner's retained key had no cure; readers away from the vault can't see the owner list; carried revokes from a key without standing at the new door were refused; §2.2's preamble contradicted revokes and links; the spelling was under-specified and the helper disagreed; suspension had no way back; a revoke could later grow narrowing fields; stale tag-layout text; a contract that retired the shared vault's host. All fixed (§2.1, §2.2, §2.3, §3, §9; `_grants.ts`). |
| A fresh Fable check of those fixes only | **SHIP WITH FIXES**: 4 closed, 6 partly, 6 new | Line 6 still depended on order; held events dropped at import; a refused grant could come into force on its own; held events uncounted; an earlier key after a move; unfiled replacements. All fixed (§2.2 line 6 and bulk filing oldest first, holding against the carried owner list, re-judging only on upgrade or re-file, the member cap, §2.3 step 1, the take-back sentence). |

The second pass's fixes were made after it and have not been reviewed again. Not a freeze yet: the spelling
vectors were missing then (round 6 names them, §2.1, still short of the precondition), and open decision A asks for
one more security pass with Benjamin.

**Round 5 (T-462, 11-12).** A fresh adversarial Fable reviewer, on the round-4 check's fixes only: **SHIP WITH
FIXES**, 4 blocking (a changed `to` failed open; bulk filing dropped early revokes; a keyless owner's handover never
counted; a delisted override fell back to an earlier key), 3 more. The four were fixed and one fresh Fable re-check
said **SHIP WITH FIXES**: 3 closed, 1 partly, and a regression (revokes filed last broke one grant per grantee at a
restore). Its text fixes (line 7 judged again after revokes; who may sign a handover; the no-key dead end; refusing
a retired key) are applied and not reviewed again. Left open: a member's cap and held events, a narrowing arriving
after an import from a not-yet-linked key, and re-filing as the grantee's lever (§2.2), plus contracts for a
delisted override and for a changed `to` suspending.

**Round 6 (T-462, 11-12): #systems' pushback.** #systems built the frame into the shell's key core and sent seven
points, read against 91480cd6. #1 (a changed `to` fails open) was already closed by round 5's line 6; the replace
contract now asserts the address is suspended. Adopted: an applet's `to.by` is `signer` (line 8); one size measure,
the event as sent, computed by the vault (§2.1); DEL is a control; the frozen reads look for a repeated key only at
the top level; the minimal read takes the first `d` tag; tags are lists of strings and strings well-formed (line 1).
The spelling-vector precondition names #systems' `frame-1.0.json` and what it still lacks. A fresh adversarial Fable
reviewer on these changes: **SHIP WITH FIXES**, 1 blocking (the named vectors still expected a changed `to` to leave
the old grant in force) and 7 more; the blocking one and six others fixed (line 6 compares raw value bytes; size
escapes pinned; well-formed Unicode; the size contract's ids). One re-check: **SHIP**, all closed; its last nit
(which form a control takes in the size) is applied and not reviewed again. Left for the security pass: whether
1.0 says outright that no later version adds a key inside `to` (a key added there, or a `to` respelled, suspends the
address for good: it fails closed).

**Round 7 (T-462, 11-12): #systems' five follow-up questions.** #systems built round 6 and pinned the vectors
(bf607e4). Answers, each the fewest rules that stays fail-closed: (1) line 6 counts every event seen at an address,
older ones too, so events disagreeing on `to` or `under` end it in any arrival order, and they are carried so the
ending survives a restore or a move; (2) a member's key keeps its standing, and an `under` that isn't theirs, or a
`to.by` other than `signer`, is line 8 (`invalid_statement`), so a changed one is held and suspends; (3) every key
and string a frozen read uses is read as JSON reads it; only `to` and `under` are compared raw; (4) a control
character other than NIP-01's five in the event's own strings makes it malformed, so the id's serialisation can't
differ; (5) a key grantee may give up a suspended or expired grant. A fresh adversarial Fable reviewer on these
changes: **SHIP WITH FIXES**, 2 blocking (a split address's older event wasn't carried, so a restore revived it;
`to.by` still read as standing) and 5 more, all fixed. ROUND7_RECHECK
