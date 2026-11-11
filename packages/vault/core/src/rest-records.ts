/**
 * `/api/records` and `/api/types`: the record door over REST (SPEC §5.1, ROADMAP 0.9.1).
 *
 * The REST twin of the MCP record tools. A `/api/records…` request runs as its `/api/notes…` twin (and
 * `/api/types…` as `/api/tags…`), with its words moved by the same translator the record tools use
 * (mcp-records.ts: `paramsIn` in, `resultOut` out). So a record has one shape on both doors: `body`, `fields`,
 * `records` for a batch, `record_id` for a pointer, `types` beside `tags` (plain labels only). Auth, scopes, caps
 * and write gates are the twin's, unchanged: this is a rename at the edge of a request, never a second handler.
 *
 *   /api/records[/<id or path>[/<sub>]]   → /api/notes…   (list, get, create, patch, delete, batch, versions,
 *                                                          restore, attachments, everything under the prefix)
 *   ?include_body / ?include_fields       → ?include_content / ?include_metadata (and body_offset/body_length)
 *   ?type=<name>                          query-records `type`: the runtime folds it (tag-kind.ts foldTypeFilter)
 *   /api/types[/<name>]                   → /api/tags…    (rows say their `kind`, as list-types; writes need admin)
 *
 * A body that names an old word beside its new one (`content` with `body`) is refused, nothing written; the
 * runtime answers the refusal after auth, as any other bad request. Every `/api/notes` answer says it is leaving
 * (`Deprecation`, and a `Link` to its `/api/records` successor); `/api/records` never does.
 *
 * Pure: no runtime imports, so the cloud door can run the same translation (parachute-cloud's rest/records.ts
 * is the copy this replaces).
 */
import { paramsIn, resultOut } from "./mcp-records.js";

/** Query parameters: record word → the note word the twin reads. */
export const RECORD_QUERY_RENAMES: Readonly<Record<string, string>> = {
  include_body: "include_content",
  include_fields: "include_metadata",
  body_offset: "content_offset",
  body_length: "content_length",
};

/** `/api/types?name=` is list-types' `name`; the twin reads `tag`. */
const TYPE_QUERY_RENAMES: Readonly<Record<string, string>> = { name: "tag" };

export interface RecordsRoute {
  kind: "records" | "types";
  /** The path under the vault's `/api` that the twin runs as: `/notes…` or `/tags…`. */
  twin: string;
}

/** `/records…` or `/types…` (a path under a vault's `/api`): which door, and its twin. Anything else: null. */
export function recordsRoute(apiPath: string): RecordsRoute | null {
  const m = /^\/(records|types)(\/.*)?$/.exec(apiPath);
  if (!m) return null;
  const kind = m[1] as "records" | "types";
  return { kind, twin: `/${kind === "records" ? "notes" : "tags"}${m[2] ?? ""}` };
}

/** The record tool a REST method is the twin of: its parameter words and its answer words. */
export function recordTool(method: string): "create-record" | "update-record" | "delete-record" | "query-records" {
  const m = method.toUpperCase();
  if (m === "POST") return "create-record";
  if (m === "PATCH" || m === "PUT") return "update-record";
  if (m === "DELETE") return "delete-record";
  return "query-records";
}

/** A refusal the runtime answers as JSON (status, body). */
export interface RecordsRefusal {
  status: number;
  body: { error: string; error_type: string; field?: string; hint?: string };
}

function refusalOf(err: unknown): RecordsRefusal {
  const e = err as { message?: string; error_type?: string; field?: string; hint?: string };
  return {
    status: 400,
    body: {
      error: e?.message ?? "invalid parameters",
      error_type: e?.error_type ?? "invalid_query",
      ...(e?.field ? { field: e.field } : {}),
      ...(e?.hint ? { hint: e.hint } : {}),
    },
  };
}

/**
 * The twin's query string. Record words become note words; an old word beside its new one is refused, as in a
 * body. `type` is left in place (only the records list takes it; the runtime folds it with the vault's types).
 */
export function recordsQueryIn(kind: "records" | "types", search: URLSearchParams): URLSearchParams | RecordsRefusal {
  const renames = kind === "records" ? RECORD_QUERY_RENAMES : TYPE_QUERY_RENAMES;
  const out = new URLSearchParams();
  for (const [fresh, old] of Object.entries(renames)) {
    if (search.has(fresh) && search.has(old)) {
      return refusalOf({
        message: `pass \`${fresh}\` or \`${old}\`, not both (\`${old}\` is its old name).`,
        error_type: "invalid_query",
        field: fresh,
        hint: `use ${fresh}`,
      });
    }
  }
  for (const [k, v] of search) out.append(renames[k] ?? k, v);
  return out;
}

/**
 * The twin's JSON body: record words → note words (paramsIn, the record tools' own). A record's `fields` are
 * never walked. Not an object (an array, a string): passed on as it came, for the twin to answer.
 */
export function recordsBodyIn(method: string, body: unknown): { body: unknown } | RecordsRefusal {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body };
  try {
    return { body: paramsIn(recordTool(method), body as Record<string, unknown>) };
  } catch (err) {
    return refusalOf(err);
  }
}

/** A `/api/records` JSON answer (success or error) in record words: the record tools' own `resultOut`. */
export function recordsAnswerOut(method: string, answer: unknown): unknown {
  return resultOut(recordTool(method), answer);
}

/**
 * The headers every `/api/notes…` answer carries from 0.9.1 (SPEC §5.1): `Deprecation: true`, and a `Link` to the
 * same route under `/api/records`. `pathname` is the request's (`/vault/<v>/api/notes…`); null for anything else.
 */
export function notesDeprecationHeaders(pathname: string): { Deprecation: string; Link: string } | null {
  const m = /^(\/vault\/[^/]+\/api)\/notes(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return { Deprecation: "true", Link: `<${m[1]}/records${m[2] ?? ""}>; rel="successor-version"` };
}
