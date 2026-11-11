// The 0.9.2 query bench: made-up records at a given size on a box door, timed over REST.
//
//   BENCH_N=3000  bun run doors -- --doors box suites/bench/query-092.bench.ts
//   BENCH_N=94000 bun run doors -- --doors box suites/bench/query-092.bench.ts --timeout 7200000
//
// Not a contract: it asserts nothing about speed. It seeds the run's own vault with a fixed, made-up set of records
// (the same set every run: a seeded generator), then times every query operator on an indexed and on a plain field,
// search for a word that is only in a field value, the tag list and sorts, a type PUT and a retype. It writes
// `bench-<N>.json` to DOOR_RESULTS and prints one line per measurement. ROADMAP 0.9.2 row 1 and 2: "bench at 3k and
// 94k". The record shape follows the T-378 perspective 8 bench, so its numbers can be compared.
import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { door, enc, safeFetch, token, vaultUrl } from "../door/_door.ts";

const N = Number(process.env.BENCH_N ?? 3000);
const LABEL = process.env.BENCH_LABEL ?? `${N}`;
/** A PUT or a query that takes longer than this is recorded as "over" and the run moves on. */
const CAP_MS = Number(process.env.BENCH_CAP_MS ?? 120_000);
const STATUSES = ["open", "doing", "review", "done", "archived"];

