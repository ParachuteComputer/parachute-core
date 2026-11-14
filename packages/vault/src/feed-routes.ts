/**
 * `/api/feed` (0.9.4, T-471): the changes after a reader's position. See core/src/feed.ts for positions and scope.
 *
 * - `GET /api/feed?reader=<name>&limit=<n>&ack=<position>`: the page after the reader's held position. A read never
 *   moves the position; `ack` commits first, then reads (one round trip).
 * - `POST /api/feed/position {reader, position}`: commit. `position` is a number up to the newest, `"now"` (skip to the
 *   newest), or `0` (from the start of what the change log keeps).
 *
 * Positions are held per (the caller's `via`, reader): a named key's are its own; callers that share a `via` (hub
 * tokens say `api`) share positions by reader name. Both routes need `read` only: committing moves the caller's own
 * bookmark, never a record.
 *
 * Before either answers, rows written outside any Store transaction (a raw statement, an older engine) are given their
 * positions (placePending), so a page or "now" doesn't stop short of them: a feed read may write that bookkeeping.
 *
 * A tag-scoped caller's scope is the one routing expanded for this request (expandTokenTagScope), so a tag put under
 * the scope since the last read brings its records in, as gap 7's rule asks. Its entries carry no `by`, `via` or
 * `write_set` (as its revisions don't, history-visibility.ts), and a `removed` entry is the id alone.
 */
import {
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_READER_RE,
  feedHorizon,
  getPosition,
  newestPosition,
  placePending,
  positionExpired,
  readFeedPage,
  setPosition,
} from "../core/src/feed.ts";
import { recordsAnswerOut } from "../core/src/rest-records.ts";
import type { Note, Store } from "../core/src/types.ts";
import { noteReadAnswer, type TagScopeCtx } from "./routes.ts";
import { noteWithinTagScope } from "./tag-scope.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bad = (error: string, error_type: string, field: string, hint?: string) =>
  json({ error, error_type, field, ...(hint ? { hint } : {}) }, 400);

function readerOf(raw: unknown): string | Response {
  if (raw === undefined || raw === null || raw === "") return "default";
  if (typeof raw !== "string" || !FEED_READER_RE.test(raw)) {
    return bad("`reader` is 1 to 64 letters, digits, '-' or '_'.", "invalid_reader", "reader");
  }
  return raw;
}

/** A position to commit: a whole number from 0 to the newest, or "now". */
function positionOf(store: Store, raw: unknown, field: string): number | Response {
  if (raw === "now") return newestPosition(store.db);
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    return bad(`\`${field}\` is a position from the feed (a whole number), "now", or 0.`, "invalid_position", field);
  }
  const newest = newestPosition(store.db);
  if (n > newest) {
    return bad(`\`${field}\` ${n} is past the newest position (${newest}); commit a next_position the feed gave you.`, "invalid_position", field, `"now" skips to the newest`);
  }
  return n;
}

function expired(store: Store, reader: string, position: number): Response {
  return json(
    {
      error: `Position ${position} is older than the change log keeps, so changes after it may be gone. Nothing was read.`,
      error_type: "feed_position_expired",
      reader,
      position,
      horizon: feedHorizon(store.db),
      hint: 'read the records you need again (GET /api/records), then POST /api/feed/position {"reader": "' + reader + '", "position": "now"}',
    },
    410,
  );
}

export async function handleFeed(req: Request, store: Store, subpath: string, via: string | null, tagScope: TagScopeCtx): Promise<Response | null> {
  const db = store.db;
  const owner = via ?? "";
  const url = new URL(req.url);
  const isRead = (subpath === "" || subpath === "/") && req.method === "GET";
  const isCommit = subpath === "/position" && req.method === "POST";
  if (!isRead && !isCommit) return null;
  placePending(store);

  if (subpath === "/position") {
    if (req.method !== "POST") return null;
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return bad('send JSON: {"reader": "<name>", "position": <number> | "now" | 0}', "invalid_body", "body");
    }
    const reader = readerOf(body.reader);
    if (reader instanceof Response) return reader;
    const position = positionOf(store, body.position, "position");
    if (position instanceof Response) return position;
    if (positionExpired(db, position)) return expired(store, reader, position);
    setPosition(db, owner, reader, position);
    return json({ reader, position });
  }

  if (subpath !== "" && subpath !== "/") return null;
  if (req.method !== "GET") return null;
  const reader = readerOf(url.searchParams.get("reader"));
  if (reader instanceof Response) return reader;
  const limitRaw = url.searchParams.get("limit");
  let limit = FEED_LIMIT_DEFAULT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) return bad(`\`limit\` is a whole number from 1 to ${FEED_LIMIT_MAX}.`, "invalid_limit", "limit");
    limit = Math.min(FEED_LIMIT_MAX, Number(limitRaw));
  }
  const ack = url.searchParams.get("ack");
  if (ack !== null) {
    const p = positionOf(store, ack, "ack");
    if (p instanceof Response) return p;
    if (positionExpired(db, p)) return expired(store, reader, p);
    setPosition(db, owner, reader, p);
  }
  const position = getPosition(db, owner, reader);
  if (positionExpired(db, position)) return expired(store, reader, position);

  const scoped = tagScope.raw !== null;
  const inScope = scoped ? (tags: string[]) => noteWithinTagScope({ tags } as unknown as Note, tagScope.allowed, tagScope.raw) : null;
  const page = readFeedPage(db, position, limit, inScope);
  const plain = new URL(url.origin); // no read options: each record as a bare GET /api/records/<id> answers it
  const changes: Record<string, unknown>[] = [];
  for (const c of page.changes) {
    if (c.op === "removed") {
      changes.push({ seq: c.seq, op: c.op, id: c.id });
      continue;
    }
    const entry: Record<string, unknown> = { seq: c.seq, op: c.op, id: c.id };
    if (c.op === "upsert") {
      const note = await store.getNote(c.id);
      if (!note) continue; // gone since the page was read: the next page carries its delete
      const answer = await noteReadAnswer(store, note, plain, tagScope);
      if (answer instanceof Response) continue;
      entry.record = recordsAnswerOut("GET", JSON.parse(JSON.stringify(answer)));
    }
    if (!scoped) {
      entry.write_set = c.write_set;
      entry.by = c.by;
      entry.via = c.via;
    }
    entry.at = c.at;
    changes.push(entry);
  }
  return json({ changes, position, next_position: page.next_position, more: page.more });
}
