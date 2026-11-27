/**
 * A vault's approved applets as an MCP App (T-476, approved by Aaron 11-24): Parachute applets inside Claude, and any
 * host of the MCP Apps extension (SEP-1865, `io.modelcontextprotocol/ui`: ChatGPT, the ext-apps reference host).
 *
 * One tile per applet. Each applet the person approved by code hash (applet-approvals.ts) is its own tool, `open-<id>`,
 * naming its own view, `ui://parachute/applet/<id>`, with a global entry point (`_meta["openai/ui"].entrypoints`), so
 * Claude lists it on its Artifacts page, opens it full screen and lets the person pin it. An applet not approved, or
 * changed since, is not offered at all: no tool, no resource.
 *
 * The view is @openparachute/applet-host (built in the app repo, packages/applet-host; kept here as
 * applet-host/applet-host.html.gz with its version and hash), with the applet in it: its record and its code. The view
 * runs the code in the app's sealed frame and reaches the vault only through the host's `tools/call` on this door, so
 * every read and write is the caller's own key at its own level, and the frame only ever sees the record tools in its
 * manifest's folders. `PARACHUTE_APPLET_HOST_HTML` names another build of the view (a plain .html), for working on it.
 *
 * Read through this door's own `query-records` (the tool list it is given), so the applets, their code and their
 * approvals are exactly what the caller may read. Who counts as the person: the keys the hub linked to the token's
 * subject (GET /api/approval-keys on the local hub, with the caller's own bearer, as manage-token forwards it); a
 * token with no subject, or a hub that doesn't answer, approves nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { McpToolDef } from "../core/src/mcp.ts";
import { getHubOrigin, getJwksOrigin, parseHubOrigins } from "./hub-jwt.ts";
import { APPROVAL_FOLDER, APPROVAL_TAG, approvedCode, codeHash, codeKindOf, importsComponents, soundOnce, type ApprovalContent } from "./applet-approvals.ts";
import { looksLikeJwt } from "./hub-jwt.ts";
import { READ } from "../core/src/mcp-annotations.ts";

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const APPLET_URI_PREFIX = "ui://parachute/applet/";
export const OPEN_PREFIX = "open-";
/** The payload version the view reads (applet-host src/payload.ts). */
export const PAYLOAD_VERSION = 1;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE = 200;
const MAX_ROWS = 2_000;

// ---------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------

