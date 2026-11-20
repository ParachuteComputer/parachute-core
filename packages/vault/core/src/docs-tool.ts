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
 * https://parachute.computer unless the door says otherwise (a box: PARACHUTE_DOCS_URL; `off` lists no tool).
 * Pages are kept for an hour in memory, at most 64 of them, each cut at 200 KB. A page comes back as its own markdown,
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

export const DOCS_DESCRIPTION =
  "How to do things in Parachute (types, records, applets, bundles, keys), as markdown from parachute.computer. No `topic`: the list of pages. `topic`: that page. Read the page before building something new.";

export const DOCS_INPUT_SCHEMA = {
  type: "object",
  properties: { topic: { type: "string", description: 'A page from the list, e.g. "build/make-an-applet"' } },
} as const;

export interface DocsToolOpts {
  /** The docs origin (no trailing slash needed). Default {@link DOCS_ORIGIN}. */
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Page = { at: number; text: string };

/** Throw a refusal the doors turn into an MCP error with these fields. */
function refuse(message: string, error_type: string, hint: string): never {
  throw Object.assign(new Error(message), { error_type, field: "topic", hint });
}

export function buildDocsTool(opts: DocsToolOpts = {}): McpToolDef {
  const origin = (opts.origin ?? DOCS_ORIGIN).replace(/\/+$/, "");
  const get = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Page>();

  async function read(path: string): Promise<string | null> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < TTL_MS) return hit.text;
    const url = `${origin}${path}`;
    let res: Response;
    try {
      res = await get(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/markdown, text/plain" } });
    } catch (e) {
      refuse(`The docs at ${url} couldn't be reached (${(e as Error).message}).`, "docs_unreachable", `open ${url} yourself, or try again`);
    }
    if (res.status === 404) return null;
    if (!res.ok) refuse(`The docs at ${url} answered ${res.status}.`, "docs_unreachable", `open ${url} yourself, or try again`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let text = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES));
    if (bytes.length > MAX_BYTES) text += `\n\n[Cut at ${MAX_BYTES / 1024} KB: the whole page is at ${url}]`;
    if (cache.size >= MAX_PAGES) cache.delete(cache.keys().next().value!);
    cache.set(path, { at: now(), text });
    return text;
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
      const topic = String(raw).trim().toLowerCase().replace(/^\/+|\/+$/g, "").replace(/^docs\//, "").replace(/\.md$/, "");
      if (!TOPIC_RE.test(topic)) refuse(`"${String(raw).slice(0, 80)}" isn't a page name.`, "invalid_topic", "call docs {} for the list of pages");
      const markdown = await read(`/docs/${topic}.md`);
      if (markdown === null) refuse(`No page "${topic}".`, "unknown_topic", "call docs {} for the list of pages");
      return { topic, page: `${origin}/docs/${topic}/`, markdown };
    },
  };
}
