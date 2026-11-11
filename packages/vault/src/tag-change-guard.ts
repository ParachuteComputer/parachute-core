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
import { stripTagHash } from "../core/src/tag-hierarchy.ts";
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

/** Every tag above `tag` through declared parents (not `tag` itself, not the universal `_default`). */
function ancestorsOf(store: Store, tag: string): Set<string> {
  const h = store.getTagHierarchy();
  const parentsOf = new Map<string, string[]>();
  for (const [parent, children] of h.childrenOf) {
    for (const c of children) parentsOf.set(c, [...(parentsOf.get(c) ?? []), parent]);
  }
  const out = new Set<string>();
  const walk = [tag];
  while (walk.length > 0) {
    for (const p of parentsOf.get(walk.pop()!) ?? []) {
      if (p === tag || p === "_default" || out.has(p)) continue;
      out.add(p);
      walk.push(p);
    }
  }
  return out;
}

/**
 * Whether `holder` (a key's tag, a private tag, the published tag) reaches notes tagged `name`: the name itself, a
 * name under it (`secret` reaches `secret/diary`, as scopes and private_tags do), or one under it through declared
 * parents, at any depth, either way.
 */
function reaches(store: Store, holder: string, name: string): boolean {
  if (holder === name || name.startsWith(`${holder}/`)) return true;
  for (const a of ancestorsOf(store, name)) if (a === holder || a.startsWith(`${holder}/`)) return true;
  return false;
}

/** What a tag change touches: the names whose reach it changes. */
export type TagChange =
  | { kind: "rename"; from: string; to: string }
  | { kind: "merge"; sources: string[]; target: string }
  | { kind: "delete"; tag: string }
  | { kind: "reparent"; tag: string; parents: string[] | null };

/**
 * Whether a change alters what `holder` reaches. The notes of a renamed, merged or deleted name (and, for a rename,
 * of the names under it) change tags; the names they leave and the names they arrive at are both touched. A
 * re-parented tag leaves its declared parents above it and joins its new ones.
 */
function touches(store: Store, change: TagChange, holder: string): boolean {
  const under = (name: string) => holder === name || holder.startsWith(`${name}/`);
  // A rename takes its sub-tags along matched without case (notes.ts renameTag: `team` takes `TEAM/a`; review 3).
  const underAnyCase = (name: string) => under(name) || holder.toLowerCase().startsWith(`${name.toLowerCase()}/`);
  switch (change.kind) {
    case "rename":
      return underAnyCase(change.from) || under(change.to) || reaches(store, holder, change.from) || reaches(store, holder, change.to);
    case "merge":
      return [...change.sources, change.target].some((n) => holder === n || reaches(store, holder, n));
    case "delete":
      return holder === change.tag || reaches(store, holder, change.tag);
    case "reparent": {
      for (const a of ancestorsOf(store, change.tag)) if (a === holder || a.startsWith(`${holder}/`)) return true;
      return (change.parents ?? []).some((p) => reaches(store, holder, p));
    }
  }
}

/**
 * The change with every name stripped of a leading `#` or whitespace, as the store writes a new name and a merge's
 * target. (A rename's source the store reads literally; stripping it here can only refuse more.)
 */
function normalized(change: TagChange): TagChange {
  switch (change.kind) {
    case "rename":
      return { kind: "rename", from: stripTagHash(change.from), to: stripTagHash(change.to) };
    case "merge":
      return { kind: "merge", sources: change.sources.map(stripTagHash), target: stripTagHash(change.target) };
    case "delete":
      return { kind: "delete", tag: stripTagHash(change.tag) };
    case "reparent":
      return { kind: "reparent", tag: stripTagHash(change.tag), parents: change.parents?.map(stripTagHash) ?? null };
  }
}

/**
 * The refusal body for a guarded change, or null when nothing a key or setting names is touched.
 *
 * `scoped`: the caller holds a tag-scoped pass (an admin one an older hub minted, gap 4). Its refusal must not name
 * keys or tags outside its scope, nor say whether one reaches its tag, so for it every rename, merge, delete or
 * re-parent needs force and the refusal names nothing.
 */
export function tagChangeRefusal(vaultName: string, store: Store, change: TagChange, opts: { scoped?: boolean } = {}): Record<string, unknown> | null {
  if (opts.scoped) {
    return {
      error: "TagInUse",
      error_type: "tag_in_use",
      message: "A pass limited to tags must confirm a tag rename, merge, delete or re-parent: it may change what other keys or settings reach. Repeat with force: REST `?force=true`, MCP `force: true`.",
      hint: "repeat with force: true",
    };
  }
  // Review 2: the store writes `#kept` or ` kept` as `kept`, so the guard reads the change's names that way too.
  const named = normalized(change);
  const hits = (name: string) => touches(store, named, stripTagHash(name));
  const keys = liveScopedKeys(vaultName);
  const priv = readPrivateTagsConfig(vaultName);
  const published = stripTagHash(readVaultConfig(vaultName)?.published_tag ?? "publish");

  const keyNames = Array.isArray(keys) ? keys.filter((k) => k.tags.some((t) => hits(t))).map((k) => k.name) : [];
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
