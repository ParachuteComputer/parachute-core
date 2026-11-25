/**
 * The account door's refusals carry `docs` too (T-476): the address of the page with the fix, for this version. A copy
 * of the refusal half of the vault's `packages/vault/core/src/docs-tool.ts`, which says why; a copy, not an import, for
 * the reason `mcp-error-log.ts` gives. `__tests__/docs-links-parity.test.ts` runs both on the same refusals and fails
 * if they ever answer differently. Change both together.
 *
 * A vault's own refusal comes through this door with its `docs` already on it; this adds it to the door's own (an
 * unknown tool, a vault the key doesn't cover, a crash).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
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
  insufficient_scope: "fix/needs-admin#what-the-refusal-says",
  unknown_tool: "fix/needs-admin#a-tool-it-cant-see",
  skill_needs_admin: "fix/needs-admin#skills",
  tag_scope_violation: "fix/needs-admin#a-key-limited-to-some-tags",
  tag_in_use_by_tokens: "fix/needs-admin#a-key-limited-to-some-tags",
  inline_too_large: "fix/file-too-large#in-a-chat-with-claude",
  file_too_large: "fix/file-too-large#the-limits",
  image_too_large: "fix/file-too-large#the-limits",
  blocked_upload_extension: "fix/file-too-large#the-limits",
  unsupported_attachment_type: "fix/file-too-large#claude-cant-read-the-file",
  storage_cap_exceeded: "fix/file-too-large#on-parachute-cloud",
  attachments_not_included: "fix/file-too-large#on-parachute-cloud",
  tag_not_found: "fix/unknown-type#no-type-by-that-name",
  unknown_tag: "fix/unknown-type#no-type-by-that-name",
  tag_kind: "fix/unknown-type#a-tag-not-a-type",
  schema_validation: "fix/unknown-type#a-field-doesnt-fit",
  retype_conflict: "fix/unknown-type#a-field-doesnt-fit",
  field_not_indexed: "fix/unknown-type#a-field-cant-be-counted",
  conflict: "fix/conflict#conflict",
  precondition_required: "fix/conflict#precondition_required",
  transition_conflict: "fix/conflict#transition_conflict",
  not_found: "fix/not-found#not_found",
  ambiguous_path: "fix/not-found#ambiguous_path",
  unknown_parameter: "fix/refusals#a-call-thats-not-right",
  missing_required_field: "fix/refusals#a-call-thats-not-right",
  invalid_query: "fix/refusals#a-call-thats-not-right",
  invalid_request: "fix/refusals#a-call-thats-not-right",
  mutually_exclusive: "fix/refusals#a-call-thats-not-right",
  invalid_search_syntax: "fix/refusals#a-call-thats-not-right",
  cursor_invalid: "fix/refusals#a-call-thats-not-right",
  batch_too_large: "fix/refusals#a-call-thats-not-right",
  path_conflict: "fix/refusals#a-name-thats-taken",
  target_exists: "fix/refusals#a-name-thats-taken",
  size_mismatch: "fix/refusals#a-file-that-didnt-arrive-whole",
  digest_mismatch: "fix/refusals#a-file-that-didnt-arrive-whole",
  semantic_unavailable: "fix/refusals#search-by-meaning-is-off",
  plan_required: "fix/refusals#parachute-cloud-limits",
  internal_error: "fix/refusals#something-broke",
};

export const refusalTopic = (type: string): string => (Object.hasOwn(REFUSAL_DOCS, type) ? REFUSAL_DOCS[type]! : "fix/refusals");

/** The person's step for a refusal only they can fix, when the refusal names none (T-476 eval). Checked against the
 *  approval page (one tick per level, packages/hub/src/oauth-ui.ts) and `parachute keys new … --can`. */
export const PERSON_STEPS: Readonly<Record<string, string>> = {
  insufficient_scope: "The person grants it: they connect this AI again and leave the level it needs ticked on Parachute's approval page (for a script, a key made with that level).",
};

type Result = { content: { type: string; [k: string]: unknown }[]; structuredContent?: Record<string, unknown>; isError?: boolean; [k: string]: unknown };

export function withRefusalDocs<R extends Result>(result: R, ctx: DocsContext | null | undefined): R {
  const sc = result?.structuredContent;
  if (!ctx?.origin || result?.isError !== true || !sc || typeof sc.error_type !== "string" || "docs" in sc) return result;
  // A level refusal with no next step of its own says the person's (the eval found AIs relay the words and the link,
  // and never read the page: "grant this connection admin scope" left the person with nothing to do).
  const step = sc.hint === undefined && Object.hasOwn(PERSON_STEPS, sc.error_type) ? { hint: PERSON_STEPS[sc.error_type] } : {};
  const refusal = { ...sc, ...step, docs: docsPageUrl({ origin: ctx.origin, version: ctx.version }, refusalTopic(sc.error_type)) };
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
  // The file is parsed again only when it or PARACHUTE_DOCS_URL changed (as the vault's boxDocs).
  const env = process.env.PARACHUTE_DOCS_URL;
  const path = join(CONFIG_DIR, "vault", "config.yaml");
  let stamp = "none";
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}|${st.size}`;
  } catch {
    // no config file: the default
  }
  const key = `${env ?? ""}|${stamp}`;
  if (kept?.key !== key) kept = { key, value: { origin: docsOrigin(env, configuredDocsBase(path)), version: pkg.version } };
  return kept.value;
}
let kept: { key: string; value: DocsContext } | null = null;
