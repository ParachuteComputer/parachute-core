// Builds the made-up data doctor-fix.test.ts breaks, with the candidate's own store and hub db (so the data has the
// real shape): `bun _doctor-fix-seed.ts <candidate-dir> <home> <vault>`. Prints the healthy compaction hints as JSON.
import { Database } from "bun:sqlite";
import { join } from "node:path";

const [dir, home, vault] = process.argv.slice(2) as [string, string, string];
const { BunSqliteStore } = await import(join(dir, "lib/packages/vault/core/src/store.ts"));
const { openHubDb } = await import(join(dir, "lib/packages/hub/src/hub-db.ts"));
const { registerClient } = await import(join(dir, "lib/packages/hub/src/clients.ts"));

const vdb = new Database(join(home, "vault", "data", vault, "vault.db"));
const store = new BunSqliteStore(vdb);
for (const n of ["alpha", "beta"]) {
  const note = await store.createNote(`${n} first draft`);
  await store.updateNote(note.id, { content: `${n} second draft, a little longer` });
  await store.updateNote(note.id, { content: `${n} third draft, longer again than the second` });
}
const hints = vdb.query("SELECT note_id, versions, stored, live FROM history_compact_state ORDER BY note_id").all();
vdb.close();

// One client registered 60 days ago that nothing uses, and one registered today.
const hub = openHubDb(join(home, "hub.db"));
const day = 24 * 60 * 60 * 1000;
registerClient(hub, { clientName: "Made-up old client", redirectUris: ["http://127.0.0.1:9/cb"], now: () => new Date(Date.now() - 60 * day) });
registerClient(hub, { clientName: "Made-up new client", redirectUris: ["http://127.0.0.1:9/cb"] });
hub.close();
console.log(JSON.stringify(hints));
