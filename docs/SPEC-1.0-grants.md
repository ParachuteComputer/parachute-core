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
| A | The four event numbers (§2.1). The shell can't sign a grant until they are fixed, and a signed one is honoured for good. | 37440 grant, 7440 revoke, 37441 link, 37442 claim. None is taken in the Nostr list today. | Permanent. Benjamin should see it. |
| B | Can someone with only an email (most of Cloud today) share a vault? | Yes. With no key to sign, the door vouches for the grant, the list says so, and it doesn't carry to another door. | It makes "signed by the owner" untrue for those vaults, plainly marked. |
| C | After a move, do your friends' grants work at the new door at once? | One tap, once: "bring these 5 grants over". Revokes apply at once with no tap. | A copy left at the old door would keep honouring them. The tap is you saying the old one is retired. |
| D | The longest a grant may last. | A year. The shell reminds you a month ahead. | Shorter is safer and asks you more often. |
| E | Who signs for a friend's AI in your shared vault? | The friend does, for their own AI, and it can never reach more than the friend can. | The other way, you approve every friend's every AI. |
| F | The first shared vault lives where? | Parachute Cloud, once it has key sign-in (it rides 0.9.1's keys). | From the shell note; friends aren't on the tailnet. |
| G | The sharing contract already in core (`v1/sharing.test.ts`) describes a different model: levels (view, comment, suggest, edit, manage), groups, links for anyone, pages. Does this spec replace it for 1.0? | Yes. 1.0 is keys, types and verbs. Groups, public links, page-level sharing and comment or suggest levels wait for 1.1. | It changes what an existing contract means, which is yours or Benjamin's call. |

**Two more, for Benjamin as much as you**

- **H. Give every vault its own id before 1.0** (lean: in 0.9.3, it is one additive field). A grant names a vault by
  id, and a box has none today. Until it does, a grant the shell signs can't be filed at 1.0 and is signed again
  once (§10).
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
- **Statement:** any signed event a vault files: a grant, a revoke, a link, a claim on a link.
- **By and via:** the two stamps on every write since 0.9.1. *By* is who it was for. *Via* is what wrote it.

## 2. The grant

### 2.1 The event [decided: an addressable Nostr event, signed by the owner; the shape is this spec's]

```
kind        37440            addressable: (kind, pubkey, d) is one grant; a newer event replaces an older
pubkey      the grantor's key
created_at  when it was signed
tags
  ["d", "<id>"]                        1 to 64 of [A-Za-z0-9._-]. One id is one grantee, for good.
  ["vault", "<vault id>"]              the vault's own id (§2.3). Never its name.
  ["p", "<grantee key>"]               the grantee, when it is a key …
  ["applet", "<applet id>", "<author key>"]    … or an applet in the grantor's shell. Exactly one of the two.
  ["by", "signer"]                     whose name its writes carry (§5): "signer", "self",
                                       or ["by", "names", "<prefix>"]
  ["type", "<type>", "<verb>", …]      one per type. "*" is every record, typed or not.
  ["deny", "<tag>"]                    zero or more: records carrying this tag are outside the grant
  ["was", "<stamp>"]                   zero or more: earlier stamps this grant carries on from (§4.3).
                                       Owner-signed grants only.
  ["under", "<the member's grant id>"] on a member-signed grant: the grant it hangs from (§5.2). Required there.
  ["expiration", "<unix seconds>"]     required. NIP-40's tag, so relays and clients read it the same way.
content     one plain sentence saying what signing this allows. The vault never parses it.
```

The verbs are **`read`, `create`, `update`, `delete`** [decided]. `read`, `update` and `delete` may each be written
`read:own`, `update:own`, `delete:own`: only records this grantee made [decided: own-records-only]. A type covers its
subtypes as the vault defines them today: a type declared under it, or named `parent/child` [decided, SPEC §3.5].

Four kinds are reserved together [lean, open decision A]: `37440` grant, `7440` revoke (a regular event, never
replaced), `37441` link statement, `37442` link claim. None appears in the kinds table of
nostr-protocol/nips as fetched on 11-10. A signature covers the kind, so these are fixed before the shell signs its
first grant.

### 2.2 When a vault takes a grant

A vault files a grant only if every line holds. It checks again on every request. Anything else is refused, with
the reason. The lines are checked in this order and the first that fails names the refusal. Lines 1, 2 and 4 hold
for every statement (a revoke, a link, a claim), and no event over 8 KB is taken.

1. **The event is whole:** the id is the hash of its fields and the signature verifies (BIP-340).
2. **It names this vault:** the `vault` tag equals the vault's own id.
3. **The signer has standing.** It is one of the vault's owner keys today; or it is a member's key, under §5.2's
   limits. An admin key that signs in *as* the owner (a personal door's `ADMIN_PUBKEYS`) has none.
4. **It knows every tag and verb.** A grant with a tag or a verb the vault doesn't know is refused, never read
   around: an unknown tag may be a limit the signer meant, and skipping it would open more than was signed.
5. **It ends:** `expiration` is present, in the future, and at most 366 days after `created_at` [lean, open
   decision D]. `created_at` is no more than ten minutes ahead of the vault's clock.
6. **The id is free or the same:** no revoke stands against its address (§3). Ids are one namespace per vault,
   shared with door grants (§7.3), and an id is never reused: a `d` that was **ever** on file under another
   signer or for another grantee is taken, ended or not, because `grant:<id>` stays on what it wrote. A member's
   own grant (`by self`) has an id with no dot. A member's agents' ids start with that id and a dot (`bo.claude`),
   and nobody else may use that start, so a member can't take an id the owner will want. If an event with this
   address is on file, this one is newer by `created_at` (on a tie the lower event id wins, as in NIP-01, so two copies
   always merge to the same answer), it is signed by the same key, and its grantee, `by`, `was` and `under` tags
   are identical. An owner with two keys replaces a grant with the key that signed it. A replacement may change types, verbs, denies and the date. It may never change who the grant is
   for or what it counts as its own.
7. **One grant per grantee:** a key holds at most one grant in force in a vault, and a signer's applet id likewise.
   A second is refused until the first has ended. So a token never has two grants to choose between. An owner-signed
   grant for a key ends a member-signed one that key holds, so a member can't block the owner. A grantee is
   never one of the vault's owner keys. To a member, a refusal about the grantee's key reads the same as
   `exceeds_grantor`, so a member can't use filing to learn which keys hold grants.
8. **It is coherent:** exactly one grantee. `update` or `delete` on a type comes with `read` or `read:own` on it.
   An applet grant doesn't name `*`. No verb reaches admin (§4.4).

A grant is **in force** while it is filed, valid by these lines, not past its date, not revoked, and its signer
still has standing.

### 2.3 The vault's own id

A grant has to name a vault that is still the same vault after a rename or a move. Today nothing fits: a box has no
vault id, and Cloud's lives at the door, not in the vault [code: no `vault_id` in core `packages/`; cloud
`workers/identity/migrations/0020_vault_id.sql`].

1.0 gives every vault an id: 32 hex characters, random, made with the vault (or at the 1.0 upgrade), stored in the
vault, shown as `id` in the vault's info, and written to the export's `vault.yaml`. Cloud's existing `vault_id`
becomes it. An import that is a **move** keeps the id. An import that is a **copy** gets a new one, and the grants
it carries are history only.

## 3. Ending a grant

- **By its date.** At `expiration` the grant stops, with no one acting.
- **By a revoke** [decided: a signed event]:

  ```
  kind     7440
  pubkey   who ends it (below)
  tags     ["a", "37440:<grantor key>:<id>"]   the grant's address, exactly
           ["vault", "<vault id>"]
  content  one plain sentence
  ```

- **A revoke ends one address and nothing else.** The address is the kind, the grantor's key and the id together.
  A revoke that names `37440:<some other key>:claude` does nothing to the owner's `claude`.
- **Who may sign one.** One of the vault's owner keys. The signer of the grant on file at that address. Or its
  grantee, giving it up. From anyone else it is refused.
- **A revoke is final and needs no ordering.** Once a vault holds a valid revoke for an address, no event under
  that address is ever in force again, whatever its date. So a replayed old grant, a grant dated in the future, or
  a deleted relay copy can't bring access back. A new grant needs a new id; revoking an id doesn't ban the key.
- **A revoke may come first.** An owner key, or a member for an address of their own, may revoke an address the
  vault hasn't seen. It is kept and wins when the grant arrives. This is how to cancel a grant that was signed and
  handed over but never filed: until its date, its grantee could still file it. No one else's early revoke is
  kept: a key that puts itself in an address nobody has filed has no standing. A member's early revokes count
  toward their cap (§5.2).
- **A restore can't undo a statement.** The door keeps its own copy of every statement it has passed to a vault,
  and of every door grant row (§7.3), by vault id, apart from the vault. Statements only ever add: a newer event
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
  tag) and is in force only while that one is. Bringing the member back under a new id doesn't revive them.
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
  in its `was` tags). Both, because `applet:arcade` in Bo's shell and in yours are the same *via*;
