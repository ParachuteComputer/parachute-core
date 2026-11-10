// The move's proof must be able to fail. These hold the parts that decide a verdict: the tar a door reads, what the
// plan flags before a move, and what the comparison excuses. The moves themselves run against real doors in
// contracts/harness/doors/moves.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxDescription, compareDigests, formatRisks, sha, SECTIONS, type Digest, type Section } from "./digest.ts";
import { filesFromExport } from "./doors.ts";
import { tar, untar } from "./tar.ts";

function digestOf(lines: Partial<Record<Section, string[]>>, extra: Partial<Digest> = {}): Digest {
  const all = Object.fromEntries(SECTIONS.map((s) => [s, lines[s] ?? []])) as Record<Section, string[]>;
  const digests = Object.fromEntries(SECTIONS.map((s) => [s, sha([...all[s]].sort().join("\n"))])) as Digest["digests"];
  digests.all = sha(SECTIONS.map((s) => digests[s]).join("|"));
  const counts = { ...Object.fromEntries(SECTIONS.map((s) => [s, all[s].length])), attributed_notes: 0, versions: 0 } as Digest["counts"];
  return { vault: "v", reader: "rest", counts, digests, lines: all, files: [], risks: [], ...extra };
}
const note = (id: string, body: string, fields: unknown = {}) => JSON.stringify([id, `p/${id}`, "md", sha(body), fields, [], "t1", "t2"]);

describe("the comparison", () => {
  const base = { notes: [note("a", "one"), note("b", "two")], links: ["a\tb\twikilink"], attachments: [JSON.stringify(["a", "2026-01-01/x.png", "image/png", "aa"])], tag_schemas: [JSON.stringify(["task", null, { s: { type: "string" } }, null, null])] };

  test("the same vault is equal", () => {
    const c = compareDigests(digestOf(base), digestOf(base));
    expect(c.verdict).toBe("DIGEST EQUAL");
    expect(c.ok).toBe(true);
  });

  test("a dropped note, a changed body, a changed file byte, a changed type and a lost link each fail", () => {
    const cases: Partial<Record<Section, string[]>>[] = [
      { ...base, notes: [note("a", "one")] },
      { ...base, notes: [note("a", "one"), note("b", "two!")] },
      { ...base, attachments: [JSON.stringify(["a", "2026-01-01/x.png", "image/png", "ab"])] },
      { ...base, tag_schemas: [JSON.stringify(["task", null, { s: { type: "integer" } }, null, null])] },
      { ...base, links: [] },
    ];
    for (const changed of cases) {
      const c = compareDigests(digestOf(base), digestOf(changed));
      expect(c.verdict).toBe("DIGEST DIFFERS");
      expect(c.ok).toBe(false);
    }
  });

  test("a note accepted before the move is excused; any other note is not, and a count is never enough", () => {
    const changed = { ...base, notes: [note("a", "one", { k: 1 }), note("b", "two")] };
    const src = digestOf({ ...base, notes: [note("a", "one", { "k y": 1 }), note("b", "two")] });
    expect(compareDigests(src, digestOf(changed), { acceptNotes: ["a"] }).verdict).toBe("DIGEST EQUAL EXCEPT REVIEWED ITEMS");
    expect(compareDigests(src, digestOf(changed), { acceptNotes: ["b"] }).ok).toBe(false);
    expect(compareDigests(src, digestOf(changed)).ok).toBe(false);
    // Accepting one note doesn't cover a second that changed too.
    const two = { ...base, notes: [note("a", "one", { k: 1 }), note("b", "TWO")] };
    expect(compareDigests(src, digestOf(two), { acceptNotes: ["a"] }).ok).toBe(false);
  });

  test("a lost description fails", () => {
    const withIt = digestOf({ ...base, description: [sha("A vault about the valley.")] });
    expect(compareDigests(withIt, digestOf(base)).ok).toBe(false);
    expect(compareDigests(withIt, digestOf({ ...base, description: [sha("Another text.")] })).ok).toBe(false);
    expect(compareDigests(withIt, digestOf({ ...base, description: [sha("A vault about the valley.")] })).verdict).toBe("DIGEST EQUAL");
  });

  test("an operator's comparison leaves the description to the hand-over, and nothing else", () => {
    const withIt = digestOf({ ...base, description: [sha("A vault about the valley.")] });
    const c = compareDigests(withIt, digestOf(base), { descriptionAtHandOver: true });
    expect(c.verdict).toBe("DIGEST EQUAL");
    expect(c.lines.join("\n")).toContain("handed to its owner");
    expect(compareDigests(withIt, digestOf({ ...base, links: [] }), { descriptionAtHandOver: true }).ok).toBe(false);
  });

  test("a lost duplicate (digests differ, no line differs) fails", () => {
    const a = digestOf(base);
    const b = digestOf(base);
    b.digests.links = sha("something else");
    b.digests.all = sha("x");
    expect(compareDigests(a, b).ok).toBe(false);
  });

  test("types with no fields may become tags only when the move goes down a release, and never the other way", () => {
    const up = digestOf({ ...base, bare_types: ["idea"] });
    const down = digestOf(base);
    expect(compareDigests(up, down).ok).toBe(false);
    expect(compareDigests(up, down, { dropBareTypes: true }).verdict).toBe("DIGEST EQUAL EXCEPT REVIEWED ITEMS");
    expect(compareDigests(down, up, { dropBareTypes: true }).ok).toBe(false);
  });
});

