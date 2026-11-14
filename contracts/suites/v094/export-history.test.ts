// v094/export-history: export with history, as an option (T-471, PLAN-0.9.4 PR 4). `parachute-vault export <dir>
// --with-history` and `GET /api/export?history=1` add `.parachute/history/<record id>.jsonl`, one line per version,
// oldest first: who, via, why, write set, op, time, path, fields, types, tags, links and the body. Import reads them
// back behind the current records. Off by default: an export without it is byte-equal to today's. Black box: HTTP to
// the candidate's hub, the CLI it ships, and the restored vault's file read as the round-trip suite reads it.
// Made-up data.
// Red on #114 (6a527178): the export has no `.parachute/history` (the option is unknown), so nothing comes back.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli, freePort, newHome } from "../candidate-lib.ts";
import { untar, type TarFile } from "../door/_tar.ts";
import { mcp, must, pass, safeFetch } from "../lib.ts";
import { accountToken, adminPass, call, enc, mcpUrl, mintKey, s, shortId, type Key } from "./_keys.ts";

const R = `eh${shortId()}`;
const SCRATCH = join(s.home, "..", `export-history-${R}`);
const EXPORTED_AT = "2027-03-04T05:06:07.000Z";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let writer: Key;
let other: Key;
let admin: Key;
/** The made-up records: `story` (created with a type, edited by two keys with reasons, tagged, linked, renamed),
 *  `gone` (edited, then deleted: its history stays), `erased` (edited, then its history erased: never exported). */
const ids: { story: string; gone: string; erased: string; target: string } = { story: "", gone: "", erased: "", target: "" };

const run = async (home: string, args: string[]) => {
  const r = await cli(home, args, { vault: true });
  must(r.code === 0, `parachute-vault ${args.join(" ")} exited ${r.code}: ${r.stderr.slice(0, 600)} … ${r.stderr.slice(-300)}`);
  return r;
};

async function restoreTarget(label: string): Promise<{ home: string; vault: string }> {
  const home = newHome(label);
  mkdirSync(join(home, "vault"), { recursive: true });
  writeFileSync(join(home, "vault", "config.yaml"), `port: ${await freePort()}\n`);
  await run(home, ["create", "restored", "--no-mirror", "--json"]);
  return { home, vault: "restored" };
}
const dbFile = (home: string, vault: string) => join(home, "vault", "data", vault, "vault.db");

const patch = async (k: Key, id: string, body: Record<string, unknown>, why?: string) => {
  const r = await k.api("PATCH", `/notes/${enc(id)}`, { ...body, force: true }, why ? { "Parachute-Why": enc(why) } : {});
  must(r.status === 200, `PATCH ${id}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
};

/** What a version is, in the words both ends share. */
const FIELDS = ["version_ix", "op", "superseded_at", "created_at", "actor", "via", "via_kind", "write_set", "why", "path", "extension", "metadata", "types", "tags", "links", "content_hash"] as const;
const pick = (v: Record<string, unknown>) => Object.fromEntries(FIELDS.map((f) => [f, v[f] ?? null]));

/** The source's versions of a record, oldest first, each with its body, read over HTTP as an admin. */
async function sourceVersions(id: string): Promise<Array<Record<string, unknown>>> {
  const r = await admin.api("GET", `/notes/${enc(id)}/versions?limit=200`);
  must(r.status === 200, `versions of ${id}: ${r.status} ${r.text.slice(0, 200)}`);
  const out = [];
  for (const v of [...(r.body.versions as any[])].reverse()) {
    const one = await admin.api("GET", `/notes/${enc(id)}/versions/${v.version_ix}`);
    must(one.status === 200, `version ${v.version_ix} of ${id}: ${one.status}`);
    out.push({ ...pick(v), content: one.body.content ?? null });
  }
  return out;
}

/** The restored vault's versions of a record, oldest first, read from its file (a fresh import stores bodies whole). */
function restoredVersions(home: string, vault: string, id: string): Array<Record<string, unknown>> {
  const db = new Database(dbFile(home, vault), { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT v.*, b.content AS body, b.encoding AS blob_encoding FROM note_versions v
         LEFT JOIN note_blobs b ON b.hash = v.content_hash
         WHERE v.note_id = ? ORDER BY v.version_ix`,
      )
      .all(id) as any[];
    return rows.map((r) => {
      must(r.blob_encoding === null, `restored body of ${id} v${r.version_ix} is stored ${r.blob_encoding}; this suite reads whole bodies`);
      const json = (t: string | null) => (t === null ? null : JSON.parse(t));
      return {
        ...pick({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : {}, types: json(r.types), tags: json(r.tags), links: json(r.links) }),
        content: r.body === null ? null : typeof r.body === "string" ? r.body : new TextDecoder().decode(r.body),
      };
    });
  } finally {
    db.close();
  }
}
const versionCount = (home: string, vault: string) => {
  const db = new Database(dbFile(home, vault), { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM note_versions").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

async function pull(token: string, query: string): Promise<{ status: number; files: TarFile[]; text: string }> {
  const r = await safeFetch(`${s.hub}/vault/${s.vaultName}/api/export${query}`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 200) return { status: r.status, files: [], text: await r.text() };
  return { status: 200, files: untar(new Uint8Array(await r.arrayBuffer())), text: "" };
}
const historyFiles = (files: TarFile[]) => files.filter((f) => f.name.startsWith(".parachute/history/"));
const writeTree = (files: TarFile[], dir: string) => {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.name)), { recursive: true });
    writeFileSync(join(dir, f.name), f.bytes);
  }
};