- for a service (`by names`): created *via* this grant's stamp, or one in its `was` tags.

`was` exists because stamps change: a named key `claude` that becomes a signed grant keeps what it made by carrying
`["was", "key:claude"]`. Only `key:`, `grant:` and `applet:` stamps may be named. Only an owner-signed grant may
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

The `by` tag says whose name the grantee's writes carry. It is the only difference between a friend, an AI and a
service [decided 11-10: one primitive, "by" reused].

| Grantee | `by` tag | "By" on its writes | "Via" on its writes | Who may sign |
|---|---|---|---|---|
| **A member** (Bo) | `self` | `nostr:<Bo's key>` | `grant:<id>` | the vault's owner |
| **An agent** (your Claude, Uni) | `signer` | the signer's own stamp | `grant:<id>` | the owner; or a member, for their own agent |
| **An applet** in your shell | `signer` | the signer's own stamp | `applet:<applet id>` | whoever holds the shell: owner or member |
| **A service** (a client portal) | `names <prefix>` | `<prefix>:<name>` when it names one; else the owner's stamp | `grant:<id>` | the vault's owner |

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
  decision E], and only `by signer` grants: a member can't make a member or a service.
- **It can never reach more than its person.** A member-signed grant names the member's own grant in its `under`
  tag. Without one it is malformed; one that names a grant that isn't the signer's own gives no standing. At filing, one that names a type, a verb or a date beyond that grant is refused (`read` is beyond
  `read:own`). On every request the vault passes it only if **both** grants pass it: types, verbs, `:own` and
  denies. So narrowing the member narrows their agents at once, and a member's denied tag is denied to their agents
  whatever the agent's grant says.
