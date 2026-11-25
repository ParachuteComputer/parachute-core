/**
 * `docs`: Parachute's docs for the version this vault runs, as markdown, from parachute.computer (T-476).
 *
 * Why: the guides used to be seeded into every new vault as notes (seed-packs.ts), and they went stale there, one copy
 * per vault, with nothing to update them. The docs now live once, on the site, written and checked against the code;
 * every page is served as HTML for people and as plain markdown for an agent (`/docs/<page>.md`, `/llms.txt` the list),
 * and the pages for each version at `/docs/v/<major.minor>/<page>.md`. Aaron, 11-25: an agent "using parachute to really
 * know effectively how to find the parachute docs … thinking about what version number is calling it".
 *
 *   docs {}                              the list of pages
 *   docs { topic: "fix/needs-admin" }    that page as markdown, for this version (a page's address works too)
 *   docs { topic: "build/make-a-type#fields" }   only that section
 *   docs { search: "admin" }             the pages that best match, one line each
 *
 * And for the doors: every refusal carries `docs`, the address of the page with its fix ({@link withRefusalDocs}, the
 * map {@link REFUSAL_DOCS}), and the connect-time brief names this tool and the version ({@link docsBriefLine}), with
 * "X is out" when the site's /latest.json says so ({@link latestRelease}, never awaited at connect).
 *
 * Only the topic leaves the server, to the docs origin; nothing of the vault does. The origin is
 * https://parachute.computer unless the door says otherwise (a box: `docs.base_url` in its config, or
 * PARACHUTE_DOCS_URL; `off` lists no tool, {@link docsOrigin}). Pages are kept for an hour in the process's memory, at
 * most 64 of them, each read up to 200 KB. When the site can't be read, the last copy answers, else a small offline
 * copy bundled here (the fix pages and the list), marked as such.
 *
 * Pure apart from `fetch` (injected for tests), so the cloud door builds the same tool.
 */
import type { McpToolDef } from "./mcp.js";

export const DOCS_ORIGIN = "https://parachute.computer";
const TTL_MS = 60 * 60 * 1000;
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PAGES = 64;
const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 8000;
/** A page name: lower-case words joined by `-`, in at most three folders (`build/reference/mcp`). */
const TOPIC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}$/;
const ANCHOR_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Short on purpose: every tool's description is read before the first call (the budget in contracts/suites/mcp/budget.test.ts).
export const DOCS_DESCRIPTION = "Parachute's docs for this version, as markdown. `search` finds pages; `topic` reads one (a refusal's `docs` too).";

export const DOCS_INPUT_SCHEMA = {
  type: "object",
  properties: { topic: { type: "string" }, search: { type: "string" } },
} as const;

/** Where the docs are and which version they're for: what a door hands the tool, the brief and its refusals. */
export interface DocsContext {
  /** The docs origin (a base URL, maybe with a path); `null`: no docs (no tool, no section, no `docs` on refusals). */
  origin: string | null;
  /** The version this door runs (core's: `0.9.0-pre.2`). */
  version: string;
}

export interface DocsToolOpts {
  /** The docs origin (no trailing slash needed). Default {@link DOCS_ORIGIN}. */
  origin?: string;
  /** The version this door runs; pages are read for its `major.minor`. Omitted: the latest pages. */
  version?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where pages are kept between calls. Default: one store for the process, shared by every session and door
   *  (a door builds its tools per request, so a store per tool would never be hit). */
  cache?: Map<string, Page>;
}

/** A page as last read; `text: null` is a page the site doesn't have (404), kept as briefly as a page. */
export type Page = { at: number; text: string | null };

/** The process's pages, by address. */
const PAGES = new Map<string, Page>();

