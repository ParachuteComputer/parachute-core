/**
 * `docs`: how to do things in Parachute, as markdown, from parachute.computer (T-476).
 *
 * Why: the guides used to be seeded into every new vault as notes (seed-packs.ts), and they went stale there, one copy
 * per vault, with nothing to update them. The docs now live once, on the site, written and checked against the code;
 * every page is served as HTML for people and as plain markdown for an agent (`/docs/<page>.md`, with `/llms.txt` the
 * index). This tool hands an agent the right page in the moment, so it can learn how to make a type, write records,
 * make an applet or a bundle without leaving the conversation.
 *
 *   docs {}                        the index: every page, one line each
 *   docs { topic: "applets" }      that page as markdown, with its address for a person
 *
 * Only the topic leaves the server, to the docs origin; nothing of the vault does. The origin is
 * https://parachute.computer unless the door says otherwise (a box: PARACHUTE_DOCS_URL, `docsOriginFromEnv`; `off` lists
 * no tool). Pages are kept for an hour in the process's memory, at most 64 of them, each read up to 200 KB. A page comes back as its own markdown,
 * one text block; the site keeps pages short enough for one tool result (CLAUDE.md there).
 *
 * Pure apart from `fetch` (injected for tests), so the cloud door can build the same tool.
 */
import type { McpToolDef } from "./mcp.js";

export const DOCS_ORIGIN = "https://parachute.computer";
const TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 64;
const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 8000;
/** A page name: lower-case words joined by `-`, in at most three folders (`build/make-an-applet`). */
const TOPIC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}$/;

// Short on purpose: every tool's description is read before the first call (the budget in contracts/suites/mcp/budget.test.ts).
export const DOCS_DESCRIPTION = "Parachute's how-to pages, as markdown. No `topic`: the list; `topic`: one page.";

export const DOCS_INPUT_SCHEMA = {
  type: "object",
  properties: { topic: { type: "string" } },
} as const;

export interface DocsToolOpts {
  /** The docs origin (no trailing slash needed). Default {@link DOCS_ORIGIN}. */
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where pages are kept between calls. Default: one store for the process, shared by every session and door
   *  (a door builds its tools per request, so a store per tool would never be hit). */
  cache?: Map<string, Page>;
}

export type Page = { at: number; text: string };

/** The process's pages, by origin and path. */
const PAGES = new Map<string, Page>();

/** Throw a refusal the doors turn into an MCP error with these fields. */
function refuse(message: string, error_type: string, hint: string): never {
  throw Object.assign(new Error(message), { error_type, field: "topic", hint });
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
  for (const p of parts) { all.set(p, at); at += p.length; }
  return { bytes: all.subarray(0, Math.min(size, max)), more: size > max };
}

/** A topic as a person or a model may write it: a page name, its path, or its address from the index (on this origin
 *  or parachute.computer, whose addresses llms.txt lists). Anything else stays as written, to be refused. */
function topicOf(raw: string, origin: string): string {
  let t = raw.trim();
  for (const o of new Set([origin, DOCS_ORIGIN])) {
    const host = o.replace(/^https?:\/\//, "");
    const at = t.replace(/^https?:\/\//i, "");
    if (/^https?:\/\//i.test(t) && at.toLowerCase().startsWith(`${host.toLowerCase()}/`)) { t = at.slice(host.length); break; }
  }
  return t.toLowerCase().replace(/^\/+|\/+$/g, "").replace(/^docs\//, "").replace(/\.md$/, "");
}

export function buildDocsTool(opts: DocsToolOpts = {}): McpToolDef {
  const origin = (opts.origin ?? DOCS_ORIGIN).replace(/\/+$/, "");
  const get = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? PAGES;

  async function read(path: string): Promise<string | null> {
    const key = `${origin}${path}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.text;
    }
    const url = key;
    const unreachable = (why: string): never => refuse(`The docs at ${url} couldn't be read (${why}).`, "docs_unreachable", `open ${url} yourself, or try again`);
    let text: string;
    try {
      const res = await get(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/markdown, text/plain" } });
      if (!res.ok) {
        res.body?.cancel().catch(() => {}); // a 404 or an error page: nothing of it is read
        if (res.status === 404) return null;
        unreachable(`it answered ${res.status}`);
      }
      const { bytes, more } = await readCapped(res, MAX_BYTES);
      // cut on a whole character: a cut through one would end the page in a replacement mark
      text = new TextDecoder().decode(bytes, { stream: more });
      if (more) text += `\n\n[Cut at ${MAX_BYTES / 1024} KB: the whole page is at ${url}]`;
    } catch (e) {
      if ((e as { error_type?: string }).error_type) throw e;
      unreachable((e as Error).message);
    }
    if (!cache.has(key) && cache.size >= MAX_PAGES) cache.delete(cache.keys().next().value!);
    cache.delete(key); // re-inserted last, so the pages read most recently are kept longest
    cache.set(key, { at: now(), text: text! });
    return text!;
  }

  return {
    name: "docs",
    description: DOCS_DESCRIPTION,
    inputSchema: DOCS_INPUT_SCHEMA as unknown as Record<string, unknown>,
    requiredVerb: "read",
    // The page as it is, one text block (not JSON-escaped, which grows a page with quotes and code by a third and can
    // push it past a client's limit for one tool result), with the address a person opens under it.
    resultContent: (r) => {
      const o = r as { markdown: string; page?: string; pages?: string };
      return [{ type: "text", text: `${o.markdown.trimEnd()}\n\n(For a person: ${o.page ?? o.pages})` }];
    },
    execute: async (params) => {
      const raw = params?.topic;
      if (raw === undefined || raw === null || raw === "") {
        const index = await read("/llms.txt");
        if (index === null) refuse(`No index at ${origin}/llms.txt.`, "docs_unreachable", `open ${origin}/docs/ yourself`);
        return { index: `${origin}/llms.txt`, pages: `${origin}/docs/`, markdown: index };
      }
      const topic = topicOf(String(raw), origin);
      if (!TOPIC_RE.test(topic)) refuse(`"${String(raw).slice(0, 80)}" isn't a page name.`, "invalid_topic", 'a name from docs {}, e.g. "build/make-an-applet"');
      const markdown = await read(`/docs/${topic}.md`);
      if (markdown === null) refuse(`No page "${topic}".`, "unknown_topic", "call docs {} for the list of pages");
      return { topic, page: `${origin}/docs/${topic}/`, markdown };
    },
  };
}

/** The docs origin a box uses: PARACHUTE_DOCS_URL (an http(s) origin; `off`, `false`, `0` or `none` for no docs tool),
 *  else parachute.computer. A value it can't use is said once in the log, and the default stands. */
let warned = false;
export function docsOriginFromEnv(v = process.env.PARACHUTE_DOCS_URL): string | null {
  const s = v?.trim() ?? "";
  if (!s) return DOCS_ORIGIN;
  if (/^(off|false|0|none)$/i.test(s)) return null;
  if (/^https?:\/\/[^/\s]+\/?$/i.test(s)) return s.replace(/\/+$/, "");
  if (!warned) {
    warned = true;
    console.warn(`PARACHUTE_DOCS_URL=${JSON.stringify(s)} isn't an http(s) origin or "off": the docs tool reads ${DOCS_ORIGIN}`);
  }
  return DOCS_ORIGIN;
}
