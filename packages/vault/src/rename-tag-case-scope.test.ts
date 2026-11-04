/**
 * The access consequence of rename-tag carrying sub-tags by an ASCII-case-
 * insensitive prefix. A token scoped to `Work` sees `Work` and its sub-tags,
 * not `work/sub` (tag names are case-sensitive). Renaming `Work` to `Job`
 * rewrites the token's stored scope to `Job` — correct — but also moved
 * `work/sub` to `Job/sub`, so the same token could then read a note it was
 * never shared.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { handleNotes, type TagScopeCtx } from "./routes.ts";
import { expandTokenTagScope } from "./tag-scope.ts";
import { parseScopedTags } from "./token-store.ts";
import type { Store } from "../core/src/types.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `rename-case-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault", "data"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  clearVaultStoreCache();
});

afterEach(() => {
  clearVaultStoreCache();
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

const HASH = "sha256:rename-case-scope";

async function pathsSeenByToken(store: Store): Promise<string[]> {
  const row = (store as any).db.prepare("SELECT scoped_tags FROM tokens WHERE token_hash = ?").get(HASH) as { scoped_tags: string };
  const raw = parseScopedTags(row.scoped_tags);
  const scope: TagScopeCtx = { allowed: await expandTokenTagScope(store, raw), raw };
  const res = await handleNotes(new Request("http://localhost/vault/v/api/notes", { method: "GET" }), store, "", "v", scope);
  const body = (await res.json()) as any;
  return (Array.isArray(body) ? body : body.notes).map((n: any) => n.path).sort();
}

describe("rename-tag does not widen a tag-scoped token", () => {
  test("a token scoped to `Work` still cannot read `work/sub` after `Work` is renamed", async () => {
    writeVaultConfig({ name: "v", api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore("v");
    await store.createNote("shared", { path: "Shared", tags: ["Work"] });
    await store.createNote("private", { path: "Private", tags: ["work/sub"] });
    (store as any).db
      .prepare("INSERT INTO tokens (token_hash, label, permission, scoped_tags, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(HASH, "shared-with-a-colleague", "read", JSON.stringify(["Work"]), new Date().toISOString());

    expect(await pathsSeenByToken(store)).toEqual(["Shared"]);

    await store.renameTag("Work", "Job");

    expect(await pathsSeenByToken(store)).toEqual(["Shared"]);
  });
});
