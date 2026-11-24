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
import { existsSync, readFileSync } from "node:fs";
import type { McpToolDef } from "../core/src/mcp.ts";

export const APPLET_HOST_URI = "ui://parachute/applet-host";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const OPEN_APPLET = "open-applet";

/** The view's HTML, or null when this vault serves no MCP App. Read per request: a rebuilt view shows at once. */
export function appletHostHtml(path = process.env.PARACHUTE_APPLET_HOST_HTML): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export interface AppletSummary {
  id: string;
  name: string;
  path: string;
  glyph?: string;
  note?: string;
}

type Rec = { path?: string; fields?: { applet?: { id?: string; name?: string; glyph?: string; note?: string } } };

/** What `open-applet` answers: the model gets one plain line, the view gets the list (structuredContent). */
export interface OpenAppletResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: { vault: string; applets: AppletSummary[]; open: string | null };
}

/** The tool, built on this door's own `query-records`, so it sees exactly the applets the caller may read. */
export function openAppletTool(tools: McpToolDef[], vaultName: string): (McpToolDef & { title: string; _meta: Record<string, unknown>; rawResult: true }) | null {
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
    rawResult: true,
    _meta: {
      ui: { resourceUri: APPLET_HOST_URI },
      // the deprecated flat key, for hosts that read only it (ext-apps registerAppTool writes both)
      "ui/resourceUri": APPLET_HOST_URI,
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
    execute: async (params) => {
      const got = await query.execute({ tag: "applet", include_fields: true, limit: 200, offset: 0 });
      const rows = (Array.isArray(got) ? got : ((got as { records?: unknown[] })?.records ?? [])) as Rec[];
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
      const result: OpenAppletResult = { content: [{ type: "text", text }], structuredContent: { vault: vaultName, applets, open: hit?.path ?? null } };
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