/** `0.9.0-pre.2` → `0.9`; null for anything that isn't a version. */
export function docsMinor(version: string | undefined): string | null {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(version?.trim() ?? "");
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

const trimOrigin = (o: string) => o.trim().replace(/\/+$/, "");

/** The address a person opens for a page (and the docs tool takes as a topic): this version's when the version is known. */
export function docsPageUrl(ctx: { origin: string; version?: string }, topic: string): string {
  const [path, anchor] = topic.split("#");
  const minor = docsMinor(ctx.version);
  return `${trimOrigin(ctx.origin)}/docs/${minor ? `v/${minor}/` : ""}${path}/${anchor ? `#${anchor}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusals point at their fix
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The page with the fix for each refusal (`error_type`) and each warning `code` that has one. One list for every door
 * and the site: the site's `/docs/index.json` `errors` is checked equal to it (parachute.computer, the docs check).
 * A type not here points at `fix/refusals`, the page that lists every one.
 */
export const REFUSAL_DOCS: Readonly<Record<string, string>> = {
  // a key's level or reach: what admin is, and how the person grants it
  unknown_tool: "fix/needs-admin",
  insufficient_scope: "fix/needs-admin",
  skill_needs_admin: "fix/needs-admin",
  tag_scope_violation: "fix/needs-admin",
  tag_in_use_by_tokens: "fix/needs-admin",
  // a type that isn't there, or isn't one
  tag_not_found: "fix/unknown-type",
  unknown_tag: "fix/unknown-type",
  tag_kind: "fix/unknown-type",
  retype_conflict: "fix/unknown-type",
  // a file over a limit, or of a kind the vault won't keep
  inline_too_large: "fix/file-too-large",
  file_too_large: "fix/file-too-large",
  image_too_large: "fix/file-too-large",
  blocked_upload_extension: "fix/file-too-large",
  unsupported_attachment_type: "fix/file-too-large",
  attachments_not_included: "fix/file-too-large",
  storage_cap_exceeded: "fix/file-too-large",
  // someone else changed it first
  conflict: "fix/conflict",
  precondition_required: "fix/conflict",
  transition_conflict: "fix/conflict",
  // not there
  not_found: "fix/not-found",
  ambiguous_path: "fix/not-found",
};

/** The fix page for a refusal or warning type. */
export const refusalTopic = (type: string): string => (Object.hasOwn(REFUSAL_DOCS, type) ? REFUSAL_DOCS[type]! : "fix/refusals");
/** The fix page a warning code has, or undefined (only the map's own keys: never `constructor`). */
const fixFor = (code: unknown): string | undefined => (typeof code === "string" && Object.hasOwn(REFUSAL_DOCS, code) ? REFUSAL_DOCS[code] : undefined);

/** The person's step for a refusal only they can fix, when the refusal names none (T-476 eval). Checked against the
 *  approval page (one tick per level, packages/hub/src/oauth-ui.ts) and `parachute keys new … --can`. */
export const PERSON_STEPS: Readonly<Record<string, string>> = {
  insufficient_scope: "The person grants it: they connect this AI again and leave the level it needs ticked on Parachute's approval page.",
};

type Result = { content: { type: string; [k: string]: unknown }[]; structuredContent?: Record<string, unknown>; isError?: boolean; [k: string]: unknown };

/**
 * A `tools/call` result with `docs` on its refusal: the address of the page with the fix, for this version. The one
 * text block is the refusal again, so it still equals `structuredContent` (one way to refuse, mcp-refusal.ts). Every
 * other result, and every result when the door has no docs, is returned as it came.
 */
export function withRefusalDocs<R extends Result>(result: R, ctx: DocsContext | null | undefined): R {
  const sc = result?.structuredContent;
  if (!ctx?.origin || result?.isError !== true || !sc || typeof sc.error_type !== "string" || "docs" in sc) return result;
  // A level refusal with no next step of its own says the person's (the eval found AIs relay the words and the link,
  // and never read the page: "grant this connection admin scope" left the person with nothing to do).
  const step = sc.hint === undefined && Object.hasOwn(PERSON_STEPS, sc.error_type) ? { hint: PERSON_STEPS[sc.error_type] } : {};
  const refusal = { ...sc, ...step, docs: docsPageUrl({ origin: ctx.origin, version: ctx.version }, refusalTopic(sc.error_type)) };
  return { ...result, structuredContent: refusal, content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }] };
}