describe("what the plan flags before a move", () => {
  const why = (content: string | null, meta: unknown) => formatRisks("n", content, meta).map((r) => r.why);

  test("ordinary notes carry exactly: nested objects, lists, URLs, unicode values", () => {
    expect(why("# Hi\n\nGrüße 東京\n", { status: "a:b", urls: ["https://example.org/a"], people: [{ name: "Sam" }], nested: { deep: { list: [1, 2] } }, "snake_case-and.dots": 1 })).toEqual([]);
  });

  test("the shapes the format is known to lose are named", () => {
    expect(why("x", { "a key": 1 })).toContain("a field name with a space, a colon or a non-ASCII character");
    expect(why("x", { "k:v": 1 })).toContain("a field name with a space, a colon or a non-ASCII character");
    expect(why("x", { größe: 1 })).toContain("a field name with a space, a colon or a non-ASCII character");
    expect(why("x", { m: [[1, 2]] })).toContain("a list directly inside a list");
    expect(why("x", { m: [{}] })).toContain("an empty object inside a list");
    expect(why("x", { m: "a\u2028b" })).toContain("a string with a U+2028 or U+2029 line separator");
    expect(why("a\r\nb", {})).toContain("a body with CRLF line endings");
    expect(why("x", '"just text"')).toContain("fields stored as text, not as an object");
  });
});

describe("the tar a door reads", () => {
  test("files come back byte for byte, long and non-ASCII names included, in a stable order", () => {
    const long = `Notes/${"a very long title ".repeat(8)}end.md`;
    const files = [
      { name: "b.md", bytes: new TextEncoder().encode("---\nid: 1\n---\nbody\n") },
      { name: long, bytes: new TextEncoder().encode("long") },
      { name: "Grüße/東京.md", bytes: new TextEncoder().encode("unicode") },
      { name: ".parachute/attachments/abc/x.png", bytes: new Uint8Array([0x89, 0x50, 0, 255, 254, 13, 10]) },
      { name: "empty.md", bytes: new Uint8Array(0) },
    ];
    const packed = tar(files);
    expect(packed.length % 512).toBe(0);
    const back = untar(packed);
    expect(back.map((f) => f.name).sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) expect(Buffer.from(back.find((b) => b.name === f.name)!.bytes).equals(Buffer.from(f.bytes))).toBe(true);
    expect(Buffer.from(tar([...files].reverse())).equals(Buffer.from(packed))).toBe(true);
  });

  test("a GNU long-name record is refused, not read as a wrong name", () => {
    const h = new Uint8Array(1024);
    h.set(new TextEncoder().encode("././@LongLink"), 0);
    h.set(new TextEncoder().encode("00000000010"), 124);
    h[156] = "L".charCodeAt(0);
    expect(() => untar(h)).toThrow(/GNU long name/);
  });

  test("a cut-short tar is refused", () => {
    const packed = tar([{ name: "a.md", bytes: new Uint8Array(2000) }]);
    expect(() => untar(packed.subarray(0, 1024))).toThrow(/cut short/);
  });
});

describe("matching attached files to the export", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const exported = { how: "GET /api/export" as const, files: [{ name: ".parachute/attachments/att1/123-x.png", bytes }] };
  test("a file is matched by name and bytes; a file whose bytes differ in the export stops the move", () => {
    const src = digestOf({}, { files: [{ note: "a", path: "2026-01-01/123-x.png", mime: "image/png", size: 3, sha256: sha(bytes) }] });
    expect(filesFromExport(exported, src).map((f) => f.path)).toEqual(["2026-01-01/123-x.png"]);
    const wrong = digestOf({}, { files: [{ note: "a", path: "2026-01-01/123-x.png", mime: "image/png", size: 3, sha256: sha(new Uint8Array([9])) }] });
    expect(() => filesFromExport(exported, wrong)).toThrow(/doesn't hold the file/);
  });
});

describe("a box's description", () => {
  test("is read from the block the box writes, several lines and all", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-test-"));
    const y = join(dir, "vault.yaml");
    writeFileSync(y, 'name: atlas\ndescription: |\n  Atlas: a made-up vault.\n  Second line.\ncreated_at: "2026-11-01T00:00:00.000Z"\n');
    expect(boxDescription(y)).toBe("Atlas: a made-up vault.\nSecond line.");
    writeFileSync(y, 'name: atlas\ncreated_at: "2026-11-01T00:00:00.000Z"\n');
    expect(boxDescription(y)).toBeNull();
    expect(boxDescription(join(dir, "missing.yaml"))).toBeNull();
  });
});