- **One level.** An agent can't sign for another key.
- **A cap.** A member may have at most 20 grants and early revokes on file that aren't ended, since nothing is
  deleted.

### 5.3 Applets [decided: in-shell applets write with the owner's or Uni's key; attribution travels in created_via]

An applet in a shell has no key and no token. The shell holds its person's key and makes the applet's calls. So an
applet grant names the applet, not a key: `["applet", "arcade", "<author key>"]`.

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
  `["by", "names", "<prefix>"]`, and 0.9.1's keys carry over as they are (§10).
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

```
kind 37441, signed by the service's key        "client-42 is this key"
  ["d", "portal.example:client-42"]   the name
  ["vault", "<vault id>"]             the vault it is said in
  ["p", "<Mara's key>"]               who it is. No "p": the service takes the link back.
kind 37442, signed by Mara's key               "that is me" / "that is not me"
  ["d", "portal.example:client-42"]   the same name
  ["vault", "<vault id>"]
  ["claim", "mine"]                   or "not-mine"
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
  counts, so she can also take that back. The owner voids the name with a revoke (kind 7440) that
  carries `["name", "portal.example:client-42"]` in place of the `a` tag. Only an owner key may sign that form. It
  is final for the name, whichever service key signs a link next.
- **A link never opens a vault and never moves one.** It is a label on stamps.

## 7. The wire [lean: a proposal the contracts are written to; change it there first]

### 7.1 Filing and listing

| Call | Who | Answer |
|---|---|---|
| `POST <issuer>/account/vaults/<name>/statements` `{event}` | the owner's account credential; or NIP-98 from the event's signer or the grantee it names | `201 {kind, id, state}` |
| `GET <issuer>/account/vaults/<name>/statements` | the owner: every row. A grantee: its own. | `{grants: [...], links: [...]}` |
| `GET /vault/<name>/api/vault` | anyone with access | gains `id`; under a grant, also `grant: {id, types, deny, expires_at}` |
| `GET /vault/<name>/api/stamps` | anyone with access | `{stamps: [{name, key, state}]}`: the names with a link, among records the caller can see (none without `read`) |
| the record list with `by_person=<key>` | anyone with `read` | records written by that key, or for a name with a `confirmed` link to it |

A grant row: `{id, origin, state, signer, grantee, by, types, deny, expires_at, event}`. `types` is
`{<type>: [<verb>, …]}`; `by` is `"signer"`, `"self"` or `{names: "<prefix>"}`; `event` is the signed event, or
null for a door grant. `origin` is `signed` or
`door` (§7.3). `state` is `in_force`, `expired`, `revoked`, `replaced`, `carried` (§9) or `ended` (its signer lost
standing).

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
| malformed event; unknown tag or verb; no date, a date already past or more than 366 days out; incoherent verbs; a reserved or malformed prefix; `was` or a missing `under` on a member-signed grant; a dot in a member's own id | 400 `invalid_statement` |
| the id or signature doesn't verify | 400 `bad_signature` |
| it names another vault | 400 `wrong_vault` |
| the signer has no standing here; a member signing `self` or `names`; an `under` that isn't the signer's own grant; a revoke from a key that may not end that address; a claim from a key the link doesn't name | 403 `no_standing` |
| the grantee already holds a grant in force here, or is an owner key (told to the owner; a member sees `exceeds_grantor`) | 409 `grantee_has_grant` |
| any failure, told to a carrier who isn't the owner or the member who signed | 401, as for an unknown vault |
| a member's grant reaches past the member's own | 403 `exceeds_grantor` |
| a revoke stands against the address, or against the name (a link) | 409 `revoked` |
| a newer event for the id is on file | 409 `superseded` |
| the id was ever another signer's or another grantee's; the `by`, `was` or `under` tag changed; a member's id outside their own start | 409 `id_taken` |
| a request under a grant that has ended | 401 `grant_ended` |
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
| Every statement, word for word: grants, revokes, links, claims | in `.parachute/statements.jsonl`, one signed event per line. Filed again and verified again on arrival, then merged with any copy the arriving door already keeps for that vault id (§3): its revokes apply; its grants don't come into force by themselves (below) |
| The owner-key list and each prefix's service keys, with dates | for reading history only: so an old statement can still be checked. A carried key has no standing at the new door |
| **Revokes** | **in force at once.** Carrying a revoke can only close. |
| **Links and claims** | **in force at once.** They open nothing. |
| **Signed grants still within their date** | **`carried`, not in force,** until the owner brings them over: one confirmation for the whole import, no new signature [lean, open decision C]. Only grants whose signer is an owner key *at the new door* can come into force; the rest are `ended` |
| **A signed grant that turns up later** | At a vault that arrived by import, every signed grant dated before the arrival is filed as `carried`, whoever files it and whenever, whatever copy the door kept from an earlier stay. At a vault restored in place, the same holds for a signed grant the door's current copy doesn't hold as in force. Only the owner's confirmation brings a carried grant into force. So a grantee can't walk an old grant past the tap |
| Door grants (OAuth apps, named keys, an email-only owner's grants) | history only. Each is made again at the new door. |
| Tokens, keys, sessions | never |

Why the tap: the export is a copy, so the old door may still hold a live vault with the same id that honours the
same grants, and a revoke filed at one never reaches the other. The owner's confirmation is the statement that
this is now the vault. `tools/move` already refuses to finish while the source is written to; it gains this step,
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
| The shell's signed grant records (shell-enforced since the applet contract v2) | filed as they are **if** they are in §2.1's shape: one event per vault, naming the vault's id. The shell note sketched one event naming several vaults; that changes to one per vault (two lines on the card). A grant signed before its vault had an id can't be filed, and is signed again once. Open decision H ships the id early so that is rare |

## 11. What this stops, and what it doesn't

| It stops | How |
|---|---|
| A script holding a write token editing or deleting a grant | statements aren't records; only a valid signed event changes one |
| A replayed, back-dated or future-dated grant after a revoke | revokes are final and order-free (§3) |
| A grant quietly widened by a tag an old vault doesn't know | unknown tags and unknown token permissions are refused (§2.2, §7.2) |
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
| `grant.test.ts` | an owner-signed grant opens exactly the types it names to the key it names; a grant that isn't the owner's, is tampered with, names another vault, has no date or carries an unknown tag is refused; a write key can't file one; every credential shows as a grant row | §2, §4.4, §7 |
| `verbs.test.ts` | each verb alone; create without read is a form; `:own`; a denied tag; adding and removing a type | §4 |
| `ending.test.ts` | a grant stops at its date; a signed revoke stops it on the next request and is final; a stranger's revoke does nothing | §3 |
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
of a lost owner key.

---

## Appendix

### A. Where each part comes from

- **Decided, and where:** the event, expiry and signed revoke, per-type verbs with own-records-only, members plus
  key sign-in, applet attribution in `created_via`, one manifest, bundles as attachment records (T-448's brief,
  from the shell note's six questions, 11-10). "By" reused; a person's history only after their own key signs;
  custodial "by" under the key's own name with the owner's permission (attribution note, 11-10). Allow by type,
  deny by marker, `submit`, agents as principals, one checkpoint, every verifier fails closed, narrowing never
  reaches admin (0.9 SPEC §3.5, ROADMAP 1.0).
- **This spec's own, all marked [lean]:** the tag layout and kind numbers; revoke as its own final event; refusing
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

