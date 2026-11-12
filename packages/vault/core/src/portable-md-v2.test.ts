/**
 * Portable export format 2 (T-463, 0.9.3): record fields flat in the frontmatter, Parachute's own keys under one
 * `parachute:` block, `tags:` a plain list, body-less records filed under `<type>/<YYYY-MM>/`, and the four things
 * format 1 cannot carry (odd field names, a list in a list or `{}` in a list, U+2028/2029, CRLF bodies) carried
 * exactly. Format 1 stays the default and unchanged. Made-up data.
 *
 * Bun.YAML is a second, independent YAML 1.2 reader: what it reads from a frontmatter block must be what the note
 * holds, so a reader that is not ours (Obsidian's) sees the same values.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { SqliteStore } from "./store.js";
import { exportVaultToDir, importPortableVault, parseFrontmatter } from "./portable-md.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "portable-v2-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;

/** What a vault holds, one line per note, link and type, and a digest over the lot (as tools/move/digest.ts reads it). */
async function digest(store: SqliteStore): Promise<{ lines: string[]; sha: string }> {
  const notes = await store.queryNotes({ sort: "asc", limit: 1000 });
  const lines: string[] = [];
  for (const n of notes) {
    lines.push(JSON.stringify(["note", n.id, n.path ?? null, n.extension ?? "md", n.content.replace(/\n+$/, ""), canon(n.metadata ?? {}), [...(n.tags ?? [])].sort(), n.createdAt, n.updatedAt]));
    for (const l of await store.getLinks(n.id, { direction: "outbound" })) {
      if (l.relationship !== "wikilink") lines.push(JSON.stringify(["link", l.sourceId, l.targetId, l.relationship, canon(l.metadata ?? {})]));
    }
  }
  for (const t of await store.listTagRecords()) lines.push(JSON.stringify(["tag", t.tag, canon(t.fields ?? null), canon(t.parent_names ?? null)]));
  lines.sort();
  return { lines, sha: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/** Every metadata value format 1 mangles, and a field named like each key a format has to keep for itself. */
const LEFTOVERS = {
  "has space": 1,
  "colon:key": "v",
  "naïve": "ü",
  "": "empty name",
  "- dash": true,
  nest: [[1, 2], ["a", ["b"]], []],
  emptyobj: [{}, { k: [[1], {}] }],
  sep: "a b c\u0085d",
  list: [{ k: [[1], []] }],
};
const RESERVED = {
  id: "user-id",
  path: "user/path",
  extension: "user-ext",
  tags: ["x", "y"],
  parachute: { inner: 1 },
  _parachute: "u1",
  _tags: 2,
  metadata: { a: 1 },
  links: "l",
  attachments: [{ id: "a" }],
  created_at: "c",
  updated_at: "u",
};
const CRLF_BODY = "line one\r\nline two\r\n\r\nlast\r\n";

async function fixture(): Promise<{ store: SqliteStore; ids: Record<string, string> }> {
  const store = new SqliteStore(new Database(":memory:"));
  await store.upsertTagRecord("event", { fields: { status: { type: "string" } } });
  const ids: Record<string, string> = {};
  const mk = async (key: string, content: string, opts: Record<string, unknown>) => {
    const n = await store.createNote(content, opts as any);
    ids[key] = n.id;
    return n;
  };
  await mk("left", CRLF_BODY, { path: "Fake/leftovers", tags: ["event", "plain"], metadata: LEFTOVERS, created_at: "2026-05-12T10:00:00.000Z" });
  await mk("reserved", "plain body\n", { path: "Fake/reserved", tags: ["plain"], metadata: RESERVED, created_at: "2026-05-13T10:00:00.000Z" });
  await mk("sam", "", { path: "Contacts/Sam", tags: ["event"], metadata: { status: "open" }, created_at: "2026-05-14T10:00:00.000Z" });
  await mk("sam2", "", { path: "Other/Sam", tags: ["event"], metadata: { status: "done" }, created_at: "2026-05-15T10:00:00.000Z" });
  await mk("nopath", "", { tags: ["event"], metadata: { status: "later" }, created_at: "2026-06-01T10:00:00.000Z" });
  await mk("untyped", "", { path: "Fake/empty-untyped", tags: ["plain"], created_at: "2026-06-02T10:00:00.000Z" });
  await mk("sheet", "a,b\r\n1,2\r\n", { path: "Data/sheet", extension: "csv", metadata: { "odd key": [[1]] }, created_at: "2026-06-03T10:00:00.000Z" });
  await store.createLink(ids.left!, ids.reserved!, "cites", { why: "because: it is" });
  await store.restoreNoteTimestamps(ids.left!, "2026-05-12T10:00:00.000Z", "2026-05-12T11:00:00.000Z");
  return { store, ids };
}

const files = (dir: string, sub = ""): string[] =>
  readdirSync(join(dir, sub)).flatMap((e) => {
    const rel = sub ? `${sub}/${e}` : e;
    return e.startsWith(".") ? [] : statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  }).sort();

/** The frontmatter block of an exported file, read by Bun.YAML (an independent YAML 1.2 reader). */
function yamlFrontmatter(file: string): Record<string, any> {
  const raw = readFileSync(file, "utf8");
  const end = raw.indexOf("\n---\n", 4);
  return Bun.YAML.parse(raw.slice(4, end)) as Record<string, any>;
}

describe("format 1 is the default", () => {
  it("writes export_format_version 1 and the metadata: block", async () => {
    const { store } = await fixture();
    await exportVaultToDir(store, { outDir: root, exportedAt: "2026-11-12T00:00:00.000Z" });
    expect(readFileSync(join(root, ".parachute", "vault.yaml"), "utf8")).toContain("export_format_version: 1");
    expect(readFileSync(join(root, "Fake", "reserved.md"), "utf8")).toContain("\nmetadata:\n");
    expect(existsSync(join(root, "event"))).toBe(false);
  });
});

describe("format 2 layout and frontmatter", () => {
  it("records the version, files body-less typed records by type and month, and keeps the rest where v1 puts them", async () => {
    const { store, ids } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    expect(readFileSync(join(root, ".parachute", "vault.yaml"), "utf8")).toContain("export_format_version: 2");
    expect(files(root)).toEqual([
      "Data/sheet.csv",
      "Fake/empty-untyped.md",
      "Fake/leftovers.md",
      "Fake/reserved.md",
      `event/2026-05/Sam 2.md`,
      "event/2026-05/Sam.md",
      `event/2026-06/${ids.nopath}.md`,
    ]);
  });

  it("writes record fields flat, tags as a plain list and Parachute's keys under parachute:", async () => {
    const { store, ids } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const fm = yamlFrontmatter(join(root, "Fake", "leftovers.md"));
    expect(fm.metadata).toBeUndefined();
    expect(fm["has space"]).toBe(1);
    expect(fm["colon:key"]).toBe("v");
    expect(fm.naïve).toBe("ü");
    expect(fm[""]).toBe("empty name");
    expect(fm["- dash"]).toBe(true);
    expect(fm.tags).toEqual(["event", "plain"]);
    expect(fm.parachute.id).toBe(ids.left!);
    expect(fm.parachute.path).toBe("Fake/leftovers");
    expect(fm.parachute.created_at).toBe("2026-05-12T10:00:00.000Z");
    expect(fm.parachute.updated_at).toBe("2026-05-12T11:00:00.000Z");
    expect(fm.parachute.links).toEqual([{ target: ids.reserved!, relationship: "cites", metadata: { why: "because: it is" } }]);
  });

  it("a second YAML 1.2 reader sees exactly the values the note holds (the four leftovers included)", async () => {
    const { store } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const fm = yamlFrontmatter(join(root, "Fake", "leftovers.md"));
    for (const [k, v] of Object.entries(LEFTOVERS)) expect(canon(fm[k])).toEqual(canon(v));
    expect(fm.sep).toBe("a b c\u0085d");
  });

  it("a field named like a reserved key is written so it reads back, and never as the reserved key", async () => {
    const { store } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const fm = yamlFrontmatter(join(root, "Fake", "reserved.md"));
    expect(fm.tags).toEqual(["plain"]);
    expect(fm._tags).toEqual(["x", "y"]); // the user's `tags` field
    expect(fm.__tags).toBe(2); // the user's `_tags` field
    expect(fm._parachute).toEqual({ inner: 1 });
    expect(fm.__parachute).toBe("u1");
    expect(fm.id).toBe("user-id"); // not reserved: Parachute's id is under parachute:
    expect(fm.parachute.id).not.toBe("user-id");
  });

  it("files a body-less record by its first type and its month, and keeps its own path", async () => {
    const { store, ids } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const sam = yamlFrontmatter(join(root, "event", "2026-05", "Sam.md"));
    expect(sam.status).toBe("open");
    expect(sam.parachute.path).toBe("Contacts/Sam");
    const nopath = yamlFrontmatter(join(root, "event", "2026-06", `${ids.nopath}.md`));
    expect(nopath.parachute.path).toBeUndefined();
  });
});

describe("format 2 round trip", () => {
  it("import gives the same vault: digests equal, CRLF bytes kept", async () => {
    const { store, ids } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    expect(readFileSync(join(root, "Fake", "leftovers.md"), "utf8").endsWith(CRLF_BODY)).toBe(true);
    const copy = new SqliteStore(new Database(":memory:"));
    await importPortableVault(copy, { inDir: root });
    const a = await digest(store);
    const b = await digest(copy);
    expect(b.lines).toEqual(a.lines);
    expect(b.sha).toBe(a.sha);
    expect((await copy.getNote(ids.left!))!.content).toBe(CRLF_BODY);
    expect((await copy.getNote(ids.sheet!))!.content).toBe("a,b\r\n1,2\r\n");
    expect((await copy.getNote(ids.sam!))!.path).toBe("Contacts/Sam");
    expect((await copy.getNote(ids.nopath!))!.path ?? null).toBeNull();
  });

  it("every awkward string comes back the same, and a second YAML reader agrees", async () => {
    const strings = [
      "", " lead", "trail ", "a: b", "a #b", "- x", "-x", "?x", ":x", "ends:", "yes", "No", "on", "OFF", "y", "N", "true", "Null", "~", "null",
      "12", "-3.5", "1e3", "0x1F", "0o17", ".5", ".inf", "-.INF", ".NaN", "1_000", "2026-05-12", "2026-05-12T10:00:00Z", "12:30", "[a]", "{a}", "[[Page]]",
      "a,b", "'q'", "\"dq\"", "it's", "tab\there", "nl\nx", "cr\rx", "\u0085", "﻿", " x", "back\\slash", "emoji 😀", " ", " ", "\x00", "\x07", "\x7f",
      "%x", "@x", "`x", "!x", "&x", "*x", "|", ">", "#c", "k=v", "https://example.org/a?b=c#d", "mailto:sam@example.org", "<<", "=",
    ];
    const store = new SqliteStore(new Database(":memory:"));
    const metadata = Object.fromEntries(strings.map((s, i) => [`k${i}`, s]));
    const withList = { ...metadata, list: strings };
    const n = await store.createNote("body\n", { path: "Fake/strings", metadata: withList });
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const fm = yamlFrontmatter(join(root, "Fake", "strings.md"));
    for (const [k, v] of Object.entries(withList)) expect(fm[k]).toEqual(v as any);
    const copy = new SqliteStore(new Database(":memory:"));
    await importPortableVault(copy, { inDir: root });
    expect((await copy.getNote(n.id))!.metadata).toEqual(withList);
  });

  it("v1 to v2 to v1 is the same vault by digest", async () => {
    // What format 1 can carry: no leftovers. (Reserved-name fields and body-less records are fine in both.)
    const store = new SqliteStore(new Database(":memory:"));
    await store.upsertTagRecord("event", { fields: { status: { type: "string" } } });
    const a = await store.createNote("", { path: "Contacts/Sam", tags: ["event"], metadata: { status: "open", tags: ["x"], parachute: 1, id: "u" }, created_at: "2026-05-14T10:00:00.000Z" });
    const b = await store.createNote("hello\n", { path: "Fake/hello", tags: ["event", "plain"], metadata: { list: ["a", "b:c"], nested: { k: [1, { z: 2 }] } }, created_at: "2026-05-15T10:00:00.000Z" });
    await store.createLink(a.id, b.id, "cites", { w: 1 });
    const v1a = join(root, "v1a");
    const v2 = join(root, "v2");
    const v1b = join(root, "v1b");
    await exportVaultToDir(store, { outDir: v1a, exportedAt: "2026-11-12T00:00:00.000Z" });
    const one = new SqliteStore(new Database(":memory:"));
    await importPortableVault(one, { inDir: v1a });
    await exportVaultToDir(one, { outDir: v2, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const two = new SqliteStore(new Database(":memory:"));
    await importPortableVault(two, { inDir: v2 });
    await exportVaultToDir(two, { outDir: v1b, exportedAt: "2026-11-12T00:00:00.000Z" });
    const three = new SqliteStore(new Database(":memory:"));
    await importPortableVault(three, { inDir: v1b });
    const d0 = await digest(store);
    expect((await digest(one)).sha).toBe(d0.sha);
    expect((await digest(two)).sha).toBe(d0.sha);
    expect((await digest(three)).sha).toBe(d0.sha);
    expect(readFileSync(join(v1b, "Fake", "hello.md"), "utf8")).toBe(readFileSync(join(v1a, "Fake", "hello.md"), "utf8"));
  });
});

describe("importer and exporter guards", () => {
  it("refuses a format it does not know, naming the versions it reads", async () => {
    const { store } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    writeFileSync(join(root, ".parachute", "vault.yaml"), "export_format_version: 3\nexported_at: 2026-11-12T00:00:00.000Z\n");
    const copy = new SqliteStore(new Database(":memory:"));
    await expect(importPortableVault(copy, { inDir: root })).rejects.toThrow(/format 3.*reads 1 and 2/);
  });

  it("an incremental export is not offered in format 2", async () => {
    const { store } = await fixture();
    await expect(exportVaultToDir(store, { outDir: root, format: 2, since: "2026-01-01T00:00:00Z" })).rejects.toThrow(/format 2.*whole vault/);
  });

  it("an unknown format number is refused on export", async () => {
    const { store } = await fixture();
    await expect(exportVaultToDir(store, { outDir: root, format: 7 as any })).rejects.toThrow(/format/);
  });
});

describe("the reader", () => {
  it("reads nested lists, empty collections in lists and the YAML escapes the writer uses", () => {
    const text = [
      "---",
      "a:",
      "  - - 1",
      "    - - x",
      "  - []",
      "  - {}",
      "  - k: v",
      "    z:",
      "      - - 2",
      "s: \"x\\u2028y\\U0001F600\\L\\P\\N\\_\\0\\/\"",
      "---",
      "body\r\nmore\r\n",
    ].join("\n");
    const { frontmatter, content } = parseFrontmatter(text, "export", undefined, { verbatimBody: true });
    expect(frontmatter.a).toEqual([[1, ["x"]], [], {}, { k: "v", z: [[2]] }]);
    expect(frontmatter.s).toBe("x y\u{1F600}  \u0085 \u0000/");
    expect(content).toBe("body\r\nmore\r\n");
  });
});

describe("review fixes (PR 104, round 1)", () => {
  it("a list item that is a lone dash is read, as the string it always was, and does not hang", () => {
    for (const text of ["---\nl:\n  - -\n---\n", "---\nl:\n  - - \n---\n", "---\nl:\n  - -\n    - a\n---\n"]) {
      const started = Date.now();
      const { frontmatter } = parseFrontmatter(text, "export");
      expect(Date.now() - started).toBeLessThan(1000);
      expect(Array.isArray(frontmatter.l)).toBe(true);
    }
    expect(parseFrontmatter("---\nl:\n  - -\n---\n", "export").frontmatter.l).toEqual(["-"]);
  });

  it("a second format 2 export into the same folder is refused, so no stale file is read as the record", async () => {
    const { store } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    await expect(exportVaultToDir(store, { outDir: root, format: 2 })).rejects.toThrow(/already holds an export/);
  });

  it("import stops when two files of a format 2 export hold one note, naming both", async () => {
    const { store, ids } = await fixture();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    // What a repeat export into the same folder used to leave: the record gained a body and moved, its old file stayed.
    const stale = readFileSync(join(root, "event", "2026-05", "Sam.md"), "utf8");
    writeFileSync(join(root, "Contacts-Sam.md"), stale);
    expect(stale).toContain(ids.sam!);
    const copy = new SqliteStore(new Database(":memory:"));
    await expect(importPortableVault(copy, { inDir: root })).rejects.toThrow(/two files of this export hold the note .*Contacts-Sam\.md/s);
  });

  it("numbers in exponent form, and signed hex or base 60 looking strings, come back as they were", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    const metadata = { big: 1e21, small: 1e-7, neg: -2.5e-9, list: [1.5e300, "1e+21", "+0x1f", "-0x1F", "0b101", "12:30", "1:30.5", "1e5"], str: "1e-7" };
    const n = await store.createNote("b\n", { path: "Fake/exp", metadata });
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const fm = yamlFrontmatter(join(root, "Fake", "exp.md"));
    for (const [k, v] of Object.entries(metadata)) expect(fm[k]).toEqual(v as any);
    const copy = new SqliteStore(new Database(":memory:"));
    await importPortableVault(copy, { inDir: root });
    expect((await copy.getNote(n.id))!.metadata).toEqual(metadata);
  });

  it("records that share one file name are named in linear time, each its own file", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await store.upsertTagRecord("event", { fields: { status: { type: "string" } } });
    const N = 6000;
    for (let i = 0; i < N; i++) await store.createNote("", { path: `P${i}/index`, tags: ["event"], created_at: "2026-05-12T10:00:00.000Z" });
    const started = Date.now();
    await exportVaultToDir(store, { outDir: root, format: 2, exportedAt: "2026-11-12T00:00:00.000Z" });
    const took = Date.now() - started;
    expect(readdirSync(join(root, "event", "2026-05")).length).toBe(N);
    expect(took).toBeLessThan(4000);
  }, 60000);
});
