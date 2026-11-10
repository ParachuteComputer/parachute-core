// What a vault holds, as counts and sha256 digests, read the same way from any door, so "the same vault after the
// move" is one comparison in every direction.
//
// Grown from the operator import's proof (T-379, the tool that moves a box's vaults into Parachute Cloud), which
// read the box's database on one side and cloud's REST on the other. Two readers now:
//   - `digestOverRest`: any door, through the vault's own REST: notes paged with content, links and files; types;
//     each file's bytes;
//   - `digestFromBox`: a box's SQLite file and assets folder, with no service running. On a box it is also the second
//     witness: the REST digest must equal it, so a mistake both doors share in serialising can't hide.
//
// Sections (each a sha256 over sorted lines, one line per item):
//   notes            id, path, extension, sha256(body without trailing newlines), fields (keys sorted), tags
//                    (sorted; on 0.9 the note door's `tags` holds types too), created_at, updated_at
//   links            source id, target id, relationship
//   attachments      note id, path, mime type, sha256 of the file's bytes
//   tags_in_use      names on at least one note
//   tag_schemas      each name with a description, fields, relationships or parents: those four
//   attachment_meta  each file row's metadata, when it has any (transcripts live here)
//   link_meta        each link's metadata, when it has any
//   bare_types       0.9: names that are a type by declaration alone (no fields, no parents). 0.8 can't hold these.
//   description      the vault's own description (what a connecting model is told first), when it has one
// Not in any section, because the export format doesn't carry them: who wrote a note (counted as
// `attributed_notes`), and a note's earlier versions.
//
// Lines hold ids, paths and tag names (never bodies), so a file of them is the owner's data: keep it private.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECTIONS = ["notes", "links", "attachments", "tags_in_use", "tag_schemas", "attachment_meta", "link_meta", "bare_types", "description"] as const;
export type Section = (typeof SECTIONS)[number];

export interface FileFact {
  note: string;
  path: string;
  mime: string | null;
  size: number;
  sha256: string;
}

export interface Digest {
  vault: string;
  reader: "rest" | "box-db";
  counts: Record<Section | "attributed_notes" | "versions", number>;
  digests: Record<Section | "all", string>;
  lines: Record<Section, string[]>;
  files: FileFact[];
  /** Notes whose shape the export format can't carry exactly (see `formatRisks`): id and why, never content. */
  risks: { id: string; why: string }[];
}

export const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
const trimNl = (t: string | null | undefined) => (t ?? "").replace(/\n+$/, "");
const safeParse = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const empty = (c: unknown) => c === "" || c === null || c === undefined || (typeof c === "object" && Object.keys(c as object).length === 0);
/** A metadata value as one comparable thing, or null when there is none: unset, "", {} and [] are the same. */
const metaOf = (v: unknown): unknown => {
  const c = canon(typeof v === "string" ? safeParse(v) : v);
  return empty(c) ? null : c;
};
/** A wikilink's `display` is derived from `[[target|display]]` in the body, which the notes section already hashes. */
const linkMetaOf = (relationship: string, v: unknown): unknown => {
  const m = metaOf(v);
  if (relationship !== "wikilink" || m === null || typeof m !== "object") return m;
  const { display: _derived, ...rest } = m as Record<string, unknown>;
  return Object.keys(rest).length === 0 ? null : rest;
};
const noteLine = (n: { id: string; path: string | null; ext: string; content: string | null; meta: unknown; tags: string[]; c: string | null; u: string | null }) =>
  JSON.stringify([n.id, n.path, n.ext, sha(trimNl(n.content)), canon(n.meta ?? {}), [...n.tags].sort(), n.c, n.u]);
