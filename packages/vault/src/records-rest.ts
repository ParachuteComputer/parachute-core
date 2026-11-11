/**
 * `/vault/<v>/api/records…` and `/api/types…` on the box (SPEC §5.1, ROADMAP 0.9.1): the record door over REST.
 *
 * routing.ts has already authenticated the request and applied the scope gate to its twin path (`/notes…`,
 * `/tags…`: an admin route stays admin under its new name). Here the request's words are moved by the engine's
 * translator (core/src/rest-records.ts, the record tools' own `paramsIn`/`resultOut`), the record door's own
 * rules are applied (`?type=`, a type's name refused in `tags`), and the twin handler answers.
 */
import { recordsAnswerOut, recordsBodyIn, recordsQueryIn, type RecordsRefusal, type RecordsRoute } from "../core/src/rest-records.ts";
import { foldTypeFilter, refuseTypesInTags, tagKinds } from "../core/src/tag-kind.ts";
import type { Store } from "../core/src/types.ts";
import type { TagScopeCtx } from "./routes.ts";
import { tagVisibleInScope } from "./tag-scope.ts";

const refusal = (r: RecordsRefusal) => Response.json(r.body, { status: r.status });

/** A teaching error from the engine (error_type `tag_kind`) as REST answers it: 422, as /api/notes does. */
function kindRefusal(err: unknown): Response | null {
  const e = err as { message?: string; error_type?: string; field?: string; hint?: string };
  if (e?.error_type !== "tag_kind") return null;
  return Response.json({ error: e.message, error_type: "tag_kind", ...(e.field ? { field: e.field } : {}), ...(e.hint ? { hint: e.hint } : {}) }, { status: 422 });
}

/**
 * Answer a `/api/records…` or `/api/types…` request through `run` (the twin's handler, given the twin request).
 * `apiBase` is `/vault/<v>/api`.
 */
export async function handleRecordsRest(
  req: Request,
  route: RecordsRoute,
  apiBase: string,
  store: Store,
  tagScope: TagScopeCtx,
  run: (twin: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  const visible = tagScope.raw === null ? undefined : (t: string) => tagVisibleInScope(t, tagScope.allowed, tagScope.raw);
  const twinUrl = new URL(url);
  twinUrl.pathname = `${apiBase}${route.twin}`;
  const query = recordsQueryIn(route.kind, url.searchParams);
  if (!(query instanceof URLSearchParams)) return refusal(query);

  // ?type= on the list: query-records' `type` (a type and its subtypes; with ?tag, records carrying all of them;
  // a plain tag refused with the fix). Empty, it is no filter at all.
  if (route.kind === "records") {
    const types = query.getAll("type").flatMap((v) => v.split(",")).map((t) => t.trim()).filter(Boolean);
    query.delete("type");
    if (types.length && req.method === "GET" && route.twin === "/notes") {
      const params: Record<string, unknown> = { type: types };
      const tag = query.getAll("tag").flatMap((v) => v.split(",")).filter(Boolean);
      if (tag.length) params.tag = tag;
      if (query.has("tag_match")) params.tag_match = query.get("tag_match");
      if (query.has("expand")) params.expand = query.get("expand");
      let folded: { tag: string[]; tag_match: string };
      try {
        folded = foldTypeFilter(store.db, params, visible) as { tag: string[]; tag_match: string };
      } catch (err) {
        const r = kindRefusal(err);
        if (r) return r;
        throw err;
      }
      // Full-text search filters tags as "any of them": a type with a tag and a search would quietly widen.
      if ((query.get("search") ?? "") !== "" && folded.tag_match === "all" && folded.tag.length > 1) {
        return Response.json({ error: "type with tag and search isn't one query yet: drop the tag, or search inside the type and filter", error_type: "invalid_query", field: "type" }, { status: 422 });
      }
      for (const k of ["tag", "tag_match", "expand"]) query.delete(k);
      query.set("tag", folded.tag.join(","));
      query.set("tag_match", folded.tag_match);
    }
  }
  twinUrl.search = query.toString();

  const headers = new Headers(req.headers);
  let body: string | ArrayBuffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    // Read as JSON whatever the content-type says, as the /api/notes handler does (curl -d sends a form type);
    // multipart and raw bytes go on untouched.
    if (route.kind === "records" && !/^(multipart\/|application\/octet-stream|audio\/|video\/|image\/)/.test(ct)) {
      const text = await req.text();
      body = text;
      let parsed: unknown;
      let isJson = text.trim() !== "";
      try {
        if (isJson) parsed = JSON.parse(text);
      } catch {
        isJson = false; // the twin answers bad JSON as it always has
      }
      if (isJson && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const moved = recordsBodyIn(req.method, parsed);
        if ("status" in moved) return refusal(moved);
        // The record door's tags hold plain labels: a type's name there is refused with the fix (SPEC §2.4).
        const mode = req.method === "POST" && route.twin === "/notes" ? "create" : req.method === "PATCH" && /^\/notes\/[^/]+$/.test(route.twin) ? "update" : null;
        if (mode && moved.body && typeof moved.body === "object" && !Array.isArray(moved.body)) {
          try {
            refuseTypesInTags(store.db, moved.body as Record<string, unknown>, mode, visible);
          } catch (err) {
            const r = kindRefusal(err);
            if (r) return r;
            throw err;
          }
        }
        body = JSON.stringify(moved.body);
        headers.set("content-type", "application/json");
      }
      headers.delete("content-length");
    } else {
      body = await req.arrayBuffer();
    }
  }

  const res = await run(new Request(twinUrl.toString(), { method: req.method, headers, body }));
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const answer = await res.json();
  const out = route.kind === "records" ? recordsAnswerOut(req.method, answer) : res.ok && req.method === "GET" ? withKinds(store, answer) : answer;
  const h = new Headers(res.headers);
  h.delete("content-length");
  return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers: h });
}

/** `/api/types` rows say their kind, as MCP list-types does (`/api/tags` rows don't, and keep their 0.8 shape). */
function withKinds(store: Store, answer: unknown): unknown {
  let kinds: Map<string, string> | null = null;
  const kindOf = (name: string) => (kinds ??= tagKinds(store.db)).get(name) ?? "tag";
  const row = (r: unknown) => {
    if (!r || typeof r !== "object" || typeof (r as { name?: unknown }).name !== "string") return r;
    const { name, ...rest } = r as { name: string } & Record<string, unknown>;
    return { name, kind: kindOf(name), ...rest };
  };
  return Array.isArray(answer) ? answer.map(row) : row(answer);
}
