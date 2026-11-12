// Export format 2 (T-463, 0.9.3): `parachute-vault export <dir> --format 2`.
//
// Format 1 cannot carry four things (tools/move/digest.ts `formatRisks`): a field name with a space, a colon or a
// non-ASCII letter; a list inside a list or `{}` inside a list; U+2028 or U+2029 in a string; a CRLF body. Format 2
// carries all four, writes a record's fields flat (Obsidian properties), keeps Parachute's own keys under one
// `parachute:` block, writes `tags:` as a plain list, and files a body-less typed record under `<type>/<YYYY-MM>/`.
// Format 1 stays the default and the importer reads both.
//
// Checked here, on the real CLI: the file layout and the flat frontmatter; an import into an empty vault gives the same
// vault by digest (tools/move/digest.ts, read from the box's SQLite file, over this run's notes and types); and a
// format 1 export, imported, exported as format 2, imported, exported as format 1 and imported again is the same vault
// by digest at every step. "Opens in real Obsidian with properties searchable" is a manual check, not run here.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestFromBox, sha, type Digest, SECTIONS } from "../../../tools/move/digest.ts";
import { cli, freePort, newHome } from "../candidate-lib.ts";
import { must, operator, runId, safeFetch, services } from "../lib.ts";

const s = services();
const R = runId("v2").replace(/-/g, "");
const TYPE = `${R}event`;
const SCRATCH = join(s.home, "..", `export-v2-${R}`);
const CRLF = "first line\r\nsecond line\r\n\r\nlast\r\n";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3, 4]);

const LEFTOVERS = {
  "has space": 1,
  "colon:key": "v",
  "naïve": "ü",
  nest: [[1, 2], ["a", ["b"]], []],
  emptyobj: [{}, { k: [[1], {}] }],
  sep: "a b c",
  plain_field: "stays flat",
};
const RESERVED = { id: "user-id", path: "user/path", tags: ["x", "y"], parachute: { inner: 1 }, _parachute: "u1", created_at: "c", metadata: { a: 1 }, links: "l" };
const ids: Record<string, string> = {};
const run = async (home: string, args: string[], vault = true) => {
  const r = await cli(home, args, { vault });
  must(r.code === 0, `parachute-vault ${args.join(" ")} exited ${r.code}: ${r.stderr.slice(-400)}`);
  return r;
};
const exp = (home: string, vault: string, dir: string, format: 1 | 2) => run(home, ["export", dir, "--vault", vault, ...(format === 2 ? ["--format", "2"] : [])]);

const files = (dir: string, sub = ""): string[] =>
  readdirSync(join(dir, sub)).flatMap((e) => {
    const rel = sub ? `${sub}/${e}` : e;
    return e.startsWith(".") ? [] : statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  }).sort();

async function restoreTarget(label: string): Promise<{ home: string; vault: string }> {
  const home = newHome(label);
  mkdirSync(join(home, "vault"), { recursive: true });
  writeFileSync(join(home, "vault", "config.yaml"), `port: ${await freePort()}\n`);
  await run(home, ["create", "restored", "--no-mirror", "--json"]);
  return { home, vault: "restored" };
}

/** This run's slice of a box's digest: each section's lines for its notes and types, hashed. */
async function mine(home: string, vault: string): Promise<Record<string, string>> {
  const base = join(home, "vault", "data", vault);
  const d: Digest = await digestFromBox(join(base, "vault.db"), join(base, "assets"), vault);
  const keep = new Set(Object.values(ids));
  const first = (line: string) => (line.includes("\t") ? line.split("\t")[0]! : (JSON.parse(line) as unknown[])[0]);
  const out: Record<string, string> = {};
  for (const sec of SECTIONS) {
    const lines = d.lines[sec].filter((l) => {
      if (sec === "tag_schemas") return (JSON.parse(l) as string[])[0] === TYPE;
      if (sec === "tags_in_use" || sec === "bare_types") return l === TYPE || l.startsWith(R);
      if (sec === "description") return false;
      return keep.has(String(first(l)));
    });
    out[sec] = `${lines.length}:${sha([...lines].sort().join("\n"))}`;
  }
  return out;
}