interface Timed {
  status: number;
  ms: number;
  body: any;
  headers: Headers;
}
async function call(method: string, path: string, body?: unknown, capMs = CAP_MS): Promise<Timed> {
  const bearer = await token("admin");
  const t0 = performance.now();
  try {
    const r = await safeFetch(`${vaultUrl()}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(capMs),
    });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, ms: performance.now() - t0, body: parsed, headers: r.headers };
  } catch (err) {
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") return { status: -1, ms: performance.now() - t0, body: { error: `over ${capMs} ms` }, headers: new Headers() };
    throw err;
  }
}

// A fixed generator: record i is the same on every run.
function rec(i: number) {
  const day = String(1 + (i % 28)).padStart(2, "0");
  const mon = String(1 + (i % 12)).padStart(2, "0");
  return {
    path: `rec/${String(i).padStart(7, "0")}`,
    content: "",
    tags: ["rec", "item"],
    metadata: {
      customer: `c${i % 1000}`,
      status: STATUSES[i % 5],
      priority: i % 100,
      due: `2026-${mon}-${day}`,
      owner: `o${(i * 7) % 1000}`,
      rank: (i * 13) % 100,
      amount: (i % 10000) / 100,
      done: i % 2 === 0,
      project: `proj/p${i % 10}`,
      size: i % 7,
      a1: "alpha",
      a2: "beta",
      a3: `v${i % 50}`,
      a4: `w${i % 500}`,
      a5: i,
      // A word found only in this field, never in a body or a path: what "field values in search" must find.
      a6: i % 1000 === 0 ? `quokkaberry ${i}` : "some short text here",
      a8: "x",
    },
  };
}

async function seed(): Promise<{ seconds: number; rate: number }> {
  const put = (name: string, fields: unknown) => call("PUT", `/tags/${enc(name)}`, { fields });
  const r1 = await put("rec", {
    customer: { type: "string", indexed: true },
    status: { type: "string", indexed: true, enum: STATUSES },
    priority: { type: "integer", indexed: true },
    due: { type: "date", indexed: true },
    owner: { type: "string" },
    rank: { type: "integer" },
    amount: { type: "number" },
    done: { type: "boolean" },
    project: { type: "reference", indexed: true },
  });
  if (r1.status !== 200) throw new Error(`bench: declaring rec gave ${r1.status} ${JSON.stringify(r1.body).slice(0, 300)}`);
  // `item` has no reference field: its PUTs and its retype are timed apart from the reference walk.
  const r2 = await put("item", { size: { type: "integer", indexed: true } });
  if (r2.status !== 200) throw new Error(`bench: declaring item gave ${r2.status}`);
  for (let p = 0; p < 10; p++) await call("POST", "/notes", { path: `proj/p${p}`, content: "", if_exists: "ignore" });
  const t0 = performance.now();
  for (let have = 0; have < N; ) {
    const n = Math.min(500, N - have);
    const r = await call("POST", "/notes", { notes: Array.from({ length: n }, (_, k) => rec(have + k)), summary: true });
    if (r.status >= 300) throw new Error(`bench: seeding at ${have} gave ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    have += n;
    if (have % 10_000 === 0) console.log(`[bench] seeded ${have} (${(have / ((performance.now() - t0) / 1000)).toFixed(0)} rec/s)`);
  }
  const seconds = (performance.now() - t0) / 1000;
  return { seconds, rate: N / seconds };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
interface Row {
  group: string;
  name: string;
  p50?: number;
  p95?: number;
  rows?: number;
  status: number;
  note?: string;
}
const rows: Row[] = [];
function print(r: Row) {
  const t = r.p50 === undefined ? "" : `p50 ${r.p50.toFixed(1).padStart(9)} ms  p95 ${r.p95!.toFixed(1).padStart(9)} ms`;
  console.log(`[bench] ${`${r.group} | ${r.name}`.padEnd(70)} ${String(r.status).padStart(4)} ${t}${r.rows === undefined ? "" : `  rows ${r.rows}`}${r.note ? `  ${r.note}` : ""}`);
}
/** Run one GET `times` times; record p50/p95, the status and how many rows came back. */
async function q(group: string, name: string, path: (i: number) => string, times = 10) {
  const ms: number[] = [];
  let last: Timed | null = null;
  for (let i = 0; i < times; i++) {
    last = await call("GET", path(i));
    ms.push(last.ms);
    if (last.status !== 200) break;
  }
  const b = last!.body;
  const count = Array.isArray(b) ? b.length : Array.isArray(b?.notes) ? b.notes.length : undefined;
  const warn = last!.headers.get("x-parachute-warnings");
  const row: Row = {
    group,
    name,
    p50: pct(ms, 0.5),
    p95: pct(ms, 0.95),
    rows: last!.status === 200 ? count : undefined,
    status: last!.status,
    note: last!.status !== 200 ? String(b?.code ?? b?.error ?? "").slice(0, 60) : warn ? `warnings: ${decodeURIComponent(warn).slice(0, 80)}` : undefined,
  };
  rows.push(row);
  print(row);
}
async function once(group: string, name: string, method: string, path: string, body?: unknown) {
  const r = await call(method, path, body);
  const row: Row = { group, name, p50: r.ms, p95: r.ms, status: r.status, note: r.status === -1 ? String(r.body.error) : r.status >= 300 ? String(r.body?.error ?? r.body?.code ?? "").slice(0, 80) : undefined };
  rows.push(row);
  print(row);
  return r;
}

test(`query bench at ${N} records`, async () => {
  const d = door();
  console.log(`[bench] ${d.label}, N=${N}`);
  const seeded = await seed();
  console.log(`[bench] seeded ${N} in ${seeded.seconds.toFixed(0)} s (${seeded.rate.toFixed(0)} rec/s)`);
  const total = (await call("GET", "/notes?aggregate[op]=count&tag=rec")).body?.[0]?.value;
  if (total !== N) throw new Error(`bench: expected ${N} rec records, the vault counts ${total}`);
  const anyId = (await call("GET", "/notes?tag=rec&limit=1")).body[0].id;
  const hub = (await call("GET", `/notes?path=${enc("proj/p3")}`)).body[0].id;
  const J = (o: unknown) => encodeURIComponent(JSON.stringify(o));

  // Reads that 0.9.2 doesn't change: the baseline the index fixes are judged against.
  await q("read", "get by id", () => `/notes/${anyId}`);
  await q("read", "get by path", (i) => `/notes?path=${enc(`rec/${String((i * 997) % N).padStart(7, "0")}`)}`);
  await q("read", "tag list, newest 50", () => `/notes?tag=rec&sort=desc&limit=50`);
  await q("read", "deep offset (90%), limit 50", () => `/notes?tag=rec&sort=asc&limit=50&offset=${Math.floor(N * 0.9)}`, 5);
  await q("read", "count for a type", () => `/notes?aggregate[op]=count&tag=rec`, 5);
  await q("read", "count group by status", () => `/notes?aggregate[op]=count&aggregate[group_by]=status&tag=rec`, 5);
  await q("read", "near: inbound `project` of a hub, limit 50", () => `/notes?near[note_id]=${hub}&near[depth]=1&near[direction]=inbound&near[relationship]=project&tag=rec&limit=50`, 5);

  // Every operator, on an indexed field (`priority`, `customer`) and on a declared plain field (`rank`, `owner`).
  const ops: [string, string, string][] = [
    ["eq", "c7", "o7"],
    ["ne", "c7", "o7"],
    ["gt", "90", "90"],
    ["gte", "90", "90"],
    ["lt", "10", "10"],
    ["lte", "10", "10"],
    ["in", "c7,c8,c9", "o7,o14,o21"],
    ["not_in", "c7,c8,c9", "o7,o14,o21"],
    ["exists", "true", "true"],
  ];
  for (const [op, sv, pv] of ops) {
    const numeric = ["gt", "gte", "lt", "lte"].includes(op);
    const [ix, plain] = numeric ? ["priority", "rank"] : ["customer", "owner"];
    await q("operator, indexed", `${ix} ${op} ${sv}, limit 50`, () => `/notes?meta[${ix}][${op}]=${sv}&limit=50`);
    await q("operator, plain field", `${plain} ${op} ${numeric ? pv : pv}, limit 50`, () => `/notes?meta[${plain}][${op}]=${pv}&limit=50`, 5);
  }
  await q("operator, indexed", "customer eq, no match", (i) => `/notes?meta[customer][eq]=zz${i}&limit=50`);
  await q("operator, indexed", "customer eq + tag", (i) => `/notes?tag=rec&meta[customer][eq]=c${i}&limit=50`);
  await q("operator, plain field", "owner eq, no match (full scan)", (i) => `/notes?meta[owner][eq]=zz${i}&limit=50`, 5);
  await q("bare equality", "owner = o7 (plain field, JSON scan)", (i) => `/notes?metadata=${J({ owner: `o${i * 7}` })}&limit=50`, 5);
  await q("bare equality", "done = true (boolean)", () => `/notes?metadata=${J({ done: true })}&limit=50`, 5);
  await q("bare equality", "owner, no match (full scan)", (i) => `/notes?metadata=${J({ owner: `zz${i}` })}&limit=50`, 5);
  await q("sort", "status eq (20%), order_by due desc, limit 50", () => `/notes?tag=rec&meta[status][eq]=open&order_by=due&sort=desc&limit=50`, 5);
  await q("sort", "order_by due desc, limit 50 (no filter)", () => `/notes?order_by=due&sort=desc&limit=50`, 5);
  await q("sort", "order_by rank (plain field), limit 50", () => `/notes?tag=rec&order_by=rank&sort=desc&limit=50`, 5);

  // Search: a word in the body/title is today's search; a word only in a field value is 0.9.2's.
  await q("search", "a word only in a field value (quokkaberry)", () => `/notes?search=quokkaberry&limit=50`, 5);
  await q("search", "a word in every record's field value (alpha), limit 50", () => `/notes?search=alpha&limit=50`, 5);
  await q("search", "a word in a path (rec), limit 50", () => `/notes?search=rec&limit=50`, 5);

  // Writes.
  const ids: string[] = (await call("GET", "/notes?tag=rec&limit=20")).body.map((n: any) => n.id);
  const patch: number[] = [];
  for (const [k, id] of ids.entries()) patch.push((await call("PATCH", `/notes/${id}`, { metadata: { a8: `y${k}` }, force: true })).ms);
  rows.push({ group: "write", name: "PATCH one plain field", p50: pct(patch, 0.5), p95: pct(patch, 0.95), status: 200 });
  print(rows.at(-1)!);
  const post: number[] = [];
  for (let k = 0; k < 20; k++) post.push((await call("POST", "/notes", { ...rec(9_000_000 + k), path: undefined })).ms);
  rows.push({ group: "write", name: "POST one record (with a reference)", p50: pct(post, 0.5), p95: pct(post, 0.95), status: 201 });
  print(rows.at(-1)!);

  // Schema changes, last: a slow one keeps the vault busy after the client gives up.
  const item = (await call("GET", "/tags/item")).body.fields;
  await once("type PUT", "item (no reference field): add a plain field", "PUT", "/tags/item", { fields: { ...item, colour: { type: "string" } } });
  await once("type PUT", "item: add an index on a populated field", "PUT", "/tags/item", { fields: { ...item, colour: { type: "string" }, a3: { type: "string", indexed: true } } });
  // A retype of an indexed field whose every value is an integer: to string. Today accepted with no check.
  await once("retype", "item.size integer -> string (indexed, every value disagrees)", "PUT", "/tags/item", { fields: { ...item, colour: { type: "string" }, a3: { type: "string", indexed: true }, size: { type: "string", indexed: true } } });
  const after = await call("GET", "/notes?meta[size][eq]=3&limit=5");
  rows.push({ group: "retype", name: "query size eq 3 after the retype", status: after.status, rows: Array.isArray(after.body) ? after.body.length : undefined, note: after.status !== 200 ? String(after.body?.code ?? "") : undefined });
  print(rows.at(-1)!);
  const recFields = (await call("GET", "/tags/rec")).body.fields;
  await once("type PUT", "rec (has a reference field): add a plain field", "PUT", "/tags/rec", { fields: { ...recFields, colour: { type: "string" } } });

  const out = { label: LABEL, door: d.label, N, cap_ms: CAP_MS, seeded_seconds: seeded.seconds, seed_rate: seeded.rate, at: new Date().toISOString(), rows };
  const dir = process.env.DOOR_RESULTS ?? "/tmp";
  writeFileSync(join(dir, `bench-${LABEL}.json`), JSON.stringify(out, null, 1));
  console.log(`[bench] wrote ${join(dir, `bench-${LABEL}.json`)}`);
}, 6 * 3600_000);
