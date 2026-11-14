// History growth at today's policy (ROADMAP 0.9.4 row "Storage growth measured"; T-471).
//
//   bun suites/bench/history-growth.ts fixture <out.db> [--records N] [--body B] [--tags T] [--links L] [--per-day W] [--days D] [--seed S]
//   bun suites/bench/history-growth.ts compact <vault.db>      one maintenance pass, unbounded (what an open does, in full)
//   bun suites/bench/history-growth.ts measure <vault.db>      bytes per group of tables (dbstat), as JSON
//
// Not a contract: it asserts nothing. `fixture` makes made-up records of a given shape (sizes drawn around the
// average, a long tail), links between them, then D days of writes through the real Store on a fake clock: W writes a
// day, in sessions of 1-6 writes to one record minutes apart, most on a hot fifth of the records, through one named
// key (so the burst window applies); edits append a paragraph (55%), change fields (25%), add a tag (15%) or create a
// record (5%); the vault's maintenance pass runs once a day. Whatever this build's policy is (bursts, compression,
// compaction, the change log) is what it measures: run it against two builds to compare them. Only the simulated days'
// change log is counted (the starting import is cleared from it). `measure` reads page sizes, so free space inside a
// table counts (the file can be a little larger: its free pages aren't in dbstat). Byte counts only; nothing reads note
// text. Not counted in either group: git-history import tables (history_import_*), which only an import fills.
//
// It imports the vault engine from this checkout (packages/vault/core), so it measures the code beside it.
import { setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../../../packages/vault/core/src/store.ts";

const [mode, file, ...rest] = process.argv.slice(2);
if (!mode || !file) {
  console.error("usage: history-growth.ts fixture|compact|measure <db> [options]");
  process.exit(2);
}

function opt(name: string, fallback: number): number {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? Number(rest[i + 1]) : fallback;
}

/** Bytes per group of tables: version history, the change log, and the whole file. */
export function measure(db: Database): Record<string, number> {
  const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all() as { name: string; bytes: number }[];
  const by = (pred: (n: string) => boolean) => rows.filter((r) => pred(r.name)).reduce((a, r) => a + r.bytes, 0);
  const history = (n: string) =>
    ["note_blobs", "note_versions", "history_compact_state"].includes(n) ||
    /^(idx_note_versions|idx_note_blobs|idx_history_compact|sqlite_autoindex_note_blobs|sqlite_autoindex_note_versions|sqlite_autoindex_history_compact_state)/.test(n);
  const log = (n: string) =>
    ["record_changes", "record_change_bodies", "write_sets", "write_context", "change_log_state", "feed_readers"].includes(n) ||
    /^(idx_record_changes|idx_write_sets|sqlite_autoindex_record_changes|sqlite_autoindex_write_sets|sqlite_autoindex_record_change_bodies|sqlite_autoindex_feed_readers)/.test(n);
  const count = (sql: string) => {
    try {
      return (db.prepare(sql).get() as { n: number }).n;
    } catch {
      return 0;
    }
  };
  return {
    total_bytes: rows.reduce((a, r) => a + r.bytes, 0),
    history_bytes: by(history),
    change_log_bytes: by(log),
    records: count("SELECT COUNT(*) AS n FROM notes"),
    versions: count("SELECT COUNT(*) AS n FROM note_versions"),
    log_rows: count("SELECT COUNT(*) AS n FROM record_changes"),
    write_sets: count("SELECT COUNT(*) AS n FROM write_sets"),
  };
}

if (mode === "measure") {
  const db = new Database(file, { readonly: true });
  console.log(JSON.stringify(measure(db)));
  process.exit(0);
}

if (mode === "compact") {
  const db = new Database(file);
  const store = new SqliteStore(db);
  const t0 = performance.now();
  const summary = typeof store.compactHistory === "function" ? store.compactHistory({ budgetMs: null, maxNotes: null }) : null;
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), summary }));
  db.close();
  process.exit(0);
}

if (mode !== "fixture") throw new Error(`unknown mode ${mode}`);

const N = opt("records", 2775);
const AVG = opt("body", 6700);
const TAGS = opt("tags", 3.7);
const LINKS = opt("links", 4.3);
const PER_DAY = opt("per-day", 73);
const DAYS = opt("days", 30);
let seed = opt("seed", 7) >>> 0 || 1;
const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const WORDS = "alder birch cedar delta ember fjord grove harbor island juniper kestrel lantern meadow nectar orchard prairie quarry river saffron timber umber valley willow yarrow zephyr".split(" ");
function text(bytes: number): string {
  let out = "";
  while (out.length < bytes) out += WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.08 ? ".\n\n" : " ");
  return out.slice(0, bytes);
}