beforeAll(async () => {
  writer = await mintKey("eh-claude", "write");
  other = await mintKey("eh-other", "write");
  admin = await adminPass();
  mkdirSync(SCRATCH, { recursive: true });

  const target = await writer.api("POST", "/notes", { path: `${R}/target`, content: "a target" });
  must(target.status === 201, `target: ${target.status}`);
  ids.target = target.body.id;

  const m = await mcp(mcpUrl(), writer.token);
  try {
    const made: any = await m.call("create-record", { path: `${R}/story`, content: "first draft", types: [`${R}memo`], tags: [`${R}draft`], why: "Sam asked to keep the notes" });
    ids.story = made.id;
  } finally {
    await m.close();
  }
  // Two keys take turns, so no edit folds into the one before it (a burst is one key's).
  await patch(other, ids.story, { content: "second draft", metadata: { status: "review" } }, "tightening the summary");
  await patch(writer, ids.story, { content: "third draft", tags: { add: [`${R}reviewed`] }, links: { add: [{ target: ids.target, relationship: "cites" }] } }, "the review is in");
  await patch(other, ids.story, { content: "fourth draft — Grüße 🪂\n" });
  await patch(writer, ids.story, { path: `${R}/story-renamed` }, "a clearer name");

  const gone = await writer.api("POST", "/notes", { path: `${R}/gone`, content: "short lived", tags: [`${R}draft`] });
  ids.gone = gone.body.id;
  await patch(other, ids.gone, { content: "edited once" }, "one more pass");
  const del = await writer.api("DELETE", `/notes/${enc(ids.gone)}`, undefined, { "Parachute-Why": "not needed" });
  must(del.status === 200 || del.status === 204, `delete: ${del.status} ${del.text.slice(0, 200)}`);

  const erased = await writer.api("POST", "/notes", { path: `${R}/erased`, content: "a secret first line" });
  ids.erased = erased.body.id;
  await patch(other, ids.erased, { content: "nothing to see" });
  const erase = await admin.api("DELETE", `/notes/${enc(ids.erased)}/versions`);
  must(erase.status === 200, `erase: ${erase.status} ${erase.text.slice(0, 200)}`);
});

