/**
 * The request edge of the change log (0.9.4, T-471). One REST call or one MCP tool call is one write set: the
 * edge opens an AsyncLocalStorage scope, says who is writing once auth is known, and the Store reads it at the
 * start of each outermost transaction (Store.writeSetSource). Core stays free of node imports; this file is the
 * bun server's.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getWriteSet, newWriteSetId, normaliseWhy, WRITE_SET_ID_RE, type WriteSetContext } from "../core/src/change-log.ts";
import type { Store } from "../core/src/types.ts";

/** A client groups several requests into one set by sending the same id. */
export const WRITE_SET_HEADER = "Parachute-Write-Set";
/** A REST write's reason (percent-encoded when it isn't plain ASCII). */
export const WHY_HEADER = "Parachute-Why";

interface Holder {
  ctx?: WriteSetContext;
}

const scope = new AsyncLocalStorage<Holder>();

/** What the Store reads: the context of the request it is serving, if any. */
export function edgeWriteSetSource(): WriteSetContext | undefined {
  return scope.getStore()?.ctx;
}

/** Runs `fn` in a fresh request scope (nothing said yet: writes get their own set until `sayWriter`). */
export function withRequestScope<T>(fn: () => T): T {
  return scope.run({}, fn);
}

/** Runs `fn` as one write set with this context (an MCP tool call), whatever scope surrounds it. */
export function withWriteSet<T>(store: Store, ctx: WriteSetContext, fn: () => T): T {
  installSource(store);
  return scope.run({ ctx: { ...ctx, id: ctx.id ?? newWriteSetId() } }, fn);
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
    const existing = getWriteSet(store.db, supplied);
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
