/**
 * The account door's refusals carry `docs` too (T-476): the address of the page with the fix, for this version. A copy
 * of the refusal half of the vault's `packages/vault/core/src/docs-tool.ts`, which says why; a copy, not an import, for
 * the reason `mcp-error-log.ts` gives. `__tests__/docs-links-parity.test.ts` runs both on the same refusals and fails
 * if they ever answer differently. Change both together.
 *
 * A vault's own refusal comes through this door with its `docs` already on it; this adds it to the door's own (an
 * unknown tool, a vault the key doesn't cover, a crash).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { CONFIG_DIR } from "./config.ts";

export const DOCS_ORIGIN = "https://parachute.computer";

export interface DocsContext {
  origin: string | null;
  version: string;
}

export function docsMinor(version: string | undefined): string | null {
  const m = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(version?.trim() ?? "");
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

const trimOrigin = (o: string) => o.trim().replace(/\/+$/, "");

export function docsPageUrl(ctx: { origin: string; version?: string }, topic: string): string {
  const [path, anchor] = topic.split("#");
  const minor = docsMinor(ctx.version);
  return `${trimOrigin(ctx.origin)}/docs/${minor ? `v/${minor}/` : ""}${path}/${anchor ? `#${anchor}` : ""}`;
}

export const REFUSAL_DOCS: Readonly<Record<string, string>> = {
  unknown_tool: "fix/needs-admin",
  insufficient_scope: "fix/needs-admin",
  skill_needs_admin: "fix/needs-admin",
  tag_scope_violation: "fix/needs-admin",
  tag_in_use_by_tokens: "fix/needs-admin",
  tag_not_found: "fix/unknown-type",
  unknown_tag: "fix/unknown-type",
  tag_kind: "fix/unknown-type",
  retype_conflict: "fix/unknown-type",
  inline_too_large: "fix/file-too-large",
  file_too_large: "fix/file-too-large",
  image_too_large: "fix/file-too-large",
  blocked_upload_extension: "fix/file-too-large",
  unsupported_attachment_type: "fix/file-too-large",
  attachments_not_included: "fix/file-too-large",
  storage_cap_exceeded: "fix/file-too-large",
  conflict: "fix/conflict",
  precondition_required: "fix/conflict",
  transition_conflict: "fix/conflict",
  not_found: "fix/not-found",
  ambiguous_path: "fix/not-found",
};

export const refusalTopic = (type: string): string => REFUSAL_DOCS[type] ?? "fix/refusals";

type Result = { content: { type: string; [k: string]: unknown }[]; structuredContent?: Record<string, unknown>; isError?: boolean; [k: string]: unknown };

export function withRefusalDocs<R extends Result>(result: R, ctx: DocsContext | null | undefined): R {
  const sc = result?.structuredContent;
  if (!ctx?.origin || result?.isError !== true || !sc || typeof sc.error_type !== "string" || "docs" in sc) return result;
  const refusal = { ...sc, docs: docsPageUrl({ origin: ctx.origin, version: ctx.version }, refusalTopic(sc.error_type)) };
  return { ...result, structuredContent: refusal, content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }] };
}

const warned = new Set<string>();
export function docsOrigin(env: string | undefined = process.env.PARACHUTE_DOCS_URL, config?: string | null): string | null {
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

/** `docs.base_url` from the vault's config (`<PARACHUTE_HOME>/vault/config.yaml`, the vault's own grammar). */
export function configuredDocsBase(path = join(CONFIG_DIR, "vault", "config.yaml")): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const yaml = readFileSync(path, "utf-8");
    const start = yaml.match(/^docs:\s*$/m);
    if (!start) return undefined;
    for (const line of yaml.slice((start.index ?? 0) + start[0].length).split("\n")) {
      if (line.match(/^\S/) && line.trim().length > 0) break;
      const m = line.match(/^\s+base_url:\s*"?([^"\s#]+)"?\s*(?:#.*)?$/);
      if (m) return m[1]!;
    }
  } catch {
    // unreadable: the default
  }
  return undefined;
}

/** This box's docs, as the vault door has them: PARACHUTE_DOCS_URL, else the vault config's docs.base_url. */
export function accountDocs(): DocsContext {
  return { origin: docsOrigin(process.env.PARACHUTE_DOCS_URL, configuredDocsBase()), version: pkg.version };
}