// A fixture is made in a new file only: it clears the change log of the file it is given.
if (await Bun.file(file).exists()) {
  console.error(`${file} exists; fixture writes a new file only`);
  process.exit(2);
}
let clock = Date.parse("2026-10-01T08:00:00Z");
setSystemTime(new Date(clock));
const db = new Database(file);
const store = new SqliteStore(db);
const writer = { actor: "owner", via: "key:fixture-ai" };
// One named key writes, as an AI's connector does; each call is one write set, with a reason.
(store as { writeSetSource?: () => unknown }).writeSetSource = () => ({ ...writer, why: "made-up fixture write" });
const tagPool = Array.from({ length: 40 }, (_, i) => `t${i}`);
const ids: string[] = [];
const bodies = new Map<string, string>();
for (let i = 0; i < N; i++) {
  const size = Math.max(40, Math.round(-Math.log(1 - r()) * AVG));
  const tags = new Set(Array.from({ length: Math.max(1, Math.round(TAGS * (0.5 + r()))) }, () => tagPool[Math.floor(r() * tagPool.length)]!));
  const body = text(size);
  const n = await store.createNote(body, { path: `fixture/n${i}`, tags: [...tags], metadata: { status: "open", n: i } });
  ids.push(n.id);
  bodies.set(n.id, body);
}
for (const id of ids) {
  const k = Math.round(LINKS * r() * 2);
  for (let j = 0; j < k; j++) {
    const t = ids[Math.floor(r() * ids.length)]!;
    if (t !== id) {
      try {
        await store.createLink(id, t, "related");
      } catch {}
    }
  }
}
for (const t of ["record_change_bodies", "record_changes", "write_sets"]) {
  try {
    db.exec(`DELETE FROM ${t}`);
  } catch {}
}
let writes = 0;
const hot = ids.slice(0, Math.max(1, Math.floor(ids.length / 5)));
for (let d = 0; d < DAYS; d++) {
  clock = Date.parse("2026-10-01T08:00:00Z") + (d + 1) * 86_400_000;
  let today = 0;
  while (today < PER_DAY) {
    const pool = r() < 0.8 ? hot : ids;
    const id = pool[Math.floor(r() * pool.length)]!;
    const session = 1 + Math.floor(r() * 6);
    for (let s = 0; s < session && today < PER_DAY; s++, today++, writes++) {
      clock += Math.floor(60_000 + r() * 600_000);
      setSystemTime(new Date(clock));
      const kind = r();
      if (kind < 0.55) {
        const body = `${bodies.get(id) ?? ""}\n\n${text(200 + Math.floor(r() * 600))}`;
        bodies.set(id, body);
        await store.updateNote(id, { content: body, ...writer });
      } else if (kind < 0.8) {
        await store.updateNote(id, { metadata: { status: r() < 0.5 ? "open" : "done", n: Math.floor(r() * 1000), touched: clock }, ...writer });
      } else if (kind < 0.95) {
        await store.tagNote(id, [tagPool[Math.floor(r() * tagPool.length)]!]);
      } else {
        const n = await store.createNote(text(Math.round(AVG / 2)), { path: `fixture/new-${d}-${today}-${s}`, tags: ["t1"], ...writer });
        ids.push(n.id);
        bodies.set(n.id, "");
      }
    }
  }
  clock += 3_600_000;
  setSystemTime(new Date(clock));
  // SQLite stamps the change log with its own clock; move today's rows to the fake day, so the log's sweep (30 days)
  // drops them on time in a run longer than that.
  const day = new Date(clock).toISOString();
  for (const t of ["record_changes", "write_sets"]) {
    try {
      db.prepare(`UPDATE ${t} SET at = ? WHERE at > ?`).run(day, day);
    } catch {}
  }
  const sweep = (store as { pruneChangeLogDaily?: (now?: number) => unknown }).pruneChangeLogDaily;
  if (sweep) sweep.call(store, clock);
  if (typeof store.compactHistory === "function") store.compactHistory();
}
console.log(JSON.stringify({ records: ids.length, writes, days: DAYS, ...measure(db) }));
db.close();
