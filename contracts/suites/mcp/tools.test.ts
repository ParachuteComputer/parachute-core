// 0.9's MCP shape (T-318 design §4): eleven tools for an admin, nine for a writer, six for a reader. manage-types folds
// the five tag tools, attachment-url the two ticket tools, manage-keys renames manage-token, and query-notes
// {path_between} replaces find-path. The nine old names stay listed and working through 0.9 (Prism allow-lists some by
// name: compat/prism), each with a deprecation line and a `deprecation` field in its result.
import { describe, expect, test } from "bun:test";
import { mcp, pass, runId, safeFetch, services } from "../lib.ts";

const ELEVEN = ["query-notes", "create-note", "update-note", "delete-note", "list-tags", "vault-info", "doctor", "read-attachment", "attachment-url", "manage-types", "manage-keys"];
const WRITER = ["query-notes", "create-note", "update-note", "delete-note", "list-tags", "vault-info", "doctor", "read-attachment", "attachment-url"];
const READER = ["query-notes", "list-tags", "vault-info", "doctor", "read-attachment", "attachment-url"];
const ALIASES = ["find-path", "update-tag", "rename-tag", "merge-tags", "delete-tag", "prune-schema", "request-attachment-upload", "request-attachment-download", "manage-token"];

async function session(level: "read" | "write" | "admin") {
  const s = services();
  return mcp(`${s.vaultViaHub}/mcp`, level === "admin" ? s.operatorToken : await pass({ level }));
}

describe("mcp/tools", () => {
  test("each scope sees its new tools first, then the old names marked deprecated", async () => {
    for (const [level, want] of [["admin", ELEVEN], ["write", WRITER], ["read", READER]] as const) {
      const c = await session(level);
      const tools = (await c.client.listTools()).tools;
      const fresh = tools.filter((t) => !t.description?.startsWith("Deprecated"));
      expect(fresh.map((t) => t.name)).toEqual(want);
      const old = tools.filter((t) => t.description?.startsWith("Deprecated"));
      expect(old.every((t) => ALIASES.includes(t.name))).toBe(true);
      if (level === "admin") expect(old.map((t) => t.name).sort()).toEqual([...ALIASES].sort());
      await c.close();
    }
  });

  test("manage-types updates, renames and deletes a type; the old names still do too, saying what replaced them", async () => {
    const c = await session("admin");
    const a = runId("kind");
    const field = runId("f").replace(/-/g, "_"); // field names are vault-wide: never reuse another suite's
    await c.call("manage-types", { tag: a, fields: { [field]: { type: "string" } } });
    const renamed = await c.call("manage-types", { action: "rename", old_name: a, new_name: `${a}-x` });
    expect(renamed.deprecation).toBeUndefined();
    const tag = await c.call("list-tags", { tag: `${a}-x` });
    expect(Object.keys(tag.fields ?? {})).toEqual([field]);
    const old = await c.call("rename-tag", { old_name: `${a}-x`, new_name: `${a}-y` });
    expect(old.deprecation).toEqual({ tool: "rename-tag", use: 'manage-types {action: "rename"}', removed_in: "1.0" });
    const del = await c.call("manage-types", { action: "delete", tag: `${a}-y` });
    expect(del.deprecation).toBeUndefined();
    await expect(c.call("manage-types", { action: "explode" })).rejects.toThrow(/needs `action`: update, rename, merge, delete, prune/);
    await c.close();
  });

  test("a writer can't reach manage-types by any name", async () => {
    const c = await session("write");
    await expect(c.call("manage-types", { tag: runId("w") })).rejects.toThrow();
    await expect(c.call("update-tag", { tag: runId("w") })).rejects.toThrow();
    await c.close();
  });

  test("attachment-url uploads and downloads; a reader may download but not upload", async () => {
    const w = await session("write");
    const path = runId("att");
    await w.call("create-note", { path, content: "x" });
    const bytes = new TextEncoder().encode("made-up attachment bytes");
    const up = await w.call("attachment-url", { action: "upload", note: path, filename: "a.txt", size_bytes: bytes.length });
    expect((await safeFetch(up.url, { method: "PUT", headers: { "content-type": "text/plain" }, body: bytes })).ok).toBe(true);
    const note = await w.call("query-notes", { id: path, include_attachments: true });
    const att = (Array.isArray(note) ? note[0] : note).attachments[0];
    const r = await session("read");
    const down = await r.call("attachment-url", { action: "download", attachment_id: att.id });
    expect(await (await safeFetch(down.url)).text()).toBe("made-up attachment bytes");
    await expect(r.call("attachment-url", { action: "upload", note: path, filename: "b.txt", size_bytes: 3 })).rejects.toThrow(/vault:.*:write/);
    await w.close();
    await r.close();
  });

  test("query-notes {path_between} finds the link path find-path found", async () => {
    const c = await session("write");
    const a = runId("pa");
    const b = runId("pb");
    await c.call("create-note", { notes: [{ path: b, content: "end" }, { path: a, content: `to [[${b}]]` }] });
    const fresh = await c.call("query-notes", { path_between: { source: a, target: b } });
    const old = await c.call("find-path", { source: a, target: b });
    expect(fresh.path).toHaveLength(2);
    expect(old.path).toEqual(fresh.path);
    expect(old.deprecation.use).toContain("path_between");
    await c.close();
  });

  test("manage-keys mints and revokes, as manage-token did", async () => {
    const s = services();
    const c = await session("admin");
    const m = await c.call("manage-keys", { action: "mint", scope: `vault:${s.vaultName}:read`, ttl_seconds: 600, description: runId("key") });
    expect(m.token.split(".")).toHaveLength(3);
    const r = await c.call("manage-keys", { action: "revoke", jti: m.jti });
    expect(r.ok).toBe(true);
    const list = await c.call("manage-token", { action: "list" });
    expect(list.tokens.find((t: any) => t.jti === m.jti)?.revoked_at).toBeTruthy();
    await c.close();
  });
});
