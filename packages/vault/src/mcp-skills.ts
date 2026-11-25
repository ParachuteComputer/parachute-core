/**
 * Skills over MCP on a box (T-476; Aaron, 11-24). The vault's MCP door serves its skills through the MCP Skills
 * extension (`io.modelcontextprotocol/skills`, SEP-2640) on 2026-07-28 connections (mcp-modern.ts). A client lists
 * names and descriptions; the model loads a skill's `SKILL.md` only when it needs it, and a supporting file only when
 * the skill points at it. Three sources, one list:
 *
 *   - `vault-guide` (generated): how to work with THIS vault, from the same scoped projection the instructions use.
 *   - `live-page` (written in core): how to build a live Claude artifact on this connector.
 *   - the vault's own: records of type `skill` (core skill-files.ts maps them; core skills.ts holds the write rule).
 *
 * Every read goes through this key's own `query-records`, so a key lists only the skill records it could read anyway
 * (scoped tags and private tags included). Nothing is cached between requests: the door builds a server per request,
 * and this source reads the vault on its first skills call.
 */

import { skillEntry, type Skill, type SkillReadResult, type SkillSource } from "@modelcontextprotocol/server/ext/skills";
import type { McpToolDef } from "../core/src/mcp.ts";
import type { VaultProjection } from "../core/src/vault-projection.ts";
import { SKILL_TYPE } from "../core/src/skills.ts";
import { LIVE_PAGE_SKILL, MAX_FILES_PER_SKILL, MAX_VAULT_SKILLS, vaultGuideFiles, vaultSkills, type SkillRecordLike } from "../core/src/skill-files.ts";

/** URI authority for skills this server writes, and for skills the vault's records hold. */
const SERVER_PREFIX = "parachute";
const VAULT_PREFIX = "vault";
/** Skill records read per request: every skill and its files, at the limits a client reads. */
const MAX_SKILL_RECORDS = MAX_VAULT_SKILLS * (1 + MAX_FILES_PER_SKILL);

interface BuiltSkill {
  entry: Skill;
  files: Map<string, string>; // uri → text
}

const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv", html: "text/html",
  yaml: "application/yaml", yml: "application/yaml", py: "text/x-python", js: "text/javascript", ts: "text/typescript",
};
function mimeTypeOf(uri: string): string {
  return MIME[uri.slice(uri.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";
}

export interface VaultSkillsInput {
  vaultName: string;
  /** This key's projection (mcp-tools.ts `scopedProjection`). */
  projection: () => Promise<VaultProjection>;
  /** This key's `query-records`, or undefined when the key can't see it. */
  queryRecords: McpToolDef | undefined;
  /** Where problems go (a skipped record, a bad name). Default: console.warn. */
  onWarning?: (message: string) => void;
}

/** A `SkillSource` over one vault for one request. Built lazily on the first skills call, then reused. */
export function vaultSkillSource(input: VaultSkillsInput): SkillSource {
  let built: Promise<BuiltSkill[]> | null = null;
  const all = () => (built ??= buildSkills(input));
  const files = async () => {
    const map = new Map<string, string>();
    for (const s of await all()) for (const [uri, text] of s.files) map.set(uri, text);
    return map;
  };
  return {
    async list() {
      return { skills: (await all()).map((s) => s.entry) };
    },
    async get(uri) {
      return (await all()).find((s) => s.entry.uri === uri)?.entry;
    },
    async read(uri): Promise<SkillReadResult | undefined> {
      const text = (await files()).get(uri);
      return text === undefined ? undefined : { text, mimeType: mimeTypeOf(uri) };
    },
    // Each SKILL.md also appears in resources/list, so a client without the extension can still find and read them.
    async listResources() {
      return (await all()).map((s) => ({
        uri: s.entry.uri,
        name: s.entry.frontmatter.name,
        description: s.entry.frontmatter.description,
        mimeType: "text/markdown",
      }));
    },
  };
}

async function buildSkills(input: VaultSkillsInput): Promise<BuiltSkill[]> {
  const warn = input.onWarning ?? ((m: string) => console.warn(`[mcp-skills] ${m}`));
  const out: BuiltSkill[] = [];
  const taken = new Set<string>();
  const add = async (prefix: string, name: string, files: Record<string, string>) => {
    try {
      const entry = await skillEntry(`${prefix}/${name}`, files);
      const byUri = new Map<string, string>();
      for (const [rel, text] of Object.entries(files)) byUri.set(`skill://${prefix}/${name}/${rel}`, text);
      out.push({ entry, files: byUri });
      taken.add(name);
    } catch (err) {
      warn(`skipped skill ${prefix}/${name}: ${(err as Error).message}`);
    }
  };

  await add(SERVER_PREFIX, "vault-guide", vaultGuideFiles(input.vaultName, await input.projection()));
  await add(SERVER_PREFIX, "live-page", { "SKILL.md": LIVE_PAGE_SKILL });

  for (const skill of vaultSkills(await readSkillRecords(input.queryRecords, warn), warn)) {
    if (taken.has(skill.name)) {
      warn(`skipped skill record ${skill.path}: "${skill.name}" is already served`);
      continue;
    }
    await add(VAULT_PREFIX, skill.name, skill.files);
  }
  return out;
}

/** This key's skill records (and records of `skill` subtypes, which vaultSkills leaves out), up to the limit. */
async function readSkillRecords(tool: McpToolDef | undefined, warn: (m: string) => void): Promise<SkillRecordLike[]> {
  if (!tool) return [];
  const raw = (await tool.execute({ type: SKILL_TYPE, include_body: true, include_fields: true, limit: MAX_SKILL_RECORDS + 1 })) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { records?: unknown[] })?.records ?? []) as SkillRecordLike[];
  const more = !Array.isArray(raw) && Boolean((raw as { next_cursor?: unknown })?.next_cursor);
  if (more || list.length > MAX_SKILL_RECORDS) warn(`skill records: more than ${MAX_SKILL_RECORDS}; serving the first ${MAX_SKILL_RECORDS}`);
  return list.slice(0, MAX_SKILL_RECORDS);
}