let v1Dir: string;
let v2Dir: string;
let source: Record<string, string>;
beforeAll(async () => {
  const op = operator();
  const put = await op.put(`/tags/${TYPE}`, { fields: { status: { type: "string" } } });
  must(put.status < 300, `setup: type gave ${put.status}`);
  const mk = async (key: string, body: Record<string, unknown>) => {
    const r = await op.post("/notes", body);
    must(r.status === 201, `setup: ${key} gave ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    ids[key] = r.body.id;
  };
  await mk("left", { path: `${R}/leftovers`, content: CRLF, tags: [TYPE], metadata: LEFTOVERS, created_at: "2026-05-12T10:00:00.000Z" });
  await mk("reserved", { path: `${R}/reserved`, content: "plain body\n", metadata: RESERVED, created_at: "2026-05-13T10:00:00.000Z" });
  await mk("sam", { path: `${R}/Contacts/Sam`, content: "", tags: [TYPE], metadata: { status: "open" }, created_at: "2026-05-14T10:00:00.000Z" });
  await mk("nopath", { content: "", tags: [TYPE], metadata: { status: "later" }, created_at: "2026-06-01T10:00:00.000Z" });
  const left = (await op.get(`/notes/${ids.left}`)).body;
  const link = await op.patch(`/notes/${ids.left}`, { links: { add: [{ target: ids.reserved, relationship: "cites", metadata: { why: "because: it is" } }] }, if_updated_at: left.updatedAt });
  must(link.status === 200, `setup: link gave ${link.status}`);
  const form = new FormData();
  form.set("file", new File([PNG as unknown as BlobPart], "map.png", { type: "image/png" }));
  const up = await safeFetch(`${s.vaultViaHub}/api/storage/upload`, { method: "POST", headers: { authorization: `Bearer ${s.operatorToken}` }, body: form });
  must(up.status === 201, `setup: upload gave ${up.status}`);
  const path = (await up.json()).path;
  const att = await op.post(`/notes/${ids.reserved}/attachments`, { path, mimeType: "image/png" });
  must(att.status === 201, `setup: attach gave ${att.status}`);
  source = await mine(s.home, s.vaultName);
  v2Dir = join(SCRATCH, "v2");
  await exp(s.home, s.vaultName, v2Dir, 2);
  v1Dir = join(SCRATCH, "v1");
  await exp(s.home, s.vaultName, v1Dir, 1);
});

describe("the fixture holds the four things format 1 cannot carry", () => {
  test("the box's own digest lists all four as risks on this run's notes", async () => {
    const base = join(s.home, "vault", "data", s.vaultName);
    const d = await digestFromBox(join(base, "vault.db"), join(base, "assets"), s.vaultName);
    const why = new Set(d.risks.filter((r) => Object.values(ids).includes(r.id)).map((r) => r.why));
    expect([...why].sort()).toEqual([
      "a body with CRLF line endings",
      "a field name with a space, a colon or a non-ASCII character",
      "a list directly inside a list",
      "a string with a U+2028 or U+2029 line separator",
      "an empty object inside a list",
    ]);
  });
});

describe("--format 2: what is written", () => {
  test("the manifest says format 2, and format 1 is still the default", () => {
    expect(readFileSync(join(v2Dir, ".parachute", "vault.yaml"), "utf8")).toMatch(/^export_format_version: 2$/m);
    expect(readFileSync(join(v1Dir, ".parachute", "vault.yaml"), "utf8")).toMatch(/^export_format_version: 1$/m);
    expect(readFileSync(join(v1Dir, `${R}/reserved.md`), "utf8")).toContain("\nmetadata:\n");
  });

  test("body-less typed records are filed by type and month; the rest keep their paths", () => {
    const mineFiles = files(v2Dir).filter((f) => f.startsWith(`${R}/`) || f.startsWith(`${TYPE}/`));
    expect(mineFiles).toEqual([
      `${R}/leftovers.md`,
      `${R}/reserved.md`,
      `${TYPE}/2026-05/Sam.md`,
      `${TYPE}/2026-06/${ids.nopath}.md`,
    ]);
    expect(files(v1Dir).filter((f) => f.startsWith(`${TYPE}/`))).toEqual([]);
  });

  test("fields are flat, tags are a plain list, and Parachute's keys are under parachute:", () => {
    const head = (f: string) => readFileSync(join(v2Dir, f), "utf8").split("\n---\n")[0]!;
    const left = head(`${R}/leftovers.md`);
    expect(left).toContain("\nplain_field: stays flat\n");
    expect(left).toContain("\n'has space': 1\n");
    expect(left).toContain(`\ntags:\n  - ${TYPE}\n`);
    expect(left).toContain(`\nparachute:\n  created_at: 2026-05-12T10:00:00.000Z\n`);
    expect(left).toContain(`\n  id: ${ids.left}\n`);
    expect(left).not.toMatch(/^metadata:/m);
    const sam = head(`${TYPE}/2026-05/Sam.md`);
    expect(sam).toContain("\nstatus: open\n");
    expect(sam).toContain(`\n  path: ${R}/Contacts/Sam\n`);
  });

  test("a field named like a reserved key is written so it reads back, never as the reserved key", () => {
    const text = readFileSync(join(v2Dir, `${R}/reserved.md`), "utf8").split("\n---\n")[0]!;
    expect(text).toContain("\nid: user-id\n");
    expect(text).toContain("\n_parachute:\n  inner: 1\n");
    expect(text).toContain("\n__parachute: u1\n");
    expect(text).toContain("\n_tags:\n  - x\n  - 'y'\n");
    expect(text).not.toMatch(/^tags:$/m);
  });

  test("the CRLF body is in the file byte for byte", () => {
    expect(readFileSync(join(v2Dir, `${R}/leftovers.md`)).toString("latin1").endsWith(CRLF)).toBe(true);
  });
});

describe("--format 2: what the CLI refuses", () => {
  test("not with --watch, --since or --git-commit, and not into a folder that holds format 1", async () => {
    for (const extra of [["--watch"], ["--since", "2026-01-01T00:00:00Z"], ["--git-commit"]]) {
      const r = await cli(s.home, ["export", join(SCRATCH, "refused"), "--vault", s.vaultName, "--format", "2", ...extra], { vault: true });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--format 2 is a whole-vault export");
    }
    const mixed = await cli(s.home, ["export", v1Dir, "--vault", s.vaultName, "--format", "2"], { vault: true });
    expect(mixed.code).not.toBe(0);
    expect(mixed.stderr).toContain("already holds a format 1 export");
    const bad = await cli(s.home, ["export", join(SCRATCH, "bad"), "--vault", s.vaultName, "--format", "3"], { vault: true });
    expect(bad.code).not.toBe(0);
  });
});

describe("--format 2: what comes back", () => {
  test("an import into an empty vault is the same vault by digest, files included", async () => {
    const t = await restoreTarget("v2-copy");
    await run(t.home, ["import", v2Dir, "--vault", t.vault, "--blow-away", "--yes"]);
    const copy = await mine(t.home, t.vault);
    expect(copy).toEqual(source);
    expect(source.notes).toMatch(/^4:/);
    expect(source.attachments).toMatch(/^1:/);
    expect(source.links).toMatch(/^1:/);
  });

  test("v1 to v2 to v1: the same vault by digest at every step", async () => {
    // Format 1 drops the four things, so the first import is what a format 1 export can carry; from there nothing may change.
    const b = await restoreTarget("v2-b");
    await run(b.home, ["import", v1Dir, "--vault", b.vault, "--blow-away", "--yes"]);
    const digestB = await mine(b.home, b.vault);
    const c = await restoreTarget("v2-c");
    const viaV2 = join(SCRATCH, "b-v2");
    await exp(b.home, b.vault, viaV2, 2);
    await run(c.home, ["import", viaV2, "--vault", c.vault, "--blow-away", "--yes"]);
    expect(await mine(c.home, c.vault)).toEqual(digestB);
    const d = await restoreTarget("v2-d");
    const backV1 = join(SCRATCH, "c-v1");
    await exp(c.home, c.vault, backV1, 1);
    await run(d.home, ["import", backV1, "--vault", d.vault, "--blow-away", "--yes"]);
    expect(await mine(d.home, d.vault)).toEqual(digestB);
  });

  test("an import refuses a format it does not read, and says which it reads", async () => {
    const dir = join(SCRATCH, "future");
    mkdirSync(join(dir, ".parachute"), { recursive: true });
    writeFileSync(join(dir, ".parachute", "vault.yaml"), "export_format_version: 9\nexported_at: 2026-11-12T00:00:00.000Z\n");
    const t = await restoreTarget("v2-future");
    const r = await cli(t.home, ["import", dir, "--vault", t.vault, "--blow-away", "--yes"], { vault: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/format 9.*reads 1 and 2/);
  });
});
