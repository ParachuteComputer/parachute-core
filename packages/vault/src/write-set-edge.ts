/**
 * The request edge of the change log (0.9.4, T-471). One REST call or one MCP tool call is one write set: the
 * edge opens an AsyncLocalStorage scope, says who is writing once auth is known, and the Store reads it at the
 * start of each outermost transaction (Store.writeSetSource). Core stays free of node imports; this file is the
 * bun server's.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getWriteSet, newWriteSetId, normaliseWhy, WRITE_SET_ID_RE, type WriteSetContext } from "../core/src/change-log.ts";
import type { Store } from "../core/src/types.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import { kindOfVia } from "../core/src/write-stamp.ts";

/** A client groups several requests into one set by sending the same id. */
export const WRITE_SET_HEADER = "Parachute-Write-Set";
/** A REST write's reason (percent-encoded when it isn't plain ASCII). */
export const WHY_HEADER = "Parachute-Why";

interface Holder {
  ctx?: WriteSetContext;
  /** Set when the request (or tool call) has answered: anything it left running writes as its own set. */
  closed?: boolean;
}

const scope = new AsyncLocalStorage<Holder>();

// Hook handlers, webhook triggers and the workers they kick run outside the request that caused them, so their
// writes are their own sets, never the caller's (and an undo of the caller's set never reverts them).
HookRegistry.detach = (fn) => scope.exit(fn);

/** What the Store reads: the context of the request it is serving, if any. */
export function edgeWriteSetSource(): WriteSetContext | undefined {
  const h = scope.getStore();
  return h && !h.closed ? h.ctx : undefined;
}

/** Runs `fn` in a fresh request scope (nothing said yet: writes get their own set until `sayWriter`). */
export async function withRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  const holder: Holder = {};
  try {
    return await scope.run(holder, fn);
  } finally {
    holder.closed = true;
  }
}

/** Runs `fn` as one write set with this context (an MCP tool call), whatever scope surrounds it. */
export async function withWriteSet<T>(store: Store, ctx: WriteSetContext, fn: () => Promise<T> | T): Promise<T> {
  installSource(store);
  const holder: Holder = { ctx: { ...ctx, id: ctx.id ?? newWriteSetId() } };
  try {
    return await scope.run(holder, fn);
  } finally {
    holder.closed = true;
  }
}

function installSource(store: Store): void {
  const s = store as Store & { writeSetSource?: () => WriteSetContext | undefined };
  if (s.writeSetSource !== edgeWriteSetSource) s.writeSetSource = edgeWriteSetSource;
}

export type WriterRefusal = { status: number; body: Record<string, unknown> };

/**
 * Says who the current request writes as, from its auth and headers. Returns a refusal for a bad `why`, a malformed
 * write set id, or one another credential opened.
 */
export function sayWriter(
  store: Store,
  req: Request,
  writer: { actor: string | null; via: string | null },
): WriterRefusal | null {
  installSource(store);
  const holder = scope.getStore();
  // A read writes nothing, so its headers mean nothing: never refuse one for them.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  let why: string | null;
  try {
    const raw = req.headers.get(WHY_HEADER);
    why = normaliseWhy(raw === null ? null : decodeHeader(raw));
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message, error_type: "invalid_why", field: WHY_HEADER } };
  }
  const supplied = req.headers.get(WRITE_SET_HEADER);
  if (supplied !== null) {
    if (!WRITE_SET_ID_RE.test(supplied)) {
      return {
        status: 400,
        body: { error: `${WRITE_SET_HEADER} is 8 to 64 letters, digits, '-' or '_'.`, error_type: "invalid_write_set", field: WRITE_SET_HEADER },
      };
    }
    // Claim the id now, atomically (one writer at a time): two keys sending the same new id at once can't both get
    // in. A claimed set with no records is never listed, and is swept at the horizon.
    store.db
      .prepare("INSERT OR IGNORE INTO write_sets (id, at, actor, via, via_kind, why) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?)")
      .run(supplied, writer.actor, writer.via, kindOfVia(writer.via), why);
    const existing = getWriteSet(store.db, supplied);
    if (existing && store.db.prepare("SELECT 1 FROM write_sets WHERE undoes = ?").get(supplied)) {
      return {
        status: 409,
        body: {
          error: `Write set ${supplied} has been undone, so this request can't add to it. Nothing was written.`,
          error_type: "write_set_undone",
          field: WRITE_SET_HEADER,
          hint: "use a new id",
        },
      };
    }
    if (existing && existing.via !== writer.via) {
      return {
        status: 409,
        body: {
          error: `Write set ${supplied} was opened by another key, so this request can't add to it. Nothing was written.`,
          error_type: "write_set_not_yours",
          field: WRITE_SET_HEADER,
          hint: "drop the header, or use a new id",
        },
      };
    }
  }
  if (holder) holder.ctx = { id: supplied ?? newWriteSetId(), actor: writer.actor, via: writer.via, why };
  return null;
}

function decodeHeader(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
