/**
 * Scope gap 6 (0.9.1, SPEC §3.3): renaming, merging, deleting or re-parenting a
 * tag changes who sees what. A key limited to tags (`permissions.scoped_tags`)
 * reaches a tag and, through `parent_names`, everything under it; the vault's
 * `private_tags` hide a tag and everything under it; the published tag makes
 * notes public on /view. Change one of those names, or a parent above one, and
 * a key loses or gains notes, or private notes stop being private, with no one
 * told. So such a change is refused unless the caller passes `force`, and the
 * refusal names the keys it affects (by name, never a token or its id) and the
 * vault settings it touches.
 *
 * The keys live in the hub's database (`hub.db`, `keys` joined to `tokens`),
 * beside this vault in the same home; the vault reads them read-only. No
 * hub.db (a vault run on its own, or a test) means no keys. A hub.db that
 * exists but can't be read fails closed: the change is refused, saying so.
 * Shared by the REST tag routes and the MCP tag tools.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/src/types.ts";
import { getTagDescendants, stripTagHash } from "../core/src/tag-hierarchy.ts";
import { CONFIG_DIR, readPrivateTagsConfig, readVaultConfig } from "./config.ts";

/** A live key for this vault and the tags it is limited to. */
interface ScopedKey {
  name: string;
  tags: string[];
}

/** The live keys for `vaultName` that carry a tag limit, or why they can't be read. */
export function liveScopedKeys(vaultName: string, now: Date = new Date()): ScopedKey[] | { unreadable: string } {
  const path = join(CONFIG_DIR, "hub.db");
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query(
        `SELECT k.name AS name, t.scopes AS scopes, t.permissions AS permissions
         FROM keys k JOIN tokens t ON t.jti = k.jti
         WHERE t.revoked_at IS NULL AND t.rotated_to IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)
           AND t.permissions LIKE '%scoped_tags%'`,
      )
      .all(now.toISOString()) as { name: string; scopes: string | null; permissions: string | null }[];
    const out: ScopedKey[] = [];
    for (const r of rows) {
      const scopes = (r.scopes ?? "").split(/\s+/);
      const forVault = scopes.some((s) => /^vault:(read|write|admin)$/.test(s) || s.startsWith(`vault:${vaultName}:`));
      if (!forVault) continue;
      let tags: unknown;
      try {
        tags = (JSON.parse(r.permissions ?? "{}") as { scoped_tags?: unknown }).scoped_tags;
      } catch {
        tags = undefined;
      }
      if (Array.isArray(tags) && tags.length > 0) out.push({ name: r.name, tags: tags.filter((t): t is string => typeof t === "string") });
    }
    return out;
  } catch (err) {
    return { unreadable: (err as Error)?.message ?? String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/** Every tag above `tag` in the hierarchy (not `tag` itself, not the universal `_default`). */
function ancestorsOf(store: Store, tag: string): Set<string> {
  const h = store.getTagHierarchy();
  const out = new Set<string>();
  for (const candidate of h.allTags) {
    if (candidate === tag || candidate === "_default") continue;
    if (getTagDescendants(h, candidate).has(tag)) out.add(candidate);
  }
  return out;
}

/** What a tag change touches: the names whose reach it changes. */
export type TagChange =
  | { kind: "rename"; from: string; to: string }
  | { kind: "merge"; sources: string[]; target: string }
  | { kind: "delete"; tag: string }
  | { kind: "reparent"; tag: string; parents: string[] | null };

/** The names a change alters the reach of. Sub-tags follow a rename, so a name under the old one counts too. */
function touchedNames(store: Store, change: TagChange): { exact: Set<string>; under: string[] } {
  switch (change.kind) {
    case "rename":
      return { exact: new Set([change.from, change.to]), under: [change.from] };
    case "merge":
      return { exact: new Set([...change.sources, change.target]), under: [] };
    case "delete":
      return { exact: new Set([change.tag]), under: [] };
    case "reparent": {
      // Every tag above it now, and every tag it is put under (with theirs): their reach gains or loses its notes.
      const names = ancestorsOf(store, change.tag);
      for (const p of change.parents ?? []) {
        names.add(p);
        for (const a of ancestorsOf(store, p)) names.add(a);
      }
      return { exact: names, under: [] };
    }
  }
}

/** The refusal body for a guarded change, or null when nothing a key or setting names is touched. */
export function tagChangeRefusal(vaultName: string, store: Store, change: TagChange): Record<string, unknown> | null {
  const { exact, under } = touchedNames(store, change);
  const hits = (name: string) => exact.has(name) || under.some((u) => name.startsWith(`${u}/`));
  const keys = liveScopedKeys(vaultName);
  const priv = readPrivateTagsConfig(vaultName);
  const published = stripTagHash(readVaultConfig(vaultName)?.published_tag ?? "publish");

  const keyNames = Array.isArray(keys) ? keys.filter((k) => k.tags.some((t) => hits(stripTagHash(t)))).map((k) => k.name) : [];
  const privateTags = priv.kind === "ok" ? priv.tags.filter((t) => hits(t)) : [];
  const publishedHit = hits(published);
  const unreadable = !Array.isArray(keys) || priv.kind === "invalid";
  if (keyNames.length === 0 && privateTags.length === 0 && !publishedHit && !unreadable) return null;

  const what: string[] = [];
  if (keyNames.length > 0) what.push(`what ${keyNames.length} key${keyNames.length === 1 ? "" : "s"} can see (${keyNames.join(", ")})`);
  if (privateTags.length > 0) what.push(`which notes are private (private_tags: ${privateTags.join(", ")})`);
  if (publishedHit) what.push(`which notes are public (the published tag, ${published})`);
  if (!Array.isArray(keys)) what.push("possibly what keys can see (the keys could not be read)");
  if (priv.kind === "invalid") what.push("possibly which notes are private (vault.yaml's private_tags could not be read)");
  return {
    error: "TagInUse",
    error_type: "tag_in_use",
    message: `This change would change ${what.join(" and ")}. Check them (\`parachute keys list\`, vault.yaml), then repeat with force: REST \`?force=true\`, MCP \`force: true\`.`,
    keys: keyNames,
    ...(privateTags.length > 0 ? { private_tags: privateTags } : {}),
    ...(publishedHit ? { published_tag: published } : {}),
    hint: "repeat with force: true once the keys and settings named here are what you want",
  };
}

/** True for a `force` flag given as a boolean or a query-string value. */
export function forceFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/** Whether `parents` differs from the parents `tag` has now. */
export function parentsChange(store: Store, tag: string, parents: string[] | null): boolean {
  const h = store.getTagHierarchy();
  const now = new Set<string>();
  for (const [parent, children] of h.childrenOf) if (children.has(tag)) now.add(parent);
  const next = new Set(parents ?? []);
  return now.size !== next.size || [...next].some((p) => !now.has(p));
}