const tagLine = (name: string, parts: unknown[]): string | null => {
  const clean = parts.map((v) => {
    const c = canon(typeof v === "string" && /^[[{]/.test(v) ? safeParse(v) : v);
    return empty(c) ? null : c;
  });
  return clean.every((c) => c === null) ? null : JSON.stringify([name, ...clean]);
};
const section = (lines: string[]) => sha([...lines].sort().join("\n"));

/**
 * What the export format (portable-md v1) is known not to carry exactly (audit L2-04, L2-13; fixed by format v2).
 * Found before a move, so a loss is refused or accepted in advance, never discovered after:
 *   - a field name with anything but letters, digits, `_`, `.` or `-` (a colon, a space, a non-ASCII letter);
 *   - a list directly inside a list, or an empty object inside a list;
 *   - a string holding U+2028 or U+2029;
 *   - a body with CRLF line endings (they come back as LF).
 */
export function formatRisks(id: string, content: string | null, meta: unknown): { id: string; why: string }[] {
  const why = new Set<string>();
  const walk = (v: unknown, inList: boolean) => {
    if (typeof v === "string") {
      if (/[\u2028\u2029]/.test(v)) why.add("a string with a U+2028 or U+2029 line separator");
    } else if (Array.isArray(v)) {
      if (inList) why.add("a list directly inside a list");
      for (const x of v) walk(x, true);
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (inList && keys.length === 0) why.add("an empty object inside a list");
      for (const k of keys) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k)) why.add("a field name with a space, a colon or a non-ASCII character");
        walk((v as Record<string, unknown>)[k], false);
      }
    }
  };
  walk(typeof meta === "string" ? safeParse(meta) : meta, false);
  if (typeof meta === "string" && typeof safeParse(meta) === "string") why.add("fields stored as text, not as an object");
  if (/\r\n/.test(content ?? "")) why.add("a body with CRLF line endings");
  return [...why].map((w) => ({ id, why: w }));
}

interface Gathered {
  vault: string;
  reader: Digest["reader"];
  noteLines: string[];
  links: string[];
  atts: string[];
  inUse: string[];
  tagRows: string[];
  attMeta: string[];
  linkMeta: string[];
  bareTypes: string[];
  description: string | null;
  attributed: number;
  versions: number;
  files: FileFact[];
  risks: { id: string; why: string }[];
}

function pack(g: Gathered): Digest {
  const lines: Record<Section, string[]> = {
    notes: g.noteLines,
    links: g.links,
    attachments: g.atts,
    tags_in_use: g.inUse,
    tag_schemas: g.tagRows,
    attachment_meta: g.attMeta,
    link_meta: g.linkMeta,
    bare_types: g.bareTypes,
    description: g.description && g.description.trim() ? [sha(g.description.trim())] : [],
  };
  const digests = Object.fromEntries(SECTIONS.map((s) => [s, section(lines[s])])) as Record<Section | "all", string>;
  digests.all = sha(SECTIONS.map((s) => digests[s]).join("|"));
  const counts = Object.fromEntries(SECTIONS.map((s) => [s, lines[s].length])) as Digest["counts"];
  counts.attributed_notes = g.attributed;
  counts.versions = g.versions;
  return { vault: g.vault, reader: g.reader, counts, digests, lines, files: g.files, risks: g.risks };
}

/**
 * A box keeps a vault's description in its `vault.yaml`, as the block the box itself writes:
 *   description: |
 *     first line
 *     second line
 */
export function boxDescription(yamlFile: string): string | null {
  if (!existsSync(yamlFile)) return null;
  const lines = readFileSync(yamlFile, "utf8").split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return null;
  const inline = lines[at]!.replace(/^description:\s*/, "");
  if (inline && inline !== "|") return inline.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("  ")) body.push(l.slice(2));
    else if (l.trim() === "") body.push("");
    else break;
  }
  return body.join("\n").replace(/\n+$/, "") || null;
}

