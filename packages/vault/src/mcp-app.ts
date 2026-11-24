/**
 * T-476 spike: a vault's applets as an MCP App (the MCP Apps extension, SEP-1865, `io.modelcontextprotocol/ui`).
 *
 * One tool, `open-applet`, names one view, `ui://parachute/applet-host`. A host that speaks MCP Apps (Claude,
 * ChatGPT, the ext-apps basic-host) reads the view with `resources/read`, shows it, and hands it the tool's result:
 * the vault's applets and which to open. The view reads the applet's record and the records it shows through the
 * host's `tools/call` on this same door, so every read and write is the caller's own key at its own level; the view
 * holds nothing. The tool also carries a global entry point (`_meta["openai/ui"].entrypoints`), so Claude can list
 * it on its Artifacts page and a person can pin it.
 *
 * The view itself is built in the app repo (parachute: packages/applet-kit/mcp, `applet-host.html`) and read here
 * from PARACHUTE_APPLET_HOST_HTML. No file, no feature: the door answers as before.
 */
import { readFileSync, statSync } from "node:fs";
import type { McpToolDef } from "../core/src/mcp.ts";
import type { ResultTool } from "../core/src/mcp-result.ts";

export const APPLET_HOST_URI = "ui://parachute/applet-host";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const OPEN_APPLET = "open-applet";

let cached: { path: string; mtimeMs: number; size: number; html: string } | null = null;
/** The view's HTML, or null when this vault serves no MCP App. Kept in memory; a rebuilt file (new mtime or size) is read again. */
export function appletHostHtml(path = process.env.PARACHUTE_APPLET_HOST_HTML): string | null {
  if (!path) return null;
  let st: { mtimeMs: number; size: number };
  try { st = statSync(path); } catch { return null; }
  if (cached?.path !== path || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) cached = { path, mtimeMs: st.mtimeMs, size: st.size, html: readFileSync(path, "utf8") };
  return cached.html;
}

export interface AppletSummary {
  id: string;
  name: string;
  path: string;
  glyph?: string;
  note?: string;
}

type Rec = { path?: string; fields?: { applet?: { id?: string; name?: string; glyph?: string; note?: string } } };

/** What `open-applet` answers: the model gets one plain line (`text`), the view gets the rest (structuredContent). */
export interface OpenAppletResult {
  text: string;
  vault: string;
  applets: AppletSummary[];
  open: string | null;
}

const PAGE = 200;
const MAX_ROWS = 2_000;

/** The tool, built on this door's own `query-records`, so it sees exactly the applets the caller may read. */
export function openAppletTool(tools: McpToolDef[], vaultName: string): (McpToolDef & ResultTool & { title: string; _meta: Record<string, unknown> }) | null {
  const query = tools.find((t) => t.name === "query-records");
  if (!query) return null;
  return {
    name: OPEN_APPLET,
    title: "Parachute",
    description:
      "Open one of this vault's applets (People, Library, …) as an interactive view, or the list of them. " +
      "`applet`: its name, id or path; leave it out for the list. The view reads and writes the vault itself; " +
      "you get one line saying what opened.",
    inputSchema: { type: "object", properties: { applet: { type: "string", description: "The applet's name, id or path (optional)." } } },
    requiredVerb: "read",
    resultContent: (r) => [{ type: "text", text: (r as OpenAppletResult).text }],
    resultStructured: (r) => { const { text: _text, ...rest } = r as OpenAppletResult; return rest; },
    _meta: {
      ui: { resourceUri: APPLET_HOST_URI },
      // the deprecated flat key, for hosts that read only it (ext-apps registerAppTool writes both)
      "ui/resourceUri": APPLET_HOST_URI,
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
    execute: async (params) => {
      // applets live under Applets/ (WRITE-AN-APPLET.md), each tagged applet; page through them all
      const rows: Rec[] = [];
      for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
        const got = await query.execute({ path_prefix: "Applets/", tag: "applet", include_fields: true, limit: PAGE, offset });
        const page = (Array.isArray(got) ? got : ((got as { records?: unknown[] })?.records ?? [])) as Rec[];
        rows.push(...page);
        // only an empty page ends it: a tag-scoped key's pages can come back short and still have more after them
        if (page.length === 0) break;
      }
      const applets: AppletSummary[] = rows
        .filter((r) => r.path && r.fields?.applet?.name)
        .map((r) => ({ id: r.fields!.applet!.id ?? r.path!, name: r.fields!.applet!.name!, path: r.path!, glyph: r.fields!.applet!.glyph, note: r.fields!.applet!.note }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const want = typeof params.applet === "string" && params.applet.trim() ? params.applet.trim() : null;
      const hit = want ? applets.find((a) => [a.id, a.name, a.path].some((k) => k.toLowerCase() === want.toLowerCase())) : null;
      const text = hit
        ? `Opened ${hit.name} from the ${vaultName} vault.`
        : want
          ? `No applet called "${want}" in ${vaultName}; showing the list: ${applets.map((a) => a.name).join(", ") || "none"}.`
          : `Showing ${vaultName}'s applets: ${applets.map((a) => a.name).join(", ") || "none yet"}.`;
      const result: OpenAppletResult = { text, vault: vaultName, applets, open: hit?.path ?? null };
      return result;
    },
  };
}

/** `resources/read` for the view: the HTML and how it would like to be shown. */
export function appletHostResource(html: string) {
  return {
    contents: [
      {
        uri: APPLET_HOST_URI,
        mimeType: MCP_APP_MIME,
        text: html,
        // everything is inline in the view, so it asks for no outside domains (the default CSP stands)
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
}
