/** Offline git-history import. Git objects are data; no working tree is checked out. */
import { Database, SQLiteError } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isNoteIdShape } from "../core/src/ulid.ts";
import { applyImportedNote, beginImportRun, canonicalJson, importObservationDigest, importTargetDigest, readImportReceipt, type ImportedObservation, type ImportRun } from "../core/src/history-import.ts";
import { hashContent, resolveHistoryPolicy, VERSION_MAX_BYTES, type HistoryPolicy } from "../core/src/history.ts";
import { FLOW_QUOTING_SINCE, fromExportedAttachmentLinks, parseFrontmatter } from "../core/src/portable-md.ts";
import { applyConnectionPragmas, initSchema } from "../core/src/schema.ts";
import { DEFAULT_PORT, readGlobalConfig, readVaultConfig, vaultDbPath, vaultDir } from "./config.ts";
import { checkHealth } from "./health.ts";
import { defaultMirrorConfig, historyImportRecoveryPath, historyMirrorStatePath, mirrorConfigPath, readHistoryMirrorPhase, readMirrorConfigForVault, serializeMirrorConfig } from "./mirror-config.ts";

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_COMMITS = 100_000;
const MAX_OBJECTS = 10_000_000;
/** The ceiling `--max-tree-entries` accepts. The walk holds one tree at a time, so a higher count costs time, not memory. */
const MAX_OBJECTS_CEILING = 1_000_000_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
class GitArchiveError extends Error {}
function git(repo: string, args: string[]): Buffer {
  const environment = { ...process.env };
  // A caller's GIT_DIR/object/config variables must not redirect the private bundle reader.
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-C", repo, ...args], {
    encoding: "buffer", maxBuffer: MAX_OUTPUT,
    env: { ...environment, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error || result.status !== 0) throw new GitArchiveError(`Git ${args[0]} failed; verify complete local archive (${result.error?.message ?? result.status})`);
  return result.stdout;
}
function text(bytes: Uint8Array): string { return decoder.decode(bytes); }
function object(repo: string, hash: string): string {
  const size = Number(text(git(repo, ["cat-file", "-s", hash])).trim());
  if (!Number.isSafeInteger(size) || size > VERSION_MAX_BYTES + 256_000) throw new Error("oversized_object");
  return text(git(repo, ["cat-file", "blob", hash]));
}
function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_metadata");
  return value as Record<string, unknown>;
}
function yaml(raw: string): Record<string, unknown> { return mapping(Bun.YAML.parse(raw)); }
/** The staging reader's version, bound into the options digest. 1: strict YAML only. 2: export scalars read as the vault's import reads them ({@link readExportScalars}), and {@link statedId}. */
const PARSER = 2;
function parserVersion(value: unknown): 1 | 2 {
  if (value === undefined) return 1; // a manifest written before the field existed: the one way to say parser 1
  if (value !== PARSER) throw new Error("Unsupported manifest parser version");
  return PARSER;
}
/** A `key: value` or `key:` line: the lead (indent, an optional `- `), then a quoted key or a bare one (up to its first `: `), then the colon and the value. */
const KEY_LINE = /^(\s*(?:- )?)(?:('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")|((?![\s#'"])(?:(?!: ).)+?))(?::( .*)?)$/;
/** A bare key strict YAML can't read as a key: it starts with an indicator, or holds a quote. */
const SPECIAL_BARE_KEY = /^[-?:&*!|>%@`\[\]{},]|['"]/;
/**
 * Read an export's scalars the way the vault's own import reads them.
 *
 * An export never holds a non-empty flow collection, and before `FLOW_QUOTING_SINCE` (portable-md.ts) the exporter
 * wrote a string as it stood unless its `needsQuote` asked otherwise, which it did not for a leading `[ ] { } , ' "`.
 * So in a mirror commit `link: [[Projects/Alpha]]` is the string, not a nested list; `title: 'single'` from the old
 * exporter is the six-character string with its quotes; and `saying: 'made up' and more` is not YAML at all. Core's
 * import reader knows all three (`parseFrontmatter`'s "export" and "old-export" readings). This asks that reader for
 * each such value, one `key: value` or `- value` line at a time, and writes the string it returns as a double-quoted
 * scalar, which strict YAML reads back as exactly that text. It returns the rewritten block and the strings it
 * wrote; {@link frontmatter} decides whether the rewrite may stand. A bare key that strict YAML cannot read as a key
 * (`it's`, `@at`, `[x]`, `-dash`, from the exporter before #75) is requoted the same way.
 *
 * `reading` is "old-export" when the first commit that holds the file was made before `FLOW_QUOTING_SINCE` (only
 * the old exporter existed), else "export". A box that kept the old exporter for a while after that date can still
 * have written `'word'` meaning the quoted string; that shape, in that window, is read as today's exporter means it.
 * See UPGRADING.md.
 */
export function readExportScalars(block: string, reading: "export" | "old-export"): { text: string; values: Set<string>; keysOnly: string | undefined } {
  const values = new Set<string>();
  // A bare key opening with `[` or `{` is a flow collection to strict YAML, which still parses (`[x]: v` keys "x",
  // `{y}: v` keys "[object Object]"), so strict YAML's reading of the block as it stands can't be the one to compare
  // with. `keysOnly` is the block with just those keys requoted and every value line as written: strict YAML's
  // reading of that is the comparison, so the check still covers every other line.
  let flowKey = false;
  const keysOnlyLines: string[] = [];
  const text = block.split("\n").map(raw => {
    keysOnlyLines.push(raw);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const keyed = KEY_LINE.exec(line);
    if (keyed) {
      const [, lead, quotedKey, bareKey, colonValue] = keyed;
      const inItem = lead!.endsWith("- ");
      // A bare key that is YAML syntax or holds a quote (`it's`, `@at`, `[x]`, `-dash`) is not a key to strict YAML: the
      // exporter before #75 wrote them as they stood. Quote it. In a list item a leading quote or bracket is the item's
      // own value (`- [a: b]`), not a key.
      const bare = bareKey !== undefined && !(inItem && /^[\[{'"]/.test(bareKey)) ? bareKey : undefined;
      if (quotedKey !== undefined || bare !== undefined) {
        const key = quotedKey ?? (SPECIAL_BARE_KEY.test(bare!) ? JSON.stringify(bare) : bare!);
        if (bare !== undefined && /^[\[{]/.test(bare)) {
          flowKey = true;
          keysOnlyLines[keysOnlyLines.length - 1] = `${lead}${JSON.stringify(bare)}:${colonValue ?? ""}`;
        }
        if (colonValue === undefined) return key === bare ? raw : `${lead}${key}:`;
        const value = colonValue.slice(1);
        let out = value;
        if (/^['"\[{]/.test(value)) {
          const read = parseFrontmatter(`---\nx: ${value}\n---\n`, reading).frontmatter.x;
          if (typeof read === "string") { values.add(read); out = JSON.stringify(read); }
        }
        return out === value && key === (quotedKey ?? bare) ? raw : `${lead}${key}: ${out}`;
      }
    }
    const item = /^(\s*- )(['"\[{].*)$/.exec(line);
    if (!item) return raw;
    const [, lead, value] = item;
    const read = parseFrontmatter(`---\nx: ${value}\n---\n`, reading).frontmatter.x;
    if (typeof read !== "string") return raw;
    values.add(read);
    return `${lead}${JSON.stringify(read)}`;
  }).join("\n");
  return { text, values, keysOnly: flowKey ? keysOnlyLines.join("\n") : undefined };
}
/**
 * Whether `read` (the rewritten block, parsed) differs from `strict` (the block as plain YAML reads it) ONLY where a
 * rewritten value now stands. A line is one value only in what the exporter writes; in a hand-written file the same
 * text can sit inside a block scalar, a folded string or a multi-line flow, and rewriting it there changes something
 * that is not one of the values written. Then the rewrite does not stand.
 */
function accountsFor(read: unknown, strict: unknown, values: Set<string>): boolean {
  if (typeof read === "string" && values.has(read)) return true;
  if (Array.isArray(read)) return Array.isArray(strict) && read.length === strict.length && read.every((item, i) => accountsFor(item, strict[i], values));
  if (read !== null && typeof read === "object" && !(read instanceof Date)) {
    if (strict === null || typeof strict !== "object" || Array.isArray(strict) || strict instanceof Date) return false;
    const a = Object.keys(read), b = Object.keys(strict as object);
    return a.length === b.length && a.every(k => k in (strict as object) && accountsFor((read as Record<string, unknown>)[k], (strict as Record<string, unknown>)[k], values));
  }
  return canonicalJson({ v: read }) === canonicalJson({ v: strict });
}
/** A line that opens a block scalar (`key: |`, `- >-`, `key: !!str |2`, with or without a comment) with deeper lines under it. */
function holdsBlockScalar(block: string): boolean {
  const lines = block.split("\n"), indent = (line: string) => line.length - line.trimStart().length;
  const header = /^[ \t]*(?:(?:-|\?)[ \t]+)*(?:(?:[^\s#]|\S#)(?:[^#]|\S#)*?:[ \t]+)?(?:[!&][^ \t]*[ \t]+)*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?\r?$/;
  return lines.some((line, i) => {
    if (!header.test(line)) return false;
    const next = lines.slice(i + 1).find(l => l.trim() !== "");
    return next !== undefined && indent(next) > indent(line);
  });
}
/** The one top-level `id:` line of a block that will not parse, when it names a note: so the failure quarantines that note instead of being an unidentified issue. */
function statedId(block: string): string | undefined {
  const ids = block.split(/\r?\n/).filter(line => /^id:(?:\s|$)/.test(line)).map(line => line.slice(3).trim());
  return ids.length === 1 && isNoteIdShape(ids[0]) ? ids[0] : undefined;
}
class UnreadableFrontmatter extends Error {
  constructor(readonly noteId: string) { super("unreadable_frontmatter"); }
}
/**
 * Parser 2: strict YAML over the block with its export scalars read as the vault's import reads them, when that
 * rewrite is accounted for; otherwise strict YAML alone.
 *   - Nothing to rewrite: strict YAML.
 *   - The block is YAML as it stands: the rewrite stands only if the block holds no block scalar that
 *     {@link holdsBlockScalar} can see and the two readings have the same shape, differing only where the rewritten
 *     reading holds one of the strings written ({@link accountsFor}). Otherwise the file was not written by the
 *     exporter, and strict YAML's reading is kept.
 *   - The block is not YAML as it stands (the old exporter's bare leading quote): there is no reading to compare
 *     with, so a block in which a block scalar is seen is refused rather than trusted, and any other is read rewritten.
 * Both checks are exact for what an exporter writes (one value per line, no block scalars); for a hand-written file
 * they are a best effort, and such a file is read as an export.
 * A block that fails names its note when it can ({@link statedId}).
 */
function frontmatter(block: string, parser: 1 | 2, reading: "export" | "old-export"): Record<string, unknown> {
  if (parser === 1) return yaml(block);
  const refuse = (cause: unknown): never => {
    const id = statedId(block);
    if (id !== undefined) throw new UnreadableFrontmatter(id);
    throw cause;
  };
  const { text, values, keysOnly } = readExportScalars(block, reading);
  let strict: Record<string, unknown> | undefined, strictError: unknown;
  try { strict = yaml(block); } catch (error) { strictError = error; }
  if (text === block) return strict ?? refuse(strictError);
  let read: Record<string, unknown>;
  try { read = yaml(text); } catch (error) { return strict ?? refuse(error); }
  // A block scalar means no exporter wrote this file: YAML's own reading, whatever the rewrite came to.
  // A bare `[x]`/`{y}` key: strict YAML read it as a flow collection, so its reading is wrong where the key is. Compare
  // with its reading of the block with only those keys requoted instead, so every other line is still checked.
  if (strict !== undefined) {
    if (holdsBlockScalar(block)) return strict;
    let basis = strict;
    if (keysOnly !== undefined) { try { basis = yaml(keysOnly); } catch { return strict; } }
    // When the rewrite does not stand, that reading (keys right, values as plain YAML has them) is the answer.
    return accountsFor(read, basis, values) ? read : basis;
  }
  if (holdsBlockScalar(block)) return refuse(strictError);
  return read;
}
/** The parser-2 reading of one frontmatter block, for tools that measure it against a mirror. */
export function parseExportFrontmatter(block: string, reading: "export" | "old-export"): Record<string, unknown> { return frontmatter(block, 2, reading); }
function inline(raw: string, parser: 1 | 2, reading: "export" | "old-export"): { meta: Record<string, unknown>; content: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(raw);
  if (!match || match.index !== 0) throw new Error("missing_frontmatter");
  return { meta: frontmatter(match[1]!, parser, reading), content: raw.slice(match[0].length) };
}
function observation(meta: Record<string, unknown>, content: string, commit: string, blob: string, time: string): { id: string; row: ImportedObservation } {
  if (!isNoteIdShape(meta.id)) throw new Error("invalid_id");
  if (Buffer.byteLength(content) > VERSION_MAX_BYTES) throw new Error("oversized_body");
  const path = meta.path ?? null, extension = meta.extension ?? "md", created = meta.created_at ?? null;
  if (path !== null && (typeof path !== "string" || path.includes("\0") || path.split("/").includes(".."))) throw new Error("invalid_path");
  if (typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension)) throw new Error("invalid_extension");
  if (created !== null && (typeof created !== "string" || !Number.isFinite(Date.parse(created)))) throw new Error("invalid_created_at");
  return { id: meta.id, row: { content, path, extension, created_at: created, metadata: meta.metadata === undefined ? {} : mapping(meta.metadata), observed_at: time, commit, blob } };
}
export interface HistoryCandidateRef { git_path: string; blob: string; sidecar?: { git_path: string; blob: string }; }
export interface HistorySelection {
  /** `through` (optional) is a later commit on the walk: the entry then stands for every tree from `commit` to it, each of which must hold exactly this candidate set. */
  note_id: string; commit: string; through?: string; selected: HistoryCandidateRef;
  rejected: (HistoryCandidateRef & { reason: string })[]; reason: string;
}
export interface HistorySelections { format: 1; tip: string; source_fingerprint: string; selections: HistorySelection[]; }
/** A file that is not a note (no id, no sidecar) which the operator has audited: exactly this path holding exactly this blob is passed over, in any tree. */
export interface HistoryIgnoredFile { git_path: string; blob: string; reason: string; }
export interface HistoryIgnoredFiles { format: 1; tip: string; source_fingerprint: string; files: HistoryIgnoredFile[]; }
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function selectionObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error("Invalid selections object");
  return input as Record<string, unknown>;
}
function selectionReason(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("Selections require audit reasons");
  return input;
}
function candidateRef(input: unknown, rejected = false): HistoryCandidateRef {
  const value = selectionObject(input, rejected ? ["git_path", "blob", "sidecar", "reason"] : ["git_path", "blob", "sidecar"]);
  if (typeof value.git_path !== "string" || !value.git_path || value.git_path.startsWith("/") || value.git_path.includes("\0") || value.git_path.split("/").some(p => p === ".." || p === "." || !p) || typeof value.blob !== "string" || !OBJECT_ID.test(value.blob)) throw new Error("Invalid selection candidate reference");
  const ref: HistoryCandidateRef = { git_path: value.git_path, blob: value.blob };
  if (value.sidecar !== undefined) {
    selectionObject(value.sidecar, ["git_path", "blob"]);
    ref.sidecar = candidateRef(value.sidecar);
  }
  return ref;
}
/** Canonical ordering makes options independent of selector/rejected array order. */
export function normalizeHistorySelections(input: unknown): HistorySelections {
  const value = selectionObject(input, ["format", "tip", "source_fingerprint", "selections"]);
  if (value.format !== 1 || typeof value.tip !== "string" || !OBJECT_ID.test(value.tip) || typeof value.source_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.source_fingerprint) || !Array.isArray(value.selections) || value.selections.length > 100_000) throw new Error("Invalid selections header or entry limit (100,000)");
  const seen = new Set<string>();
  const selections = value.selections.map(raw => {
    const entry = selectionObject(raw, ["note_id", "commit", "through", "selected", "rejected", "reason"]);
    if (!isNoteIdShape(entry.note_id) || typeof entry.commit !== "string" || !OBJECT_ID.test(entry.commit) || !Array.isArray(entry.rejected) || !entry.rejected.length) throw new Error("Invalid selection entry");
    if (entry.through !== undefined && (typeof entry.through !== "string" || !OBJECT_ID.test(entry.through))) throw new Error("Invalid selection range end");
    const key = `${entry.note_id}:${entry.commit}`;
    if (seen.has(key)) throw new Error("Duplicate selection note/commit");
    seen.add(key);
    const selected = candidateRef(entry.selected), paths = new Set([selected.git_path]);
    const rejected = entry.rejected.map(raw => {
      const ref = candidateRef(raw, true);
      if (paths.has(ref.git_path)) throw new Error("Duplicate selection candidate path");
      paths.add(ref.git_path);
      return { ...ref, reason: selectionReason((raw as Record<string, unknown>).reason) };
    }).sort((a, b) => compareText(canonicalJson(candidateRef(a, true)), canonicalJson(candidateRef(b, true))));
    // A range of one tree is the plain entry: one canonical form, one digest.
    return { note_id: entry.note_id, commit: entry.commit, ...(entry.through !== undefined && entry.through !== entry.commit ? { through: entry.through as string } : {}), selected, rejected, reason: selectionReason(entry.reason) };
  }).sort((a, b) => compareText(`${a.note_id}:${a.commit}`, `${b.note_id}:${b.commit}`));
  const result: HistorySelections = { format: 1, tip: value.tip, source_fingerprint: value.source_fingerprint, selections };
  if (Buffer.byteLength(canonicalJson(result)) > MAX_OUTPUT) throw new Error("Selections exceed 32 MiB");
  return result;
}
function selectionsDigest(selections: HistorySelections | null): string | null { return selections ? hashContent(canonicalJson(selections)) : null; }
/** Canonical ordering; one pin per path and blob, each with an audit reason. */
export function normalizeHistoryIgnoredFiles(input: unknown): HistoryIgnoredFiles {
  const value = selectionObject(input, ["format", "tip", "source_fingerprint", "files"]);
  if (value.format !== 1 || typeof value.tip !== "string" || !OBJECT_ID.test(value.tip) || typeof value.source_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.source_fingerprint) || !Array.isArray(value.files) || !value.files.length || value.files.length > 100_000) throw new Error("Invalid ignore-files header or entry limit (100,000)");
  const seen = new Set<string>();
  const files = value.files.map(raw => {
    const ref = candidateRef(selectionObject(raw, ["git_path", "blob", "reason"]), true);
    if (ref.sidecar) throw new Error("Invalid ignore-files entry");
    const key = `${ref.git_path}\0${ref.blob}`;
    if (seen.has(key)) throw new Error("Duplicate ignore-files entry");
    seen.add(key);
    return { git_path: ref.git_path, blob: ref.blob, reason: selectionReason((raw as Record<string, unknown>).reason) };
  }).sort((a, b) => compareText(`${a.git_path}\0${a.blob}`, `${b.git_path}\0${b.blob}`));
  const result: HistoryIgnoredFiles = { format: 1, tip: value.tip, source_fingerprint: value.source_fingerprint, files };
  if (Buffer.byteLength(canonicalJson(result)) > MAX_OUTPUT) throw new Error("Ignore-files exceed 32 MiB");
  return result;
}
function ignoredDigest(ignored: HistoryIgnoredFiles | null): string | null { return ignored ? hashContent(canonicalJson(ignored)) : null; }
/** The parser version is the manifest's own (`parser`, absent = 1), so a run prepared before parser 2 still resumes and retires as it was staged. */
function optionsDigest(policy: HistoryPolicy, waivers: Record<string, string>, selections: HistorySelections | null, maxTreeEntries: number = MAX_OBJECTS, ignored: HistoryIgnoredFiles | null = null, parser: 1 | 2 = PARSER): string {
  return hashContent(canonicalJson({ parser, policy, waivers, ...(selections ? { selections_digest: selectionsDigest(selections) } : {}), ...(maxTreeEntries !== MAX_OBJECTS ? { max_tree_entries: maxTreeEntries } : {}), ...(ignored ? { ignored_files_digest: ignoredDigest(ignored) } : {}) }));
}
function treeEntryLimit(value: unknown): number {
  if (value === undefined || value === null) return MAX_OBJECTS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_OBJECTS_CEILING) throw new Error(`--max-tree-entries must be a whole number from 1 to ${MAX_OBJECTS_CEILING}`);
  return value;
}

export interface StagedArchive { source_fingerprint: string; tip: string; commits: number; objects: number; bytes: number; /** Tree entries passed over by `--ignore-files`; absent when none were given. */ ignored_entries?: number; }
/** Disk-backed staging bounds memory to one git tree and one note body. */
export function stageArchive(repo: string, tip: string, stage: Database, inputSelections?: HistorySelections | null, maxTreeEntries = MAX_OBJECTS, inputIgnored?: HistoryIgnoredFiles | null, parser: 1 | 2 = PARSER): StagedArchive {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip)) throw new Error("through must be a full commit hash");
  if (text(git(repo, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") throw new Error("Shallow archives are not supported");
  if (text(git(repo, ["rev-parse", `${tip}^{commit}`])).trim() !== tip) throw new Error("Tip is not a commit");
  git(repo, ["rev-list", "--objects", "--missing=error", tip]);
  const commits = text(git(repo, ["log", "--first-parent", "--reverse", "--format=%H %T %cI", tip])).trim().split("\n");
  if (commits.length > MAX_COMMITS) throw new Error("Archive commit limit exceeded");
  const selections = inputSelections == null ? null : normalizeHistorySelections(inputSelections);
  if (selections && selections.tip !== tip) throw new Error("Selections tip differs from archive");
  const seqOf = new Map(commits.map((c, seq) => [c.split(" ")[0]!, seq]));
  // Each entry stands for the trees from `commit` through `through` (itself when absent). Ranges are indexed by where
  // they start and end, so a long-lived duplicate costs one entry, not one per commit.
  const startsAt = new Map<number, HistorySelection[]>(), endsAt = new Map<number, string[]>(), lastEnd = new Map<string, number>();
  const ordered = [...(selections?.selections ?? [])].map(selection => {
    const start = seqOf.get(selection.commit), end = seqOf.get(selection.through ?? selection.commit);
    if (start === undefined || end === undefined) throw new Error("Selection commit is not on the first-parent walk");
    if (end < start) throw new Error("Selection range ends before it starts");
    return { selection, start, end };
  }).sort((a, b) => a.start - b.start);
  for (const { selection, start, end } of ordered) {
    if ((lastEnd.get(selection.note_id) ?? -1) >= start) throw new Error("Selection ranges overlap for one note");
    lastEnd.set(selection.note_id, end);
    startsAt.set(start, [...(startsAt.get(start) ?? []), selection]);
    endsAt.set(end, [...(endsAt.get(end) ?? []), selection.note_id]);
  }
  const requested = new Map<string, HistorySelection>();
  const ignored = inputIgnored == null ? null : normalizeHistoryIgnoredFiles(inputIgnored);
  if (ignored && ignored.tip !== tip) throw new Error("Ignore-files tip differs from archive");
  const ignoredPins = new Map((ignored?.files ?? []).map(f => [`${f.git_path}\0${f.blob}`, 0]));
  let ignoredEntries = 0;
  stage.exec("CREATE TABLE selection_failures(note_id TEXT, commit_id TEXT, reason TEXT); CREATE TABLE observations(note_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(note_id,seq)); CREATE TABLE quarantine(note_id TEXT PRIMARY KEY, reason TEXT NOT NULL); CREATE TABLE issues(commit_id TEXT, path TEXT, reason TEXT); CREATE TABLE tip_ids(note_id TEXT PRIMARY KEY); CREATE TABLE object_cache(hash TEXT PRIMARY KEY, content TEXT NOT NULL); CREATE TABLE parsed_cache(hash TEXT PRIMARY KEY, note_id TEXT NOT NULL, state TEXT NOT NULL, row_json TEXT NOT NULL)");
  const fingerprint = createHash("sha256");
  let objects = 0, bytes = 0;
  const lastStates = new Map<string, string>();
  const firstReading = new Map<string, "export" | "old-export">(); // frontmatter blob -> how its first commit reads it
  const identities = new Set<string>();
  const parsedGet = stage.prepare("SELECT note_id,state FROM parsed_cache WHERE hash=?");
  const parsedBody = stage.prepare("SELECT row_json FROM parsed_cache WHERE hash=?");
  const parsedPut = stage.prepare("INSERT OR IGNORE INTO parsed_cache VALUES(?,?,?,?)");
  const insertObservation = stage.prepare("INSERT INTO observations VALUES(?,?,?,?)");
  const markQuarantine = stage.prepare("INSERT OR IGNORE INTO quarantine VALUES(?,?)");
  const markTip = stage.prepare("INSERT OR IGNORE INTO tip_ids VALUES(?)");
  for (let seq = 0; seq < commits.length; seq++) {
    const [commit, tree, time] = commits[seq]!.split(" ");
    if (!commit || !tree || !time || !Number.isFinite(Date.parse(time))) throw new Error("Invalid commit record");
    fingerprint.update(`${commit} ${tree}\n`);
    // A file is read by the commit that first held those bytes: that is the exporter that wrote them. A later
    // commit that still holds the same blob must not read it another way (a sidecar is parsed again in every
    // commit; an unchanged one read two ways would look like a change on the day the exporter's rule changed).
    const commitReading = Date.parse(time) < Date.parse(FLOW_QUOTING_SINCE) ? "old-export" as const : "export" as const;
    const readingFor = (hash: string) => { let r = firstReading.get(hash); if (!r) firstReading.set(hash, r = commitReading); return r; };
    const entries = text(git(repo, ["ls-tree", "-rz", "--full-tree", commit])).split("\0").filter(Boolean).map(record => {
      const tab = record.indexOf("\t"), [mode, type, hash] = record.slice(0, tab).split(" ");
      if (tab < 0 || !hash) throw new Error("Invalid tree record");
      return { mode, type, hash, path: record.slice(tab + 1) };
    });
    objects += entries.length;
    if (objects > maxTreeEntries) throw new Error("Archive object limit exceeded; an audited archive can raise it with --max-tree-entries on plan and prepare");
    const files = new Map(entries.map(e => [e.path, e]));
    const used = new Set<string>(), sidecarOwners = new Map<string, string>();
    const candidates = new Map<string, { ref: HistoryCandidateRef; state: string; row: () => ImportedObservation }[]>();
    const read = (entry: typeof entries[number]) => {
      if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error("unsupported_tree_entry");
      const cached = stage.prepare("SELECT content FROM object_cache WHERE hash=?").get(entry.hash) as { content: string } | null;
      if (cached) return cached.content;
      const value = object(repo, entry.hash); bytes += Buffer.byteLength(value);
      if (bytes > MAX_BYTES) throw new Error("Archive byte limit exceeded");
      stage.prepare("INSERT INTO object_cache VALUES(?,?)").run(entry.hash, value);
      return value;
    };
    const collect = (id: string, state: string, row: () => ImportedObservation, ref: HistoryCandidateRef) => {
      if (!identities.has(id) && identities.size >= 100_000) throw new Error("Archive note limit exceeded");
      identities.add(id);
      let group = candidates.get(id);
      if (!group) candidates.set(id, group = []);
      group.push({ ref, state, row });
    };
    const parseObservation = (meta: Record<string, unknown>, body: string, entry: typeof entries[number]) => {
      const { id, row } = observation(meta, body, commit, entry.hash, time);
      const state = hashContent(canonicalJson({ content: row.content, path: row.path, metadata: row.metadata, extension: row.extension, created_at: row.created_at }));
      return { id, row, state };
    };
    const accept = (meta: Record<string, unknown>, body: string, entry: typeof entries[number], sidecar: { git_path: string; blob: string }) => {
      const { id, row, state } = parseObservation(meta, body, entry);
      const cacheKey = `${entry.hash}:${sidecar.blob}`;
      parsedPut.run(cacheKey, id, state, JSON.stringify(row));
      collect(id, state, () => JSON.parse((parsedBody.get(cacheKey) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash, sidecar });
    };
    const failure = (entry: typeof entries[number], error: unknown, id?: unknown) => {
      // Staging/cache failures are operational, not evidence of malformed source.
      // Abort so no diagnostic manifest can bless an incomplete archive walk.
      if (error instanceof SQLiteError) throw error;
      const message = error instanceof Error ? error.message : "invalid_observation";
      const reason = /^[a-z_]+$/.test(message) ? message : "invalid_metadata_or_utf8";
      if (error instanceof GitArchiveError || message === "Archive byte limit exceeded" || message === "Archive note limit exceeded") throw error;
      if (isNoteIdShape(id)) stage.prepare("INSERT OR REPLACE INTO quarantine VALUES(?,?)").run(id, reason);
      else stage.prepare("INSERT INTO issues VALUES(?,?,?)").run(commit, entry.path, reason);
    };
    const format = files.get(".parachute/vault.yaml");
    if (format) {
      const version = yaml(read(format)).export_format_version;
      // Format 2 (flat fields, `parachute:` block) is read by the vault import, not by history import yet.
      if (version === 2) throw new Error("Unsupported portable export format: this is a format 2 export, and git history import reads format 1 only. Export with the default format to keep history.");
      if (version !== 1) throw new Error("Unsupported portable export format");
    }
    for (const entry of entries.filter(e => /^\.parachute\/notes-meta\/[^/]+\.yaml$/.test(e.path))) {
      let meta: Record<string, unknown> | undefined;
      try {
        meta = frontmatter(read(entry), parser, readingFor(entry.hash));
        const extension = meta.extension;
        if (!isNoteIdShape(meta.id) || typeof extension !== "string") throw new Error("invalid_sidecar");
        const contentPath = `${meta.path ?? `_unpathed/${meta.id}`}.${extension}`;
        const body = files.get(contentPath);
        if (!body) throw new Error("missing_sidecar_body");
        if (extension === "md" || extension === "mdx") throw new Error("unexpected_inline_sidecar");
        const priorOwner = sidecarOwners.get(contentPath);
        if (priorOwner) {
          stage.prepare("INSERT OR REPLACE INTO quarantine VALUES(?,?)").run(priorOwner, "ambiguous_sidecar");
          throw new Error("ambiguous_sidecar");
        }
        sidecarOwners.set(contentPath, meta.id);
        used.add(contentPath);
        accept(meta, read(body), body, { git_path: entry.path, blob: entry.hash });
      } catch (error) { failure(entry, error, meta?.id ?? (error instanceof UnreadableFrontmatter ? error.noteId : entry.path.split("/").pop()?.slice(0, -5))); }
    }
    for (const entry of entries) {
      if (entry.path.startsWith(".parachute/") || entry.path.startsWith(".doctor/") || entry.path === ".gitkeep" || used.has(entry.path)) continue;
      if (!/\.(md|mdx)$/.test(entry.path)) {
        const pin = `${entry.path}\0${entry.hash}`;
        if (ignoredPins.has(pin)) { ignoredPins.set(pin, ignoredPins.get(pin)! + 1); ignoredEntries++; continue; }
        stage.prepare("INSERT INTO issues VALUES(?,?,?)").run(commit, entry.path, "unclassified_file"); continue;
      }
      let meta: Record<string, unknown> | undefined;
      try {
        const cached = parsedGet.get(entry.hash) as { note_id: string; state: string } | null;
        if (cached) {
          collect(cached.note_id, cached.state, () => JSON.parse((parsedBody.get(entry.hash) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash });
        } else {
          const parsed = inline(read(entry), parser, readingFor(entry.hash)); meta = parsed.meta;
          // Mirror commits are exports (T-318 #8): undo the attachment links the
          // export rewrote, so a staged version is the body the vault stored.
          const extension = typeof meta.extension === "string" ? meta.extension : extname(entry.path).slice(1);
          const body = Array.isArray(meta.attachments) ? fromExportedAttachmentLinks(parsed.content, meta.attachments, extension).content : parsed.content;
          const { id, row, state } = parseObservation(meta, body, entry);
          parsedPut.run(entry.hash, id, state, JSON.stringify(row));
          collect(id, state, () => JSON.parse((parsedBody.get(entry.hash) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash });
        }
      } catch (error) { failure(entry, error, meta?.id ?? (error instanceof UnreadableFrontmatter ? error.noteId : undefined)); }
    }
    for (const selection of startsAt.get(seq) ?? []) requested.set(selection.note_id, selection);
    for (const id of [...new Set([...candidates.keys(), ...requested.keys()])].sort()) {
      const group = candidates.get(id) ?? [], selection = requested.get(id);
      if (group.length && seq === commits.length - 1) markTip.run(id);
      let selected = group.length === 1 && !selection ? group[0] : undefined;
      let refusal = selection ? "stale_selection" : "missing_selection";
      if (group.length >= 2 && selection) {
        const actual = group.map(c => canonicalJson(c.ref)).sort();
        const expected = [selection.selected, ...selection.rejected.map(r => candidateRef(r, true))].map(c => canonicalJson(c)).sort();
        if (canonicalJson(actual) === canonicalJson(expected)) selected = group.find(c => canonicalJson(c.ref) === canonicalJson(selection.selected));
        else refusal = "candidate_set_mismatch";
      }
      if (!selected) {
        markQuarantine.run(id, "duplicate_id");
        if (selections) stage.prepare("INSERT INTO selection_failures VALUES(?,?,?)").run(id, commit, refusal);
        continue;
      }
      if (lastStates.get(id) === selected.state) continue;
      if (!lastStates.has(id) && lastStates.size >= 100_000) throw new Error("Archive note limit exceeded");
      lastStates.set(id, selected.state);
      insertObservation.run(id, seq, selected.state, JSON.stringify({ ...selected.row(), commit, observed_at: time }));
    }
    for (const id of endsAt.get(seq) ?? []) requested.delete(id);
  }
  const sourceFingerprint = fingerprint.digest("hex");
  if (selections && selections.source_fingerprint !== sourceFingerprint) throw new Error("Selections source fingerprint differs from archive");
  if (ignored && ignored.source_fingerprint !== sourceFingerprint) throw new Error("Ignore-files source fingerprint differs from archive");
  // An audited pin is exact: one that matched no tree is a mistake in the audit, not something to carry.
  if ([...ignoredPins.values()].some(n => n === 0)) throw new Error("An ignore-files entry matches no file in the archive");
  stage.exec("DELETE FROM observations WHERE note_id IN (SELECT note_id FROM quarantine)");
  return { source_fingerprint: sourceFingerprint, tip, commits: commits.length, objects, bytes, ...(ignored ? { ignored_entries: ignoredEntries } : {}) };
}

interface PlannedNote { id: string; target_digest: string; state_digest: string; native_drops: number[]; imported: number; retained: number; pruned_imported: number; pruned_native: number; }
export interface ImportManifest extends StagedArchive {
  format: 1; kind: "diagnostic" | "final"; vault: string; evaluated_at: number; policy: HistoryPolicy;
  archive: string | null; archive_hash: string | null; backup: string | null;
  options_digest: string; target_ids_digest: string; notes: PlannedNote[]; skipped: string[];
  quarantined: { note_id: string; reason: string }[]; issues: { commit_id: string; path: string; reason: string }[];
  selections?: HistorySelections | null; selections_digest?: string | null;
  /** Present only when plan/prepare were given `--ignore-files`; apply restages with this embedded list. */
  ignored_files?: HistoryIgnoredFiles; ignored_files_digest?: string;
  selection_failures?: { note_id: string; commit_id: string; reason: string }[];
  missing_at_tip: string[]; waivers: Record<string, string>; run_id: string;
  /** Present only when plan/prepare raised the walk's bound with `--max-tree-entries`; apply restages under it. */
  max_tree_entries?: number;
  /** The staging reader this manifest was made with; absent in manifests from before parser 2 (read as 1). Apply restages with it. */
  parser?: 1 | 2;
}
function digestManifest(manifest: Omit<ImportManifest, "run_id"> | ImportManifest): string {
  const { run_id: _, ...body } = manifest as ImportManifest;
  return hashContent(canonicalJson(body));
}
function atomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function readOptional(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function copyDatabase(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  try { db.prepare("VACUUM INTO ?").run(target); } finally { db.close(); }
  chmodSync(target, 0o600);
}
function fileHash(path: string): string {
  const fd = openSync(path, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  try {
    for (;;) { const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break; hash.update(chunk.subarray(0, count)); }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

function rowsFor(stage: Database, id: string): ImportedObservation[] {
  const size = stage.prepare("SELECT COALESCE(SUM(length(CAST(row_json AS BLOB))),0) AS bytes FROM observations WHERE note_id=?").get(id) as { bytes: number };
  if (size.bytes > 64 * 1024 * 1024) throw new Error("Per-note staging limit exceeded (64 MiB); no manifest can be applied");
  const rows = stage.prepare("SELECT row_json FROM observations WHERE note_id=? ORDER BY seq").all(id) as { row_json: string }[];
  return rows.map(r => JSON.parse(r.row_json));
}
/** Staging is disposable and rebuilt from the immutable bundle after interruption. */
function openStage(path: string): Database {
  const stage = new Database(path);
  stage.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF");
  return stage;
}
function project(vault: string, repo: string, tip: string, dir: string, opts: { archive?: string; backup?: string; waivers?: Record<string, string>; selections?: HistorySelections | null; maxTreeEntries?: number; ignored?: HistoryIgnoredFiles | null }): ImportManifest {
  const config = readVaultConfig(vault);
  if (!config) throw new Error("Vault does not exist");
  const stage = openStage(join(dir, "stage.db"));
  const copy = join(dir, "projection.db");
  copyDatabase(vaultDbPath(vault), copy);
  const db = new Database(copy);
  try {
    applyConnectionPragmas(db); initSchema(db);
    const selections = opts.selections ?? null;
    const maxTreeEntries = treeEntryLimit(opts.maxTreeEntries);
    const ignored = opts.ignored ?? null;
    const source = stageArchive(repo, tip, stage, selections, maxTreeEntries, ignored), policy = resolveHistoryPolicy(config.history);
    const waivers = opts.waivers ?? {};
    for (const [id, reason] of Object.entries(waivers)) if (!isNoteIdShape(id) || typeof reason !== "string" || !reason.trim()) throw new Error("Waivers require note IDs and reasons");
    const options_digest = optionsDigest(policy, waivers, selections, maxTreeEntries, ignored, PARSER);
    const run = { run_id: "projection", source_fingerprint: source.source_fingerprint, tip, options_digest };
    beginImportRun(db, run);
    const evaluated_at = Date.now(), notes: PlannedNote[] = [], skipped: string[] = [];
    const ids = stage.prepare("SELECT DISTINCT note_id FROM observations ORDER BY note_id").all() as { note_id: string }[];
    for (const { note_id: id } of ids) {
      if (!db.prepare("SELECT 1 FROM notes WHERE id=?").get(id)) { skipped.push(id); continue; }
      if (waivers[id]) continue;
      const rows = rowsFor(stage, id), target_digest = importTargetDigest(db, id);
      const result = applyImportedNote(db, { run, noteId: id, observations: rows, policy, now: evaluated_at, targetDigest: target_digest });
      notes.push({ id, target_digest, state_digest: importObservationDigest(rows), native_drops: result.nativeDrops, imported: rows.length, retained: result.receipt.retained_count, pruned_imported: result.receipt.pruned_imported, pruned_native: result.receipt.pruned_native });
    }
    const live = db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[];
    const missing_at_tip = live.filter(({ id }) => !stage.prepare("SELECT 1 FROM tip_ids WHERE note_id=?").get(id)).map(r => r.id);
    const body: Omit<ImportManifest, "run_id"> = {
      ...source, format: 1, kind: opts.archive ? "final" : "diagnostic", vault, evaluated_at, policy,
      archive: opts.archive ?? null, archive_hash: opts.archive ? fileHash(opts.archive) : null, backup: opts.backup ?? null,
      selections, selections_digest: selectionsDigest(selections),
      selection_failures: stage.prepare("SELECT * FROM selection_failures ORDER BY note_id,commit_id").all() as NonNullable<ImportManifest["selection_failures"]>,
      options_digest, target_ids_digest: hashContent(canonicalJson(live.map(r => r.id))), notes, skipped, missing_at_tip, waivers,
      quarantined: stage.prepare("SELECT * FROM quarantine ORDER BY note_id").all() as ImportManifest["quarantined"],
      issues: stage.prepare("SELECT * FROM issues ORDER BY commit_id,path,reason").all() as ImportManifest["issues"],
      parser: PARSER,
      ...(maxTreeEntries !== MAX_OBJECTS ? { max_tree_entries: maxTreeEntries } : {}),
      ...(ignored ? { ignored_files: ignored, ignored_files_digest: ignoredDigest(ignored)! } : {}),
    };
    return { ...body, run_id: digestManifest(body) };
  } finally { db.close(); stage.close(); }
}
interface Recovery { prior_config: string | null; prior_marker: string | null; backup: string; backup_hash: string; phase: "preparing" | "prepared"; run_id?: string; }
async function offline(): Promise<void> {
  const health = await checkHealth(readGlobalConfig().port || DEFAULT_PORT);
  if (health.status !== "not-listening") throw new Error("Stop the vault daemon before history import; keep it stopped through retire");
}
function privateBundle(archive: string, expected: string, dir: string): string {
  if (fileHash(archive) !== expected) throw new Error("Archive hash mismatch");
  const copy = join(dir, "archive.bundle"); copyFileSync(archive, copy); chmodSync(copy, 0o600);
  if (fileHash(copy) !== expected) throw new Error("Archive changed during copy");
  const repo = join(dir, "objects.git"); mkdirSync(repo);
  git(repo, ["init", "--bare"]);
  git(repo, ["bundle", "verify", copy]);
  git(repo, ["fetch", "--no-tags", "--", copy, "+refs/*:refs/*"]);
  return repo;
}
/**
 * The policy keys that decide what an import keeps. A manifest is checked against the vault's policy on these only,
 * and only on those it carries: a release that adds a key (burst_window_seconds, T-460) or changes how compaction
 * stores what is kept must not strand a run planned before it. `apply` itself always uses the manifest's policy.
 */
const RETENTION_KEYS = ["enabled", "min_versions", "max_versions", "max_age_days", "deleted_retention_days", "max_bytes_per_note"] as const;
export function sameRetention(now: HistoryPolicy, planned: HistoryPolicy): boolean {
  return RETENTION_KEYS.every((k) => !(k in planned) || canonicalJson(now[k]) === canonicalJson(planned[k]));
}
function readManifest(vault: string, path: string): ImportManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as ImportManifest;
  if (m.format !== 1 || m.kind !== "final" || m.vault !== vault || m.run_id !== digestManifest(m) || !m.archive || !m.archive_hash || !m.backup) throw new Error("A matching final manifest is required");
  if (!sameRetention(resolveHistoryPolicy(readVaultConfig(vault)?.history), m.policy)) throw new Error("History policy differs from final manifest");
  const selections = m.selections == null ? null : normalizeHistorySelections(m.selections);
  // One canonical form: the default bound is written by leaving the field out.
  if (m.max_tree_entries !== undefined && treeEntryLimit(m.max_tree_entries) === MAX_OBJECTS) throw new Error("Manifest names the default tree-entry bound; a raised bound only");
  const ignored = m.ignored_files == null ? null : normalizeHistoryIgnoredFiles(m.ignored_files);
  if ((m.ignored_files_digest ?? null) !== ignoredDigest(ignored)) throw new Error("Manifest ignore-files digest mismatch");
  if ((m.selections_digest ?? null) !== selectionsDigest(selections) || m.options_digest !== optionsDigest(m.policy, m.waivers, selections, treeEntryLimit(m.max_tree_entries), ignored, parserVersion(m.parser))) throw new Error("Manifest selection/options digest mismatch");
  return m;
}
function retirementReady(m: ImportManifest): void {
  if (m.issues.length) throw new Error("Unidentified source issues block retirement; resolve the archive before prepare");
  if ([...m.quarantined.map(q => q.note_id), ...m.missing_at_tip].some(id => !m.waivers[id])) throw new Error("Quarantined or uncovered IDs require explicit waivers before prepare");
}
/** Commands are exported to exercise the same offline/raw-DB path as the CLI. */
export async function runHistoryImport(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command || !["plan", "prepare", "apply", "retire", "cancel"].includes(command)) throw new Error("history-import plan|prepare|apply|retire|cancel --vault NAME (see UPGRADING.md)");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!key || !["--vault", "--source", "--through", "--output", "--archive", "--manifest", "--waivers", "--selections", "--max-tree-entries", "--ignore-files"].includes(key) || !value || flags.has(key)) throw new Error("Invalid history-import arguments");
    flags.set(key, value);
  }
  if (flags.has("--selections") && command !== "plan" && command !== "prepare") throw new Error("--selections is only valid for plan/prepare; apply uses the embedded manifest");
  if (flags.has("--ignore-files") && command !== "plan" && command !== "prepare") throw new Error("--ignore-files is only valid for plan/prepare; apply uses the embedded manifest");
  if (flags.has("--max-tree-entries") && command !== "plan" && command !== "prepare") throw new Error("--max-tree-entries is only valid for plan/prepare; apply uses the manifest's bound");
  const maxTreeEntries = flags.has("--max-tree-entries") ? treeEntryLimit(/^\d+$/.test(flags.get("--max-tree-entries")!) ? Number(flags.get("--max-tree-entries")) : NaN) : undefined;
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`Required ${key}`); return value; };
  const vault = required("--vault");
  if (!/^[a-zA-Z0-9_-]+$/.test(vault) || !readVaultConfig(vault)) throw new Error("Unknown vault");
  if (command !== "plan") await offline();
  const dir = mkdtempSync(join(tmpdir(), "history-import-"));
  const lock = join(vaultDir(vault), "history-import.lock");
  let locked = false;
  try {
    if (command !== "plan") {
      if (existsSync(lock)) throw new Error(`Importer lock exists at ${lock}; verify no importer is running before removing only this lock directory, then resume the same manifest`);
      mkdirSync(lock); locked = true; atomic(join(lock, "pid"), String(process.pid));
    }
    if (command === "plan" || command === "prepare") {
      const repo = realpathSync(required("--source")), tip = required("--through"), output = resolve(required("--output"));
      if (existsSync(output)) throw new Error("Manifest output already exists");
      const waivers = flags.has("--waivers") ? mapping(JSON.parse(readFileSync(required("--waivers"), "utf8"))) as Record<string, string> : {};
      let selections: HistorySelections | null = null;
      if (flags.has("--selections")) {
        const path = required("--selections");
        if (statSync(path).size > MAX_OUTPUT) throw new Error("Selections exceed 32 MiB");
        selections = normalizeHistorySelections(JSON.parse(readFileSync(path, "utf8")));
      }
      let ignored: HistoryIgnoredFiles | null = null;
      if (flags.has("--ignore-files")) {
        const path = required("--ignore-files");
        if (statSync(path).size > MAX_OUTPUT) throw new Error("Ignore-files exceed 32 MiB");
        ignored = normalizeHistoryIgnoredFiles(JSON.parse(readFileSync(path, "utf8")));
      }
      if (command === "plan") {
        const m = project(vault, repo, tip, dir, { waivers, selections, maxTreeEntries, ignored }); atomic(output, JSON.stringify(m, null, 2)); return m;
      }
      if (readHistoryMirrorPhase(vault) !== "active" || existsSync(historyImportRecoveryPath(vault))) throw new Error("Existing cutover: resume or cancel using its recovery journal");
      if (text(git(repo, ["rev-parse", "--is-bare-repository"])).trim() !== "true" && text(git(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"])).length) throw new Error("Source working tree is dirty");
      const archive = resolve(required("--archive"));
      if (existsSync(archive)) throw new Error("Archive output already exists");
      const backup = join(vaultDir(vault), `history-before-import-${crypto.randomUUID()}.db`);
      copyDatabase(vaultDbPath(vault), backup);
      const journal: Recovery = { prior_config: readOptional(mirrorConfigPath(vault)), prior_marker: readOptional(historyMirrorStatePath(vault)), backup, backup_hash: fileHash(backup), phase: "preparing" };
      atomic(historyImportRecoveryPath(vault), JSON.stringify(journal));
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "paused", source: repo, tip }));
      const config = readMirrorConfigForVault(vault) ?? defaultMirrorConfig();
      atomic(mirrorConfigPath(vault), serializeMirrorConfig({ ...config, enabled: false }).join("\n") + "\n");
      mkdirSync(dirname(archive), { recursive: true });
      git(repo, ["bundle", "create", archive, "--all"]); chmodSync(archive, 0o600);
      const objects = privateBundle(archive, fileHash(archive), dir);
      const m = project(vault, objects, tip, dir, { archive, backup, waivers, selections, maxTreeEntries, ignored });
      atomic(output, JSON.stringify(m, null, 2));
      atomic(historyImportRecoveryPath(vault), JSON.stringify({ ...journal, phase: "prepared", run_id: m.run_id }));
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "paused", run_id: m.run_id, source: repo, tip }));
      return m;
    }
    const phase = readHistoryMirrorPhase(vault);
    if (command !== "cancel" && phase !== "paused" && !(command === "retire" && phase === "retired")) throw new Error("Vault must be paused for this command");
    const journal = JSON.parse(readFileSync(historyImportRecoveryPath(vault), "utf8")) as Recovery;
    if (command === "cancel") {
      const phase = readHistoryMirrorPhase(vault);
      if (phase === "retired") throw new Error("Only an unfinished preparation can be cancelled");
      const db = new Database(vaultDbPath(vault), { readonly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_import_receipts'").get() && db.prepare("SELECT 1 FROM history_import_receipts LIMIT 1").get()) throw new Error("Receipts exist: resume the same run; cancellation is unavailable");
      } finally { db.close(); }
      if (journal.prior_config === null) {
        if (existsSync(mirrorConfigPath(vault))) renameSync(mirrorConfigPath(vault), `${historyImportRecoveryPath(vault)}.cancelled-config-${crypto.randomUUID()}`);
      } else atomic(mirrorConfigPath(vault), journal.prior_config);
      atomic(historyMirrorStatePath(vault), journal.prior_marker ?? JSON.stringify({ phase: "active" }));
      renameSync(historyImportRecoveryPath(vault), `${historyImportRecoveryPath(vault)}.cancelled-${crypto.randomUUID()}`);
      return { cancelled: true };
    }
    const m = readManifest(vault, required("--manifest"));
    const marker = JSON.parse(readFileSync(historyMirrorStatePath(vault), "utf8"));
    if (marker.run_id !== m.run_id || journal.run_id !== m.run_id) throw new Error("Paused marker/run mismatch");
    const repo = privateBundle(command === "apply" ? resolve(required("--archive")) : m.archive!, m.archive_hash!, dir);
    retirementReady(m);
    const db = new Database(vaultDbPath(vault));
    try {
      applyConnectionPragmas(db); initSchema(db);
      const liveIds = (db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[]).map(r => r.id);
      if (hashContent(canonicalJson(liveIds)) !== m.target_ids_digest) throw new Error(`Live note identities changed; reconcile against ${journal.backup}`);
      const run: ImportRun = { run_id: m.run_id, tip: m.tip, options_digest: m.options_digest, source_fingerprint: m.source_fingerprint };
      if (command === "apply") {
        const stage = openStage(join(dir, "apply-stage.db"));
        try {
          const source = stageArchive(repo, m.tip, stage, m.selections, treeEntryLimit(m.max_tree_entries), m.ignored_files ?? null, parserVersion(m.parser));
          if (source.source_fingerprint !== m.source_fingerprint) throw new Error("Bundle lineage differs from manifest");
          beginImportRun(db, run);
          for (const note of m.notes) {
            const rows = rowsFor(stage, note.id);
            if (importObservationDigest(rows) !== note.state_digest) throw new Error("Staged state differs from manifest");
            try { applyImportedNote(db, { run, noteId: note.id, observations: rows, policy: m.policy, now: m.evaluated_at, targetDigest: note.target_digest, expectedNativeDrops: note.native_drops }); }
            catch (error) { throw new Error(`${(error as Error).message}; resume the same manifest. Pre-import backup: ${journal.backup}`); }
          }
          if (m.notes.some(n => readImportReceipt(db, n.id)?.run_id !== m.run_id)) throw new Error("Incomplete receipt set");
          db.prepare("UPDATE history_import_runs SET status='complete' WHERE run_id=?").run(m.run_id);
          return { run_id: m.run_id, complete: true, notes: m.notes.length };
        } finally { stage.close(); }
      }
      const status = db.prepare("SELECT status FROM history_import_runs WHERE run_id=?").get(m.run_id) as { status: string } | null;
      if (status?.status !== "complete" || m.notes.some(n => readImportReceipt(db, n.id)?.run_id !== m.run_id)) throw new Error("Import is incomplete; resume apply");
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "retired", run_id: m.run_id, archive_hash: m.archive_hash }));
      return { retired: true, run_id: m.run_id };
    } finally { db.close(); }
  } finally { if (locked) rmSync(lock, { recursive: true }); rmSync(dir, { recursive: true, force: true }); }
}
