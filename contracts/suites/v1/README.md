# v1 contracts: decided, not built yet

These describe behaviour Aaron has decided for v1 that today's code doesn't have. Each test is marked
`test.failing`: it passes while the behaviour is missing, and goes red the day the behaviour works, which is the
signal to move it to `suites/today/` (in its own pull request).

They don't run by default. Run them with:

```bash
bun run today -- --v1
```

Each file also has a plain `test` that checks its own setup works today, so a `.failing` test can't pass because
the setup broke.

## The wire shape these assume (proposed, not decided)

The grant model is from the access deep pass (`deep/access/FINDINGS.md` §1 in the T-289 research). The URLs are a
first guess, chosen to sit next to today's REST API. Change them here first if the build picks other ones.

| Call | Shape |
|---|---|
| Make a grant | `POST /vault/<n>/api/grants` `{subject: {kind: "identity"\|"group"\|"link"\|"anyone", id}, target: {kind: "vault"\|"type"\|"subtree"\|"note", id}, level: "view"\|"comment"\|"suggest"\|"edit"\|"manage"}` → 201 `{id, ...}` |
| Revoke a grant | `DELETE /vault/<n>/api/grants/<id>` → 200 |
| A private note | `POST /vault/<n>/api/notes` with `private: true`: only a grant on the note itself reaches it |
| Who acted | every write records `createdBy`/`lastUpdatedBy` = the person's identity and `createdVia`/`lastUpdatedVia` = `app:<client_id>` when an app acted for them |

## The rules they hold

- **A pass alone grants nothing.** Signing in proves who you are; what you may see comes from grants in the vault.
- **Sharing only adds up** (A13). The level on a note is the highest level of any live grant that reaches it.
  Joining a group or getting a second grant never takes anything away.
- **Private notes for exceptions.** A private note inside a shared page is reached only by grants on the note.
- **Revoking is immediate** for grant changes.
- **The consumer connector records the app** as well as the person.