/** A tool's reply with `docs` on each warning whose `code` has a fix page (`unknown_tag`: a type that isn't there). */
export function withWarningDocs(reply: unknown, ctx: DocsContext | null | undefined): unknown {
  if (!ctx?.origin || !reply || typeof reply !== "object" || Array.isArray(reply)) return reply;
  const warnings = (reply as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings) || !warnings.some((w) => w && typeof w === "object" && fixFor((w as { code?: unknown }).code))) return reply;
  const origin = ctx.origin;
  return {
    ...(reply as Record<string, unknown>),
    warnings: warnings.map((w) => {
      const fix = w && typeof w === "object" ? fixFor((w as { code?: unknown }).code) : undefined;
      return fix && !("docs" in w) ? { ...w, docs: docsPageUrl({ origin, version: ctx.version }, fix) } : w;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The newest release (/latest.json), for "X is out"
// ---------------------------------------------------------------------------------------------------------------------

/** What the site's /latest.json says (written at each site build from npm). */
export interface LatestRelease {
  latest?: string;
  beta?: string;
}

const LATEST = new Map<string, { at: number; value: LatestRelease | null; pending: { since: number } | null }>();

/**
 * The newest release as last read, and, when that is missing or six hours old, a read of /latest.json started in the
 * background. `refresh` is that read's promise, handed only to the caller that started it (a Worker passes it to its
 * own request's `waitUntil`; another request's promise there would hang). Never waits on the site: a connect answers
 * with what's kept, so the first connect after a start says no "X is out". A read that never settles (a Worker
 * request ended under it) is given up after twice the fetch timeout, so the next caller starts another.
 */
export function latestRelease(origin: string, opts: { fetch?: typeof fetch; now?: () => number } = {}): { value: LatestRelease | null; refresh: Promise<void> | null } {
  const now = opts.now ?? Date.now;
  const key = trimOrigin(origin);
  const kept = LATEST.get(key);
  const busy = kept?.pending && now() - kept.pending.since < 2 * TIMEOUT_MS;
  if (kept && (busy || (!kept.pending && now() - kept.at < LATEST_TTL_MS))) return { value: kept.value, refresh: null };
  const get = opts.fetch ?? fetch;
  const mark = { since: now() };
  const entry = { at: kept?.at ?? 0, value: kept?.value ?? null, pending: mark as { since: number } | null };
  LATEST.set(key, entry); // before the read starts, so a read that fails at once still leaves this entry settled
  const refresh = (async () => {
    try {
      const res = await get(`${key}/latest.json`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return;
      }
      const { bytes } = await readCapped(res, 16 * 1024);
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { core?: { latest?: unknown; beta?: unknown } };
      const pick = (v: unknown) => (typeof v === "string" && docsMinor(v) ? v : undefined);
      entry.value = { latest: pick(j?.core?.latest), beta: pick(j?.core?.beta) };
    } catch {
      // unreachable or not JSON: keep what we had, and try again after the same wait
    } finally {
      entry.at = now();
      if (entry.pending === mark) entry.pending = null;
    }
  })();
  return { value: entry.value, refresh };
}

/** Forget every kept /latest.json (tests). */
export function forgetLatestRelease(): void {
  LATEST.clear();
}

type Semver = { nums: number[]; pre: (string | number)[] };
function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [] };
}
/** Semver order (2.0.0 §11): numbers first; a prerelease comes before its release; prerelease parts in turn. */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The release to tell this version about, or null: `latest` when it is newer; `beta` when it is newer and this
 * version is itself a prerelease (someone on 0.8.0 isn't told about 0.9.0-pre.3).
 */
export function newerRelease(version: string, latest: LatestRelease | null | undefined): string | null {
  if (!latest || !parseSemver(version)) return null;
  const pre = parseSemver(version)!.pre.length > 0;
  const candidates = [latest.latest, pre ? latest.beta : undefined].filter((v): v is string => !!v && !!parseSemver(v) && compareVersions(v, version) > 0);
  return candidates.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

/** The connect-time brief's docs line (vault-projection.ts "## Docs"). */
export function docsBriefLine(ctx: { origin: string; version: string; newer?: string | null }): string {
  let host: string;
  try {
    const u = new URL(ctx.origin);
    host = u.host + u.pathname.replace(/\/+$/, "");
  } catch {
    host = ctx.origin;
  }
  const v = docsMinor(ctx.version) ? `Parachute ${ctx.version}${ctx.newer ? ` (${ctx.newer} is out)` : ""}. ` : "";
  return `${v}\`docs {search}\` or \`docs {topic}\` reads ${host}'s pages for this version; a refusal's \`docs\` names the page with its fix.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The offline copy
// ---------------------------------------------------------------------------------------------------------------------

/** The pages an agent most needs when the site can't be read: one line each, and the fix pages in three lines. The
 *  site's pages say the same first (parachute.computer CLAUDE.md, "fix pages"). */
export const OFFLINE_PAGES: Readonly<Record<string, { title: string; summary: string; body?: string }>> = {
  "fix/needs-admin": {
    title: "Needs admin (or write)",
    summary: "A connection reaches one vault at one level: read, write or admin. A refusal or a missing tool means this one is below what the act needs.",
    body:
      "Every connection reaches a vault at one level. Read sees records; write also creates, changes and deletes them and may define types; admin also manages keys, the vault's description and skills. A tool above a connection's level isn't listed for it.\n\n" +
      "The fix is the person's, not the AI's: they connect this AI again (remove it in their AI app and add it back) and leave the level it needs ticked on the Parachute approval page that opens. On their own server they can also make a key with that level: `parachute keys new <name> --vault <vault> --can admin`. Don't try another way round the refusal; tell the person what you were trying and which level it needs.",
  },
  "fix/unknown-type": {
    title: "A type that isn't there",
    summary: "The type you named has no records and no definition. Check its name with list-types, or make it.",
    body:
      "`list-types` lists every type this connection can see; check the spelling (types are lower-case, `book` not `Books`). If it really doesn't exist, make it: `manage-types {action: \"update\", tag: \"book\", kind: \"type\", fields: {…}}` (write access may define a type), or write a record with `types: [\"book\"]`, which defines it.\n\n" +
      "Ask the person before inventing a type for something they may already keep under another name.",
  },
  "fix/file-too-large": {
    title: "A file too large",
    summary: "A file sent inside the call has a small limit; larger files go up through a one-use upload URL.",
    body:
      "`add-attachment` takes a file inside the call up to 80 KiB. For a larger one, `attachment-url {action: \"upload\"}` gives a one-use URL: PUT the bytes there if your runtime can reach the vault's host. The vault's own upload limit, a blocked file type, or (on Parachute Cloud) the plan's storage can also refuse a file: the refusal's message says which.\n\n" +
      "If you can't reach the URL (a sandbox with no network), tell the person to add the file in the Parachute app.",
  },
  "fix/conflict": {
    title: "Changed by someone else first",
    summary: "The record changed since you read it. Read it again, re-apply your change to what's there now, and write with the new updatedAt.",
    body:
      "Writes carry `if_updated_at: <the updatedAt you read>`. When the record changed in between, the write is refused and nothing is applied: read it again (`query-records {id}`), re-apply your change to the current text, and write again. `force: true` overwrites, so use it only when the person asks to.",
  },
  "fix/not-found": {
    title: "Not found",
    summary: "No record has that id or path for this connection. Search by title or path, or list the type.",
    body:
      "Ids are exact; paths are case-sensitive. Find the record with `query-records {search: \"…\"}` or `{path_prefix: \"…\"}`. A key that reaches only some types doesn't see records outside them, so a record can exist and still be not found for you.",
  },
  "fix/refusals": {
    title: "When Parachute says no",
    summary: "Every refusal is an error result with error_type, a message, often a hint, and docs: the page with its fix.",
    body:
      "A refusal is an `isError` result whose `structuredContent` holds `error_type` (a stable word to branch on), `message` (words for a person), often `hint` (the next step) and `docs` (the page with the fix). Nothing of a refused write was applied. Read the hint first; it usually names the call to make instead.",
  },
  "use/connect-your-ai": { title: "Connect your AI", summary: "Give Claude, ChatGPT or any MCP app one address, your Parachute's /mcp; it can then read and write the vaults you choose." },
  "build/keys-and-scopes": { title: "Keys and what they reach", summary: "Every connection reaches one vault at one level: read, write or admin. Keys for scripts are made the same way." },
  "build/make-a-type": { title: "Make a type", summary: "A type names a kind of record and its fields. Make one before you write records of a new kind." },
  "build/write-records": { title: "Write records", summary: "Create, find and change records over MCP, without overwriting what someone else changed." },
  "build/make-an-applet": { title: "Make an applet and get it approved", summary: "An applet is one record: a manifest in its fields, TSX in its body. Write it, and the person allows it on its card." },
  "build/scripts": { title: "Scripts and the REST API", summary: "Everything the MCP tools do is also plain HTTP, for a script, a cron job or your own app." },
  "run/cloud": { title: "Parachute Cloud", summary: "We run the server; your vaults are yours to export. Sign up with an email." },
  "run/self-host": { title: "Run your own", summary: "One program, `parachute`, runs your vaults on a Mac or a Linux box. Install it, make a vault, sign in." },
};

// ---------------------------------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------------------------------

/** Throw a refusal the doors answer as one (mcp-refusal.ts), with these fields. */
function refuse(message: string, error_type: string, hint: string, field = "topic"): never {
  throw Object.assign(new Error(message), { error_type, field, hint });
}

/** Read a response body up to `max` bytes, and whether there was more. A body that stalls or breaks throws. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; more: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), more: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return { bytes: all.subarray(0, Math.min(size, max)), more: size > max };
}

/**
 * A topic as a person or a model may write it: a page name, its path, or its address (on this origin or
 * parachute.computer, whose addresses llms.txt lists), maybe for a version (`/docs/v/0.9/…`) and a section (`#…`).
 * Anything else stays as written, to be refused.
 */
function topicOf(raw: string, origin: string): { topic: string; anchor: string | null; minor: string | null } {
  let t = raw.trim();
  for (const o of new Set([origin, DOCS_ORIGIN])) {
    const host = o.replace(/^https?:\/\//i, "").toLowerCase();
    const at = t.replace(/^https?:\/\//i, "");
    if (/^https?:\/\//i.test(t) && at.toLowerCase().startsWith(`${host}/`)) {
      t = at.slice(host.length);
      break;
    }
  }
  let anchor: string | null = null;
  const hash = t.indexOf("#");
  if (hash >= 0) {
    anchor = t.slice(hash + 1).toLowerCase();
    t = t.slice(0, hash);
  }
  t = t.toLowerCase().replace(/^\/+|\/+$/g, "").replace(/^docs\//, "");
  let minor: string | null = null;
  const v = /^v\/(\d+\.\d+)\/(.*)$/.exec(t);
  if (v) {
    minor = v[1]!;
    t = v[2]!;
  }
  return { topic: t.replace(/\.md$/, "").replace(/\/+$/, ""), anchor, minor };
}

/** The slug a heading's anchor is (the site's: lower-case words joined by `-`). */
const slug = (s: string) => s.toLowerCase().replace(/[`*_[\]()]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Only the section under the heading whose slug is `anchor`, down to the next heading as high; null when none is. */
function section(markdown: string, anchor: string): string | null {
  const lines = markdown.split("\n");
  let start = -1;
  let level = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*(?:\{#([a-z0-9-]+)\})?\s*$/.exec(lines[i]!);
    if (!h) continue;
    if (start >= 0 && h[1]!.length <= level) return lines.slice(start, i).join("\n").trimEnd();
    if (start < 0 && (h[3] === anchor || slug(h[2]!) === anchor)) {
      start = i;
      level = h[1]!.length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trimEnd() : null;
}

/** One entry of the list the search ranks. */
interface IndexPage {
  topic: string;
  title: string;
  summary: string;
  headings?: string[];
}

/** llms.txt's `- [Title](…/docs/<topic>.md): summary` lines as pages. */
function pagesOfLlmsTxt(text: string): IndexPage[] {
  const out: IndexPage[] = [];
  for (const m of text.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/gm)) {
    const path = /\/docs\/(?:v\/\d+\.\d+\/)?([a-z0-9/-]+?)(?:\.md|\/)?$/.exec(m[2]!);
    if (path) out.push({ topic: path[1]!, title: m[1]!, summary: (m[3] ?? "").trim() });
  }
  return out;
}

const WORD = /[a-z0-9_]+/g;
const STOP = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "is", "it", "my", "i", "how", "do", "can", "what", "with", "this", "that", "be"]);

/** The pages that best match `query`: title and topic count most, then headings, then the one line. An `error_type`
 *  named exactly finds its fix page first. */
function rank(pages: IndexPage[], query: string, limit = 5): IndexPage[] {
  const words = [...new Set((query.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)))];
  const fix = words.map(fixFor).find(Boolean);
  const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|s)$/, "") : w);
  const hits = (text: string) => {
    const have = new Set((text.toLowerCase().match(WORD) ?? []).map(stem));
    return words.filter((w) => have.has(stem(w))).length;
  };
  return pages
    .map((p) => ({
      p,
      score:
        (p.topic === fix ? 100 : 0) +
        3 * hits(p.title) +
        2 * hits(p.topic.replace(/[/-]/g, " ")) +
        2 * hits((p.headings ?? []).join(" ")) +
        hits(p.summary),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

export function buildDocsTool(opts: DocsToolOpts = {}): McpToolDef {
  const origin = trimOrigin(opts.origin ?? DOCS_ORIGIN);
  const get = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? PAGES;
  const minor = docsMinor(opts.version);

  /** A page's text, null when the site has none there, or `unreachable` when the site can't be read now. */
  async function read(path: string): Promise<string | null | { unreachable: string }> {
    const key = `${origin}${path}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.text;
    }
    let text: string | null;
    try {
      const res = await get(key, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/markdown, text/plain, application/json" } });
      if (!res.ok) {
        res.body?.cancel().catch(() => {}); // a 404 or an error page: nothing of it is read
        if (res.status !== 404) return hit?.text != null ? hit.text : { unreachable: `it answered ${res.status}` };
        text = null; // not on the site
      } else if (/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) {
        // a host that answers a missing page with its HTML shell (a single-page fallback): not a markdown page
        res.body?.cancel().catch(() => {});
        text = null;
      } else {
        const { bytes, more } = await readCapped(res, MAX_BYTES);
        // cut on a whole character: a cut through one would end the page in a replacement mark
        text = new TextDecoder().decode(bytes, { stream: more });
        if (more) text += `\n\n[Cut at ${MAX_BYTES / 1024} KB: the whole page is at ${key}]`;
      }
    } catch (e) {
      // the site can't be read: the last copy, however old, beats none
      if (hit?.text != null) return hit.text;
      return { unreachable: (e as Error).message || "no answer" };
    }
    if (!cache.has(key) && cache.size >= MAX_PAGES) cache.delete(cache.keys().next().value!);
    cache.delete(key); // re-inserted last, so the pages read most recently are kept longest
    cache.set(key, { at: now(), text });
    return text;
  }
  const unreachable = (r: unknown): r is { unreachable: string } => !!r && typeof r === "object" && "unreachable" in r;

  /** The page for this version, else the latest; with a note when it isn't this version's. */
  async function page(topic: string, want: string | null): Promise<{ markdown: string; url: string; note?: string } | null | { unreachable: string }> {
    if (want) {
      const v = await read(`/docs/v/${want}/${topic}.md`);
      if (typeof v === "string") return { markdown: v, url: `${origin}/docs/v/${want}/${topic}/` };
      if (unreachable(v)) return v;
    }
    const latest = await read(`/docs/${topic}.md`);
    if (typeof latest !== "string") return latest;
    const note = want ? `The site has no ${want} pages; this is the latest page (you run ${opts.version ?? want}).` : undefined;
    return { markdown: latest, url: `${origin}/docs/${topic}/`, ...(note ? { note } : {}) };
  }

  const offlineNote = (url: string, why: string) => `Offline copy: ${url} couldn't be read (${why}).`;

  async function list(): Promise<IndexPage[]> {
    const json = await read("/docs/index.json");
    if (typeof json === "string") {
      try {
        const pages = (JSON.parse(json) as { pages?: unknown }).pages;
        if (Array.isArray(pages)) {
          const ok = pages.filter((p): p is IndexPage => !!p && typeof p.topic === "string" && typeof p.title === "string").map((p) => ({ ...p, summary: typeof p.summary === "string" ? p.summary : "", headings: Array.isArray(p.headings) ? p.headings.filter((h: unknown): h is string => typeof h === "string") : [] }));
          if (ok.length) return ok;
        }
      } catch {
        // not JSON: try the list for AIs
      }
    }
    const txt = await read("/llms.txt");
    if (typeof txt === "string") {
      const pages = pagesOfLlmsTxt(txt);
      if (pages.length) return pages;
    }
    return Object.entries(OFFLINE_PAGES).map(([topic, p]) => ({ topic, title: p.title, summary: p.summary }));
  }

  return {
    name: "docs",
    description: DOCS_DESCRIPTION,
    inputSchema: DOCS_INPUT_SCHEMA as unknown as Record<string, unknown>,
    requiredVerb: "read",
    // The page as it is, one text block (not JSON-escaped, which grows a page with quotes and code by a third and can
    // push it past a client's limit for one tool result), any note first, the address a person opens under it.
    resultContent: (r) => {
      const o = r as { markdown: string; page?: string; pages?: string; note?: string };
      return [{ type: "text", text: `${o.note ? `(${o.note})\n\n` : ""}${o.markdown.trimEnd()}\n\n(For a person: ${o.page ?? o.pages})` }];
    },
    execute: async (params) => {
      const rawSearch = params?.search;
      if (typeof rawSearch === "string" && rawSearch.trim()) {
        const found = rank(await list(), rawSearch.slice(0, 200));
        const markdown = found.length
          ? `${found.map((p) => `- \`${p.topic}\`: ${p.title}.${p.summary ? ` ${p.summary}` : ""}`).join("\n")}\n\nRead one with docs { topic: "<name>" }.`
          : `No page matches "${rawSearch.slice(0, 80)}". docs {} lists every page.`;
        return { search: rawSearch.slice(0, 200), markdown, pages: `${origin}/docs/` };
      }
      const raw = params?.topic;
      if (raw === undefined || raw === null || raw === "") {
        const index = await read("/llms.txt");
        // the site's list, when it names docs pages (an older site's llms.txt may name none)
        if (typeof index === "string" && pagesOfLlmsTxt(index).length > 0) return { index: `${origin}/llms.txt`, pages: `${origin}/docs/`, markdown: index };
        const offline = Object.entries(OFFLINE_PAGES).map(([t, p]) => `- \`${t}\`: ${p.title}. ${p.summary}`).join("\n");
        const why = unreachable(index) ? offlineNote(`${origin}/llms.txt`, index.unreachable) : `${origin}/llms.txt names no docs pages; these are the ones built into Parachute${opts.version ? ` ${opts.version}` : ""}.`;
        return { index: `${origin}/llms.txt`, pages: `${origin}/docs/`, markdown: offline, note: why };
      }
      const { topic, anchor, minor: asked } = topicOf(String(raw), origin);
      if (!TOPIC_RE.test(topic) || (anchor !== null && !ANCHOR_RE.test(anchor))) {
        refuse(`"${String(raw).slice(0, 80)}" isn't a page name.`, "invalid_topic", 'a name from docs {} or docs {search}, e.g. "fix/needs-admin"');
      }
      const got = await page(topic, asked ?? minor);
      if (got === null || unreachable(got)) {
        // The copy built in: when the site can't be read, and when it has no such page (yet: a site older than this
        // version, or a self-hoster's copy without the fix pages).
        const kept = OFFLINE_PAGES[topic];
        const url = docsPageUrl({ origin, version: opts.version }, topic);
        if (!kept && got === null) refuse(`No page "${topic}".`, "unknown_topic", "docs {search: \"<words>\"} finds a page; docs {} lists them");
        if (!kept) refuse(`The docs at ${url} couldn't be read (${(got as { unreachable: string }).unreachable}).`, "docs_unreachable", `open ${url} yourself, or try again`);
        const note = got === null ? `The site has no page at ${url}; this is the copy built into Parachute${opts.version ? ` ${opts.version}` : ""}.` : offlineNote(url, got.unreachable);
        return { topic, page: url, markdown: `# ${kept.title}\n\n${kept.body ?? kept.summary}`, note };
      }
      const part = anchor ? section(got.markdown, anchor) : null;
      const missed = anchor && part === null ? `No section "#${anchor}" on this page; here is all of it.` : undefined;
      const note = [got.note, missed].filter(Boolean).join(" ");
      return { topic, page: `${got.url}${part !== null ? `#${anchor}` : ""}`, markdown: part ?? got.markdown, ...(note ? { note } : {}) };
    },
  };
}

/**
 * The docs origin a box uses: PARACHUTE_DOCS_URL when set, else `docs.base_url` from its config, else
 * parachute.computer. Either takes an http(s) base URL (a path is fine: a self-hoster's copy of the site may live
 * under one), or `off` (also `false`, `0`, `none`) for no docs. A value it can't use is said once in the log, and the
 * default stands.
 */
const warned = new Set<string>();
export function docsOrigin(env: string | undefined = typeof process !== "undefined" ? process.env.PARACHUTE_DOCS_URL : undefined, config?: string | null): string | null {
  for (const [name, v] of [["PARACHUTE_DOCS_URL", env], ["docs.base_url", config ?? undefined]] as const) {
    const s = v?.trim() ?? "";
    if (!s) continue;
    if (/^(off|false|0|none)$/i.test(s)) return null;
    if (/^https?:\/\/[^/\s?#]+(\/[^\s?#]*)?$/i.test(s)) return trimOrigin(s);
    if (!warned.has(`${name}=${s}`)) {
      warned.add(`${name}=${s}`);
      console.warn(`${name}=${JSON.stringify(s)} isn't an http(s) address or "off": the docs tool reads ${DOCS_ORIGIN}`);
    }
    return DOCS_ORIGIN;
  }
  return DOCS_ORIGIN;
}

/** #133's name for {@link docsOrigin} from the environment alone. */
export const docsOriginFromEnv = (v?: string): string | null => docsOrigin(v);