describe("v094/export-history: a vault's past travels with it, when asked", () => {
  test("export with history, then import into a new vault: every version comes back with its body, stamps, why and set", async () => {
    const dir = join(SCRATCH, "cli");
    await run(s.home, ["export", dir, "--vault", s.vaultName, "--with-history"]);
    const target = await restoreTarget("eh-copy");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    for (const id of [ids.story, ids.gone]) {
      const before = await sourceVersions(id);
      const after = restoredVersions(target.home, target.vault, id);
      expect(after).toEqual(before);
    }
    const story = await sourceVersions(ids.story);
    // The fixture is what it says: four versions behind the record, by two keys, with reasons, sets, types, tags, links.
    expect(story.length).toBe(4);
    expect(story[0]).toMatchObject({ via: `key:${other.name}`, why: "tightening the summary", content: "first draft", types: [`${R}memo`], tags: [`${R}draft`] });
    expect(story[1]).toMatchObject({ via: `key:${writer.name}`, why: "the review is in", content: "second draft", links: [] });
    expect((story[2]!.links as any[]).map((l) => l.target)).toEqual([ids.target]);
    expect(story[2]!.tags).toContain(`${R}reviewed`);
    expect(story[3]).toMatchObject({ via: `key:${writer.name}`, why: "a clearer name", content: "fourth draft — Grüße 🪂\n", path: `${R}/story` });
    expect(story.every((v) => typeof v.write_set === "string")).toBe(true);
    const gone = await sourceVersions(ids.gone);
    expect(gone.map((v) => [v.op, v.content, v.why])).toEqual([["update", "short lived", "one more pass"], ["delete", "edited once", "not needed"]]);
    // Erased history is not exported.
    expect(existsSync(join(dir, ".parachute", "history", `${ids.erased}.jsonl`))).toBe(false);
    expect(restoredVersions(target.home, target.vault, ids.erased)).toEqual([]);
  });

  test("the history file: one JSON line per version, oldest first, with the body", async () => {
    const dir = join(SCRATCH, "cli");
    const lines = readFileSync(join(dir, ".parachute", "history", `${ids.story}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.version_ix)).toEqual([0, 1, 2, 3]);
    expect(lines[0]).toMatchObject({ op: "update", content: "first draft", via: `key:${other.name}`, why: "tightening the summary" });
    expect(lines[3].content).toBe("fourth draft — Grüße 🪂\n");
    expect(lines[3].content_hash).toBe(sha(lines[3].content));
  });

  test("off by default: an export without the option is byte-equal to one with history=0, and has no history", async () => {
    const tok = admin.token;
    const plain = await pull(tok, `?exported_at=${EXPORTED_AT}`);
    const off = await pull(tok, `?exported_at=${EXPORTED_AT}&history=0`);
    const on = await pull(tok, `?exported_at=${EXPORTED_AT}&history=1`);
    expect([plain.status, off.status, on.status]).toEqual([200, 200, 200]);
    const digest = (files: TarFile[]) => files.map((f) => `${f.name} ${sha(f.bytes)}`);
    expect(historyFiles(plain.files)).toEqual([]);
    expect(digest(off.files)).toEqual(digest(plain.files));
    // With history, the same files plus the history folder, and nothing else.
    expect(digest(on.files.filter((f) => !f.name.startsWith(".parachute/history/")))).toEqual(digest(plain.files));
    const names = historyFiles(on.files).map((f) => f.name);
    expect(names).toContain(`.parachute/history/${ids.story}.jsonl`);
    expect(names).toContain(`.parachute/history/${ids.gone}.jsonl`);
    expect(names).not.toContain(`.parachute/history/${ids.erased}.jsonl`);
    expect(names.every((n) => /^\.parachute\/history\/[^/]+\.jsonl$/.test(n))).toBe(true);
    // The CLI's plain export has no history folder either.
    const dir = join(SCRATCH, "cli-plain");
    await run(s.home, ["export", dir, "--vault", s.vaultName]);
    expect(existsSync(join(dir, ".parachute", "history"))).toBe(false);
  });

  test("importing the same export twice adds no versions the second time", async () => {
    const dir = join(SCRATCH, "cli");
    const target = await restoreTarget("eh-twice");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    const first = versionCount(target.home, target.vault);
    const story = restoredVersions(target.home, target.vault, ids.story);
    expect(story.length).toBe(4);
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    expect(versionCount(target.home, target.vault)).toBe(first);
    expect(restoredVersions(target.home, target.vault, ids.story)).toEqual(story);
    // A plain (upsert) import over it: the upsert writes as any write does, but no version from the file lands twice.
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    const again = restoredVersions(target.home, target.vault, ids.story);
    const keyOf = (v: Record<string, unknown>) => `${v.superseded_at}|${v.op}|${v.content_hash}`;
    expect(new Set(again.map(keyOf)).size).toBe(again.length);
    expect(again.slice(0, 4)).toEqual(story);
  });

  test("the tar export with history imports the same as the folder", async () => {
    const on = await pull(admin.token, "?history=1");
    const dir = join(SCRATCH, "tar");
    writeTree(on.files, dir);
    const target = await restoreTarget("eh-tar");
    await run(target.home, ["import", dir, "--vault", target.vault, "--blow-away", "--yes"]);
    expect(restoredVersions(target.home, target.vault, ids.story)).toEqual(await sourceVersions(ids.story));
    expect(readdirSync(join(dir, ".parachute", "history")).length).toBeGreaterThan(1);
  });

  test("a backup key's export carries history; a tag-scoped key still can't export at all", async () => {
    const made = await call("/account/keys", { method: "POST", auth: `Bearer ${await accountToken()}`, body: { name: `eh-backup-${shortId()}`, vault: s.vaultName, can: "export" } });
    must(made.status === 201, `minting the backup key: ${made.status} ${made.text.slice(0, 200)}`);
    const backup = await pull(made.body.token, "?history=1");
    expect(backup.status).toBe(200);
    const story = historyFiles(backup.files).find((f) => f.name === `.parachute/history/${ids.story}.jsonl`);
    expect(story).toBeTruthy();
    expect(new TextDecoder().decode(story!.bytes).trimEnd().split("\n").length).toBe(4);
    const scoped = await pull(await pass({ level: "read", tags: [`${R}draft`] }), "?history=1");
    expect(scoped.status).toBe(403);
    expect(scoped.files).toEqual([]);
  });
});