/** A box's vault, from its database file and assets folder. Read-only; works with the box stopped or running. */
export async function digestFromBox(dbFile: string, assetsDir: string, vault: string): Promise<Digest> {
  const { Database } = await import("bun:sqlite");
  const d = new Database(dbFile, { readonly: true });
  try {
    const tagsOf = new Map<string, string[]>();
    for (const r of d.query("SELECT note_id, tag_name FROM note_tags").all() as Array<{ note_id: string; tag_name: string }>) {
      (tagsOf.get(r.note_id) ?? tagsOf.set(r.note_id, []).get(r.note_id)!).push(r.tag_name);
    }
    const notes = d.query("SELECT id, path, extension, content, metadata, created_at, updated_at, created_by, created_via FROM notes").all() as any[];
    const risks = notes.flatMap((n) => formatRisks(n.id, n.content, n.metadata || "{}"));
    const noteLines = notes.map((n) =>
      noteLine({ id: n.id, path: n.path, ext: n.extension, content: n.content, meta: safeParse(n.metadata || "{}"), tags: tagsOf.get(n.id) ?? [], c: n.created_at, u: n.updated_at }),
    );
    const linkRows = d.query("SELECT source_id, target_id, relationship, metadata FROM links").all() as any[];
    const links = linkRows.map((l) => `${l.source_id}\t${l.target_id}\t${l.relationship}`);
    const linkMeta = linkRows.filter((l) => linkMetaOf(l.relationship, l.metadata) !== null).map((l) => JSON.stringify([l.source_id, l.target_id, l.relationship, linkMetaOf(l.relationship, l.metadata)]));
    const attRows = d.query("SELECT note_id, path, mime_type, metadata FROM attachments").all() as any[];
    const files: FileFact[] = [];
    const atts = attRows.map((a) => {
      const f = join(assetsDir, a.path);
      const bytes = existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
      if (bytes) files.push({ note: a.note_id, path: a.path, mime: a.mime_type, size: bytes.length, sha256: sha(bytes) });
      return JSON.stringify([a.note_id, a.path, a.mime_type, bytes ? sha(bytes) : "MISSING"]);
    });
    const attMeta = attRows.filter((a) => metaOf(a.metadata) !== null).map((a) => JSON.stringify([a.note_id, a.path, metaOf(a.metadata)]));
    const hasKind = (d.query("PRAGMA table_info(tags)").all() as Array<{ name: string }>).some((c) => c.name === "kind");
    const tagTable = d.query(`SELECT name, description, fields, relationships, parent_names${hasKind ? ", kind" : ""} FROM tags`).all() as any[];
    const tagRows = tagTable.map((t) => tagLine(t.name, [t.description, t.fields, t.relationships, t.parent_names])).filter((l): l is string => l !== null);
    const bareTypes = tagTable.filter((t) => t.kind === "type" && empty(metaOf(t.fields)) && empty(metaOf(t.parent_names))).map((t) => String(t.name));
    const hasVersions = (d.query("SELECT name FROM sqlite_master WHERE type='table' AND name='note_versions'").all() as unknown[]).length > 0;
    const versions = hasVersions ? ((d.query("SELECT COUNT(*) AS n FROM note_versions").get() as { n: number }).n ?? 0) : 0;
    return pack({
      vault,
      reader: "box-db",
      description: boxDescription(join(dirname(dbFile), "vault.yaml")),
      noteLines,
      links,
      atts,
      inUse: [...new Set([...tagsOf.values()].flat())],
      tagRows,
      attMeta,
      linkMeta,
      bareTypes,
      attributed: notes.filter((n) => n.created_by || n.created_via).length,
      versions,
      files,
      risks,
    });
  } finally {
    d.close();
  }
}