/** The kept build of @openparachute/applet-host: which version, and the hash of its HTML. */
export const VIEW_DIR = join(import.meta.dir, "applet-host");
let kept: { key: string; html: string } | null = null;
/** The view's HTML: `PARACHUTE_APPLET_HOST_HTML` when set (re-read when the file changes), else the kept build. */
export function viewHtml(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PARACHUTE_APPLET_HOST_HTML;
  try {
    if (path) {
      const st = statSync(path);
      const key = `${path}|${st.mtimeMs}|${st.size}`;
      if (kept?.key !== key) kept = { key, html: readFileSync(path, "utf8") };
      return kept.html;
    }
    if (kept?.key !== "kept") {
      const meta = JSON.parse(readFileSync(join(VIEW_DIR, "applet-host.json"), "utf8")) as { sha256: string };
      const html = gunzipSync(readFileSync(join(VIEW_DIR, "applet-host.html.gz"))).toString("utf8");
      // a kept file that isn't the build it names is never served
      if (createHash("sha256").update(html, "utf8").digest("hex") !== meta.sha256) { kept = { key: "kept", html: "" }; return null; }
      kept = { key: "kept", html };
    }
    return kept.html || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Who counts as the person
// ---------------------------------------------------------------------------------------------------------------

const keysCache = new Map<string, { at: number; keys: Set<string> }>();
const KEYS_TTL_MS = 60_000;
/** The keys the hub linked to this bearer's subject; empty when it can't say. Kept a minute per bearer. */
export async function approvalKeys(bearer: string | null, fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  // only a hub's own token goes to the hub (as manage-token forwards it): never a vault key, which names no person
  if (!bearer || !looksLikeJwt(bearer)) return new Set();
  const id = createHash("sha256").update(bearer).digest("hex");
  const hit = keysCache.get(id);
  if (hit && Date.now() - hit.at < KEYS_TTL_MS) return hit.keys;
  let keys = new Set<string>();
  try {
    const r = await fetchImpl(`${getJwksOrigin()}/api/approval-keys`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(3_000) });
    if (r.ok) {
      const j = (await r.json()) as { keys?: unknown };
      if (Array.isArray(j.keys)) keys = new Set(j.keys.filter((k): k is string => typeof k === "string" && /^[0-9a-f]{64}$/.test(k)));
    }
  } catch {
    // the hub didn't answer: nothing is approved this time (not kept, so the next call asks again)
    return keys;
  }
  if (keysCache.size > 1000) keysCache.clear();
  keysCache.set(id, { at: Date.now(), keys });
  return keys;
}

/** The origins an approval's `subject.hub` may name: this hub's, as it validates its tokens' issuers. */
export function hubOrigins(): Set<string> {
  const out = new Set<string>();
  for (const o of [getHubOrigin(), ...parseHubOrigins(process.env.PARACHUTE_HUB_ORIGINS)]) {
    try { out.add(new URL(o).origin); } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The applets
// ---------------------------------------------------------------------------------------------------------------

type Rec = { id?: string; path?: string; extension?: string; tags?: string[]; types?: string[]; fields?: Record<string, unknown>; body?: string };
export type ApprovedApplet = {
  id: string;
  name: string;
  glyph?: string;
  note?: string;
  record: { id: string; path: string; extension: string; tags: string[]; fields: Record<string, unknown> };
  code: string;
  approval: ApprovalContent;
};

const rowsOf = (got: unknown): Rec[] => (Array.isArray(got) ? got : ((got as { records?: unknown[] })?.records ?? [])) as Rec[];
async function all(query: McpToolDef, args: Record<string, unknown>): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = rowsOf(await query.execute({ ...args, limit: PAGE, offset }));
    out.push(...page);
    // only an empty page ends it: a tag-scoped key's pages can come back short and still have more after them
    if (page.length === 0) break;
  }
  return out;
}

/** The vault's applets the person approved, as this caller reads them: each by its manifest id, once. */
export async function approvedApplets(tools: readonly McpToolDef[], vaultName: string, trusted: ReadonlySet<string>, hubs: ReadonlySet<string>, now = Date.now()): Promise<ApprovedApplet[]> {
  const query = tools.find((t) => t.name === "query-records");
  if (!query || trusted.size === 0) return [];
  const [applets, approvals] = await Promise.all([
    all(query, { tag: "applet", include_body: true }),
    all(query, { path_prefix: APPROVAL_FOLDER, tag: APPROVAL_TAG }),
  ]);
  const events = approvals.map((r) => r.fields?.approval).filter((e) => e && typeof e === "object");
  const sound = soundOnce();
  const out: ApprovedApplet[] = [];
  const ids = new Set<string>();
  for (const r of applets.sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    const m = r.fields?.applet as { id?: unknown; name?: unknown; glyph?: unknown; note?: unknown } | undefined;
    const kind = codeKindOf(r.extension);
    if (!r.id || !r.path || !m || typeof m.id !== "string" || !ID.test(m.id) || m.id.length > 40 || typeof m.name !== "string" || !m.name.trim()) continue;
    if (!kind || typeof r.body !== "string" || importsComponents(r.body) || ids.has(m.id)) continue;
    const ok = approvedCode(events, { vault: vaultName, record: r.id, applet: m.id, code: codeHash(kind, r.body) }, hubs, trusted, now, sound);
    if (!ok.ok) continue;
    ids.add(m.id);
    out.push({
      id: m.id, name: m.name.trim().slice(0, 60),
      // the record's words go into Claude's tool list: short, one line
      ...(typeof m.glyph === "string" ? { glyph: m.glyph.slice(0, 4) } : {}), ...(typeof m.note === "string" ? { note: m.note.replace(/\s+/g, " ").trim().slice(0, 160) } : {}),
      // its tags as the app reads them (REST lists a record's types among its tags)
      record: { id: r.id, path: r.path, extension: r.extension ?? kind, tags: [...new Set([...(r.tags ?? []), ...(r.types ?? [])])], fields: r.fields ?? {} },
      code: r.body, approval: ok.content,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The tools and the resources
// ---------------------------------------------------------------------------------------------------------------

export const appletUri = (id: string) => `${APPLET_URI_PREFIX}${id}`;

/** What `open-<id>` answers: one line for the model; the view gets the rest as structuredContent. */
export type OpenResult = { text: string; vault: string; applet: { id: string; name: string } };

export function openTool(a: ApprovedApplet, vaultName: string): McpToolDef & { title: string; annotations: typeof READ; _meta: Record<string, unknown>; resultContent: (r: unknown) => { type: "text"; text: string }[]; resultStructured: (r: unknown) => Record<string, unknown> } {
  const uri = appletUri(a.id);
  return {
    name: `${OPEN_PREFIX}${a.id}`,
    title: a.name,
    description: `Open ${a.name}, a Parachute applet in the ${vaultName} vault, as an interactive view${a.note ? `: ${a.note}` : "."} It reads and writes the vault itself; you get one line saying it opened.`,
    inputSchema: { type: "object", properties: {} },
    requiredVerb: "read",
    // it opens a view and changes nothing itself
    annotations: READ,
    resultContent: (r: unknown) => [{ type: "text", text: (r as OpenResult).text }],
    resultStructured: (r: unknown) => { const { text: _t, ...rest } = r as OpenResult; return rest; },
    _meta: {
      ui: { resourceUri: uri },
      // the older flat key, for hosts that read only it (ext-apps' registerAppTool writes both)
      "ui/resourceUri": uri,
      "openai/ui": { entrypoints: [{ type: "global" }] },
    },
    execute: async (): Promise<OpenResult> => ({ text: `Opened ${a.name} from the ${vaultName} vault.`, vault: vaultName, applet: { id: a.id, name: a.name } }),
  } as never;
}

/** The view with this applet in it (applet-host src/payload.ts): the JSON can't close its script (`<` is `\u003c`). */
export function viewFor(html: string, a: ApprovedApplet, vaultName: string): string {
  // the approval's code and asks hashes, its subject and pick: the view checks both hashes again with the app's own code
  const ap = a.approval;
  const payload = { v: PAYLOAD_VERSION, vault: vaultName, record: a.record, code: a.code,
    approval: { code: ap.code, scope: ap.scope, subject: ap.subject, at: ap.at, ...(ap.vaults !== undefined ? { vaults: ap.vaults } : {}), ...(ap.device ? { device: ap.device } : {}) } };
  const tag = `<script type="application/json" id="parachute-applet">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
  return html.replace(/<head>/i, () => `<head>${tag}`);
}

export function resourceOf(html: string, a: ApprovedApplet, vaultName: string) {
  return {
    contents: [{
      uri: appletUri(a.id),
      mimeType: MCP_APP_MIME,
      text: viewFor(html, a, vaultName),
      // everything is inline in the view: it asks for no outside domains, so the host's default policy stands
      _meta: { ui: { prefersBorder: false } },
    }],
  };
}
