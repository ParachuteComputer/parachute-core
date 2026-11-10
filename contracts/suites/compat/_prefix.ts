// The REST compat suites run once per prefix (ROADMAP 0.9.1 "/api/records": the compat suites run once per prefix
// with equal results). A client's calls are written in note words, as the clients write them today; on the
// `records` prefix this edge sends them to `/api/records` in record words, the way a client moved over would
// (Prism's apps/server/src/vault-door.ts does the same), and reads the answers back into note words for the
// test. Each call is logged as its method, route, status and the shape of its answer, so a suite can then
// require both prefixes to have answered alike.
//
// The edge also holds the record door to its own promises on every answer: no note word (`content`,
// `metadata`) on a record, `types` on every record, and `tags` never repeating a type.
//
// Black box: written from the spec (SPEC §2.4, §5.1), never from the vault's translator.
import { rest, safeFetch, type Reply } from "../lib.ts";

export type Prefix = "notes" | "records";
export const PREFIXES: Prefix[] = ["notes", "records"];

/** One call, as the comparison sees it. */
export interface Logged {
  route: string;
  status: number;
  shape: unknown;
}

const BODY_IN: Record<string, string> = { content: "body", metadata: "fields", content_edit: "body_edit", notes: "records" };
const QUERY_IN: Record<string, string> = { include_content: "include_body", include_metadata: "include_fields", content_offset: "body_offset", content_length: "body_length" };
const KEYS_BACK: Record<string, string> = {
  body: "content",
  fields: "metadata",
  records: "notes",
  record_id: "note_id",
  record_path: "note_path",
  body_total_length: "content_total_length",
  body_next_offset: "content_next_offset",
  body_offset: "content_offset",
  body_length: "content_length",
};
/** A person's own names and values: never renamed. */
const OPAQUE = new Set(["fields", "metadata", "relationships", "validation_status"]);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const isRecordRow = (o: Record<string, any>) => typeof o.id === "string" && typeof o.path === "string" && ("tags" in o || "types" in o);

/** A list of names split into the vault's types and its plain tags. */
function split(list: unknown, types: Set<string>): { tags: unknown; types: string[] } {
  if (!Array.isArray(list)) return { tags: list, types: [] };
  return { tags: list.filter((n) => !types.has(n)), types: list.filter((n) => types.has(n)) };
}

/** One write item in record words. */
function itemIn(item: unknown, types: Set<string>, create: boolean): unknown {
  if (!isObj(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "notes" && Array.isArray(v)) out.records = v.map((x) => itemIn(x, types, create));
    else if (k !== "tags") out[BODY_IN[k] ?? k] = v;
  }
  const tags = item.tags;
  if (Array.isArray(tags)) {
    const s = split(tags, types);
    out.tags = s.tags;
    if (s.types.length) out.types = s.types;
  } else if (isObj(tags)) {
    const add = split(tags.add, types);
    const remove = split(tags.remove, types);
    out.tags = { ...tags, ...(tags.add !== undefined ? { add: add.tags } : {}), ...(tags.remove !== undefined ? { remove: remove.tags } : {}) };
    if (add.types.length || remove.types.length) out.types = { ...(add.types.length ? { add: add.types } : {}), ...(remove.types.length ? { remove: remove.types } : {}) };
  } else if (tags !== undefined) out.tags = tags;
  return out;
}