/** Any door's vault, through its REST. `get` answers a path under the vault (`/api/...`) with a read credential. */
export async function digestOverRest(get: (path: string) => Promise<Response>, vault: string): Promise<Digest> {
  const notes: any[] = [];
  const PAGE = 200;
  for (let off = 0; ; off += PAGE) {
    const r = await get(`/api/notes?include_content=true&include_links=true&include_attachments=true&sort=asc&limit=${PAGE}&offset=${off}`);
    if (!r.ok) throw new Error(`digest: reading notes gave ${r.status}`);
    const page = (await r.json()) as any[];
    notes.push(...page);
    if (page.length < PAGE) break;
  }
  // A page boundary that moved under a write would repeat or skip a note: the ids must be unique.
  if (new Set(notes.map((n) => n.id)).size !== notes.length) throw new Error("digest: the note list changed while it was read; read again when nothing is writing");
  const risks = notes.flatMap((n) => formatRisks(n.id, n.content, n.metadata ?? {}));
  const noteLines = notes.map((n) =>
    noteLine({ id: n.id, path: n.path ?? null, ext: n.extension, content: n.content, meta: n.metadata ?? {}, tags: n.tags ?? [], c: n.createdAt ?? null, u: n.updatedAt ?? null }),
  );
  const links = new Set<string>();
  const linkMeta = new Set<string>();
  for (const n of notes) {
    for (const l of n.links ?? []) {
      links.add(`${l.sourceId}\t${l.targetId}\t${l.relationship}`);
      if (linkMetaOf(l.relationship, l.metadata) !== null) linkMeta.add(JSON.stringify([l.sourceId, l.targetId, l.relationship, linkMetaOf(l.relationship, l.metadata)]));
    }
  }
  const atts: string[] = [];
  const attMeta: string[] = [];
  const files: FileFact[] = [];
  for (const n of notes) {
    for (const x of n.attachments ?? []) {
      const note = x.noteId ?? x.note_id ?? n.id;
      const mime = x.mimeType ?? x.mime_type ?? null;
      if (metaOf(x.metadata) !== null) attMeta.push(JSON.stringify([note, x.path, metaOf(x.metadata)]));
      const r = await get(`/api/storage/${String(x.path).split("/").map(encodeURIComponent).join("/")}`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (r.ok) files.push({ note, path: x.path, mime, size: b.length, sha256: sha(b) });
      atts.push(JSON.stringify([note, x.path, mime, r.ok ? sha(b) : r.status === 404 ? "MISSING" : `HTTP${r.status}`]));
    }
  }
  const info = await get("/api/vault");
  if (!info.ok) throw new Error(`digest: reading the vault's description gave ${info.status}`);
  const description = ((await info.json()) as { description?: string | null }).description ?? null;
  const tagsRes = await get("/api/tags?include_schema=true");
  if (!tagsRes.ok) throw new Error(`digest: reading types gave ${tagsRes.status}`);
  const tagTable = (await tagsRes.json()) as any[];
  const tagRows = tagTable.map((t) => tagLine(t.name, [t.description, t.fields, t.relationships, t.parent_names])).filter((l): l is string => l !== null);
  const bareTypes = tagTable.filter((t) => t.kind === "type" && empty(metaOf(t.fields)) && empty(metaOf(t.parent_names))).map((t) => String(t.name));
  return pack({
    vault,
    reader: "rest",
    description,
    noteLines,
    links: [...links],
    atts,
    inUse: [...new Set(notes.flatMap((n) => n.tags ?? []))],
    tagRows,
    attMeta,
    linkMeta: [...linkMeta],
    bareTypes,
    attributed: notes.filter((n) => n.createdBy || n.createdVia).length,
    versions: 0,
    files,
    risks,
  });
}

export interface Comparison {
  verdict: "DIGEST EQUAL" | "DIGEST EQUAL EXCEPT REVIEWED ITEMS" | "DIGEST DIFFERS";
  ok: boolean;
  reviewed: number;
  lines: string[];
}

/**
 * Compare two digests. A difference passes only when it was named before the move:
 *   - `acceptNotes`: the notes the plan said the format can't carry exactly, accepted by the person moving. Each
 *     excuses only what its risk changes (the fields; or the body, for CRLF), never the note's path, tags or times;
 *   - `dropBareTypes`: the move goes down a release (0.9 to 0.8), where a type with no fields survives as a tag on the
 *     notes that carry it. `"and-unused"` also excuses such a type that is on no note (accepted before the move);
 *   - `descriptionAtHandOver`: an operator's move, where the door sets the description after the operator's last read.
 * A count never excuses a difference: digests that differ with no line to show for it (a lost duplicate) fail.
 */
export function compareDigests(
  a: Digest,
  b: Digest,
  opts: { acceptNotes?: { id: string; why: string }[]; dropBareTypes?: boolean | "and-unused"; descriptionAtHandOver?: boolean; names?: [string, string] } = {},
): Comparison {
  // What an accepted risk may change, and nothing more: CRLF endings change the body; every other risk is about
  // the fields. An accepted note whose path, tags or times came back different is not excused.
  const accept = new Map<string, Set<string>>();
  for (const r of opts.acceptNotes ?? []) {
    const may = accept.get(r.id) ?? accept.set(r.id, new Set()).get(r.id)!;
    may.add(/CRLF/.test(r.why) ? "content" : "fields");
  }
  const [an, bn] = opts.names ?? ["source", "target"];
  const out: string[] = [];
  let bad = 0;
  let reviewed = 0;
  let allSame = true;
  for (const k of SECTIONS) {
    // An operator moving a vault for its owner can read it only until it is handed over, and the door sets the
    // description at the hand-over (and reads it back itself). So the operator's comparison leaves it out, and says so.
    if (k === "description" && opts.descriptionAtHandOver) {
      out.push(`LATER  ${k.padEnd(15)} set by the door when the vault is handed to its owner; not compared here`);
      continue;
    }
    const same = a.digests[k] === b.digests[k];
    if (!same) allSame = false;
    let extra = "";
    if (!same) {
      const sa = new Set(a.lines[k]);
      const sb = new Set(b.lines[k]);
      const minus = [...sa].filter((x) => !sb.has(x));
      const plus = [...sb].filter((x) => !sa.has(x));
      let unexplained = minus.length + plus.length;
      extra = ` (${minus.length} only in ${an}, ${plus.length} only in ${bn})`;
      if (k === "notes") {
        const fields = ["id", "path", "extension", "content", "fields", "tags", "created_at", "updated_at"];
        const byId = new Map(plus.map((x) => [JSON.parse(x)[0] as string, JSON.parse(x) as unknown[]]));
        const tally: Record<string, number> = {};
        let ok = 0;
        for (const x of minus) {
          const s = JSON.parse(x) as unknown[];
          const c = byId.get(s[0] as string);
          if (!c) {
            tally.missing = (tally.missing ?? 0) + 1;
            continue;
          }
          const differing = fields.filter((_, i) => JSON.stringify(s[i]) !== JSON.stringify(c[i]));
          for (const f of differing) tally[f] = (tally[f] ?? 0) + 1;
          const may = accept.get(s[0] as string);
          if (may && differing.every((f) => may.has(f))) ok++;
        }
        unexplained -= ok * 2; // one accepted note accounts for its line on each side
        reviewed += ok;
        extra += ` fields differing: ${JSON.stringify(tally)}${ok ? `, ${ok} accepted before the move` : ""}`;
      } else if (k === "bare_types" && opts.dropBareTypes && plus.length === 0) {
        // On 0.8 a type with no fields is a tag: it survives as a name on the notes that carry it. One that is on
        // no note has nowhere to go, and is excused only when that was accepted before the move.
        const kept = new Set(b.lines.tags_in_use);
        const gone = minus.filter((name) => !kept.has(name));
        const excused = opts.dropBareTypes === "and-unused" ? minus.length : minus.length - gone.length;
        reviewed += excused;
        unexplained = minus.length - excused;
        extra += `: ${minus.length - gone.length} type(s) with no fields are tags on 0.8${gone.length ? `; ${gone.length} on no note ${opts.dropBareTypes === "and-unused" ? "are gone (accepted before the move)" : "are gone"}` : ""}`;
      }
      if (unexplained > 0 || minus.length + plus.length === 0) bad++;
    }
    out.push(`${same ? "EQUAL " : "DIFFER"} ${k.padEnd(15)} ${an} ${a.counts[k]} / ${bn} ${b.counts[k]}  ${a.digests[k].slice(0, 16)} vs ${b.digests[k].slice(0, 16)}${extra}`);
  }
  out.push(`not carried by the format: written-by stamps on ${a.counts.attributed_notes} note(s) at ${an}; earlier versions${a.reader === "box-db" ? ` (${a.counts.versions} at ${an})` : ""}`);
  const verdict = allSame ? "DIGEST EQUAL" : bad ? "DIGEST DIFFERS" : "DIGEST EQUAL EXCEPT REVIEWED ITEMS";
  out.push(`${verdict}${verdict === "DIGEST EQUAL EXCEPT REVIEWED ITEMS" ? ` (${reviewed})` : ""} (all: ${a.digests.all.slice(0, 16)} vs ${b.digests.all.slice(0, 16)})`);
  return { verdict, ok: !bad, reviewed, lines: out };
}

/**
 * How much of what was moved is still at a door, for the check before the old copy is deleted. After a move the new
 * door is in use: notes are added, edited and removed there, and none of that is a reason to keep the old copy. A
 * new door that was wiped, reset or lost is. So this counts, by note id: still there, changed, gone, added.
 */
export function stillHolds(moved: Digest, now: Digest): { moved: number; there: number; changed: number; gone: number; added: number; files: { moved: number; there: number } } {
  const id = (line: string) => JSON.parse(line)[0] as string;
  const was = new Map(moved.lines.notes.map((l) => [id(l), l]));
  const is = new Map(now.lines.notes.map((l) => [id(l), l]));
  let there = 0;
  let changed = 0;
  for (const [k, line] of was) {
    if (!is.has(k)) continue;
    there++;
    if (is.get(k) !== line) changed++;
  }
  const files = new Set(now.files.map((f) => `${f.path}\t${f.sha256}`));
  return {
    moved: was.size,
    there,
    changed,
    gone: was.size - there,
    added: [...is.keys()].filter((k) => !was.has(k)).length,
    files: { moved: moved.files.length, there: moved.files.filter((f) => files.has(`${f.path}\t${f.sha256}`)).length },
  };
}