/** A record-door answer back in note words, checking the record door's promises on the way. */
function answerBack(v: unknown, where: string): unknown {
  if (Array.isArray(v)) return v.map((x) => answerBack(x, where));
  if (!isObj(v)) return v;
  if (isRecordRow(v)) {
    for (const old of ["content", "metadata"]) if (old in v) throw new Error(`record door: a record carries the note word \`${old}\` (${where})`);
    if (!Array.isArray(v.types)) throw new Error(`record door: a record has no \`types\` (${where})`);
    const repeated = (Array.isArray(v.tags) ? v.tags : []).filter((t: string) => v.types.includes(t));
    if (repeated.length) throw new Error(`record door: \`tags\` repeats its types ${JSON.stringify(repeated)} (${where})`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const nk = KEYS_BACK[k] ?? k;
    out[nk] = OPAQUE.has(k) ? val : answerBack(val, where);
  }
  // The note door's tags list every name on the note.
  if (isRecordRow(v) && Array.isArray(v.tags) && Array.isArray(v.types)) out.tags = [...new Set([...v.types, ...v.tags])].sort();
  return out;
}

/** The shape of an answer: keys and value types, never values (ids, stamps and run ids differ per prefix). */
export function shapeOf(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return [...new Set(v.map((x) => JSON.stringify(shapeOf(x))))].sort().map((x) => JSON.parse(x));
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  return typeof v;
}

/** The route as both prefixes share it: note words, the run id and a record's id or path taken out. */
function routeOf(method: string, path: string, runIds: string[]): string {
  const [p, q = ""] = path.split("?");
  let shown = p!.replace(/^\/(notes|records)\/[^/]+/, "/notes/:id").replace(/^\/records(?=\/|$)/, "/notes");
  for (const r of runIds) shown = shown.split(encodeURIComponent(r)).join("R").split(r).join("R");
  const keys = [...new URLSearchParams(q).keys()].map((k) => Object.entries(QUERY_IN).find(([, b]) => b === k)?.[0] ?? k);
  return `${method} ${shown}${keys.length ? "?" + [...new Set(keys)].sort().join("&") : ""}`;
}

/**
 * `rest(base, token)` for one prefix. Paths are written as the clients write them (`/notes…`); on `records` they go
 * to `/records…` in record words. `log` collects each `/notes…` call; `runIds` are the per-prefix names taken out
 * of the logged routes.
 */
export function prefixed(base: string, token: string, prefix: Prefix, log?: Logged[], runIds: string[] = []) {
  const plain = rest(base, token);
  async function typeNames(): Promise<Set<string>> {
    const r = await plain.get("/types");
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`GET /types: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return new Set(r.body.filter((t: any) => t?.kind === "type").map((t: any) => t.name));
  }
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const notesPath = /^\/notes(\/|\?|$)/.test(path);
    if (!notesPath) return plain.call<T>(method, path, body);
    let sent = path;
    let sentBody = body;
    if (prefix === "records") {
      const [p, q] = path.split("?");
      const query = new URLSearchParams(q ?? "");
      const moved = new URLSearchParams();
      for (const [k, v] of query) moved.append(QUERY_IN[k] ?? k, v);
      sent = `${p!.replace(/^\/notes/, "/records")}${q !== undefined ? "?" + moved.toString() : ""}`;
      if (isObj(body)) {
        const hasTags = JSON.stringify(body).includes('"tags"');
        sentBody = itemIn(body, hasTags ? await typeNames() : new Set(), method === "POST");
      }
    }
    const r = await plain.call<any>(method, sent, sentBody);
    const back = prefix === "records" && r.body && typeof r.body === "object" ? answerBack(r.body, `${method} ${path}`) : r.body;
    log?.push({ route: routeOf(method, path, runIds), status: r.status, shape: shapeOf(back) });
    return { status: r.status, body: back as T, headers: r.headers };
  }
  return {
    call,
    get: <T = any>(p: string) => call<T>("GET", p),
    post: <T = any>(p: string, b: unknown) => call<T>("POST", p, b),
    patch: <T = any>(p: string, b: unknown) => call<T>("PATCH", p, b),
    put: <T = any>(p: string, b: unknown) => call<T>("PUT", p, b),
    del: <T = any>(p: string) => call<T>("DELETE", p),
    /** A bare request to this prefix's collection (no token): what an unauthenticated client gets. */
    anonymous: (query = "") => safeFetch(`${base}/api/${prefix}${query}`),
  };
}

/**
 * The two prefixes answered alike: the same calls, the same statuses, and answers of the same shape once read back
 * into note words. Returns the first difference, or null.
 */
export function firstDifference(a: Logged[], b: Logged[]): string | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return `call ${i}: only one prefix made it (${JSON.stringify(x ?? y).slice(0, 200)})`;
    if (x.route !== y.route) return `call ${i}: ${x.route} vs ${y.route}`;
    if (x.status !== y.status) return `call ${i} ${x.route}: status ${x.status} vs ${y.status}`;
    const sx = JSON.stringify(x.shape);
    const sy = JSON.stringify(y.shape);
    if (sx !== sy) return `call ${i} ${x.route}: answer shape\n  notes:   ${sx.slice(0, 600)}\n  records: ${sy.slice(0, 600)}`;
  }
  return null;
}
