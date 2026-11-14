// $PARACHUTE_HOME/parachute.yaml: one settings file for the home (T-463, 0.9.3).
//
// Keys built so far (the rest stay where they are; `parachute changes` lists them as planned):
//   server.port                 the hub's port                          env PORT
//   server.bind                 the address the hub binds               env PARACHUTE_BIND_HOST
//   server.origin               the issuer (`iss`) the hub signs with   env PARACHUTE_HUB_ORIGIN
//   server.accepted_issuers     older issuers that stay valid           env PARACHUTE_HUB_ORIGINS (comma-separated)
//   vaults.<name>.description   what the vault serves as its description (vault.yaml's `description`)
//
// Precedence: an env var, then parachute.yaml, then the old files (vault.yaml), then the default.
//
// This module is the one place that reads and writes the file. It has no I/O except `readText` / `writeText` and
// `apply`; later code (doctor --fix writing defaults, an admin API) imports `getSetting`, `setSetting` and
// `unsetSetting` instead of touching the text. The file is a small YAML subset: nested maps by indentation, `key: value`,
// `- item` lists (or `[a, b]`), quoted or plain scalars, `|` block scalars, `#` comments. Anything else is an error that
// names the line. `setSetting` and `unsetSetting` edit the text line by line, so comments and unrelated lines stay;
// only the edited key's own line (and any comment at its end) is rewritten.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FILE_NAME = "parachute.yaml";
export const filePath = (home: string): string => join(home, FILE_NAME);

/** A problem with the file's text or with a key or value; `line` is 1-based when it points into the file. */
export class SettingsError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
    this.name = "SettingsError";
  }
}

// ── known keys ───────────────────────────────────────────────────────────────────────────────────────────────

type Kind = "port" | "host" | "origin" | "origins" | "text";
export interface KeyInfo {
  /** `vaults.<name>.description` for every vault. */
  pattern: string;
  kind: Kind;
  /** The env var that overrides it, if any. */
  env?: string;
  /** What it is when nothing sets it (shown by `get`). */
  default: string;
}

const FIXED: Record<string, KeyInfo> = {
  "server.port": { pattern: "server.port", kind: "port", env: "PORT", default: "1939" },
  "server.bind": { pattern: "server.bind", kind: "host", env: "PARACHUTE_BIND_HOST", default: "127.0.0.1" },
  "server.origin": { pattern: "server.origin", kind: "origin", env: "PARACHUTE_HUB_ORIGIN", default: "(not set: the hub uses the exposed or request origin)" },
  "server.accepted_issuers": { pattern: "server.accepted_issuers", kind: "origins", env: "PARACHUTE_HUB_ORIGINS", default: "(not set)" },
};
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const FIXED_KEYS = Object.keys(FIXED);

/** The key's rules, or undefined when it is not a key this build knows. */
export function keyInfo(key: string): KeyInfo | undefined {
  if (FIXED[key]) return FIXED[key];
  const m = /^vaults\.([^.]+)\.description$/.exec(key);
  if (m && VAULT_NAME.test(m[1]!)) return { pattern: "vaults.<name>.description", kind: "text", default: "(not set)" };
  return undefined;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The error for a key this build does not know, with the nearest known name. */
export function unknownKey(key: string): SettingsError {
  const vault = /^vaults\.([^.]+)\.(.+)$/.exec(key);
  const candidates = vault ? [`vaults.${vault[1]}.description`] : FIXED_KEYS;
  const best = [...candidates].sort((a, b) => distance(key, a) - distance(key, b))[0]!;
  const known = [...FIXED_KEYS, "vaults.<name>.description"].join(", ");
  return new SettingsError(`unknown setting "${key}". Did you mean "${best}"? Known settings: ${known}`);
}

/** A value, checked and in the form the file stores it. Lists come in as an array or as comma-separated text. */
export function checkValue(key: string, raw: string | string[]): string | string[] {
  const info = keyInfo(key);
  if (!info) throw unknownKey(key);
  const one = (): string => {
    if (Array.isArray(raw)) throw new SettingsError(`${key} takes one value, not a list`);
    return raw.trim();
  };
  switch (info.kind) {
    case "port": {
      const v = one();
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new SettingsError(`${key} must be a port from 1 to 65535, not "${v}"`);
      return String(Number(v));
    }
    case "host": {
      const v = one();
      if (!v || /\s/.test(v)) throw new SettingsError(`${key} must be an address or host name such as 127.0.0.1 or 0.0.0.0, not "${v}"`);
      return v;
    }
    case "origin":
      return originOf(key, one());
    case "origins": {
      const items = Array.isArray(raw) ? raw : raw.split(",");
      const out = items.map((i) => i.trim()).filter(Boolean).map((i) => originOf(key, i));
      if (out.length === 0) throw new SettingsError(`${key} needs at least one origin; use "unset" to clear it`);
      return out;
    }
    case "text": {
      const v = one();
      if (!v) throw new SettingsError(`${key} must not be empty; use "unset" to clear it`);
      return v;
    }
  }
}

function originOf(key: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new SettingsError(`${key} must be an origin such as https://hub.example.com or http://127.0.0.1:1939, not "${v}"`);
  }
  if (!/^https?:$/.test(u.protocol) || u.pathname !== "/" || u.search || u.hash || u.username)
    throw new SettingsError(`${key} must be an origin such as https://hub.example.com (http or https, no path), not "${v}"`);
  return u.origin;
}

// ── the file's text ──────────────────────────────────────────────────────────────────────────────────────────

interface Span {
  /** Line index of the key. */
  start: number;
  /** One past the last line that belongs to it (nested lines, list items, block scalar lines). */
  end: number;
  indent: number;
  /** True for a key that only holds other keys (or a list); false for one with an inline value. */
  frame: boolean;
}
export interface Parsed {
  /** Dotted path to value, for every key that has one: a string, or a list of strings. */
  values: Map<string, { value: string | string[]; line: number }>;
  spans: Map<string, Span>;
}

/** Cut a trailing `# comment` (a `#` at the start or after a space, outside quotes). */
function stripComment(s: string): string {
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = "";
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s\[,:]/.test(s[i - 1]!)) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

function scalar(text: string, line: number): string {
  const t = text.trim();
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t);
      if (typeof v === "string") return v;
    } catch {}
    throw new SettingsError(`${FILE_NAME}: line ${line}: a double-quoted value is not closed or has a bad escape: ${t}`, line);
  }
  if (t.startsWith("'")) {
    if (t.length < 2 || !t.endsWith("'")) throw new SettingsError(`${FILE_NAME}: line ${line}: a single-quoted value is not closed: ${t}`, line);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!{]/.test(t) || t.startsWith("[")) throw new SettingsError(`${FILE_NAME}: line ${line}: "${t}" is not supported here`, line);
  return t;
}

function flowList(text: string, line: number): string[] {
  const t = text.trim();
  if (!t.endsWith("]")) throw new SettingsError(`${FILE_NAME}: line ${line}: a [list] is not closed: ${t}`, line);
  const inner = t.slice(1, -1);
  const items: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += inner[++i] ?? "";
      else if (c === q) q = "";
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else cur += c;
  }
  items.push(cur);
  return items.map((i) => i.trim()).filter(Boolean).map((i) => scalar(i, line));
}

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/;
const DOTTED_KEY = /^[A-Za-z0-9_][A-Za-z0-9_-]*\.[A-Za-z0-9_.-]*\s*:/;

/** Parse the text. Throws SettingsError naming the line for anything outside the subset. */
export function parse(text: string): Parsed {
  const lines = text.split(/\r?\n/);
  const values: Parsed["values"] = new Map();
  const spans: Parsed["spans"] = new Map();
  const stack: { key: string; indent: number; path: string; list?: string[] }[] = [];
  let lastSig = -1;
  let prevIndent = -1;
  let prevWasLeaf = false;
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1]!.indent >= indent) {
      const f = stack.pop()!;
      spans.get(f.path)!.end = lastSig + 1;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const rawLine = lines[i]!;
    const body = stripComment(rawLine).replace(/\s+$/, "");
    if (body.trim() === "") continue;
    const lead = /^[ \t]*/.exec(body)![0];
    if (lead.includes("\t")) throw new SettingsError(`${FILE_NAME}: line ${n}: indent with spaces, not tabs`, n);
    const indent = lead.length;
    const content = body.slice(indent);
    if (indent > prevIndent && prevWasLeaf) throw new SettingsError(`${FILE_NAME}: line ${n}: unexpected indentation (the line above already has a value)`, n);
    closeTo(indent);
    if (content === "-" || content.startsWith("- ")) {
      const top = stack[stack.length - 1];
      if (!top || top.indent >= indent) {
        throw new SettingsError(`${FILE_NAME}: line ${n}: a "- item" must sit under a key such as "accepted_issuers:"`, n);
      }
      const hasChildKeys = [...spans.keys()].some((p) => p.startsWith(`${top.path}.`));
      if (hasChildKeys) throw new SettingsError(`${FILE_NAME}: line ${n}: "${top.key}" holds keys, so it cannot also hold a list`, n);
      (top.list ??= []).push(scalar(content.slice(1), n));
      values.set(top.path, { value: top.list, line: spans.get(top.path)!.start + 1 });
      lastSig = i;
      prevIndent = indent;
      prevWasLeaf = false;
      continue;
    }
    if (DOTTED_KEY.test(content)) throw new SettingsError(`${FILE_NAME}: line ${n}: a key cannot contain "." (write it nested: "server:" then an indented "port: …")`, n);
    const m = KEY_LINE.exec(content);
    if (!m) throw new SettingsError(`${FILE_NAME}: line ${n}: expected "key: value", got "${content}"`, n);
    const key = m[1]!;
    const path = [...stack.map((f) => f.key), key].join(".");
    if (spans.has(path)) throw new SettingsError(`${FILE_NAME}: line ${n}: "${key}" appears twice`, n);
    const parent = stack[stack.length - 1];
    if (parent?.list) throw new SettingsError(`${FILE_NAME}: line ${n}: "${parent.key}" holds a list, so it cannot also hold keys`, n);
    const rest = (m[2] ?? "").trim();
    lastSig = i;
    if (rest === "" ) {
      spans.set(path, { start: i, end: i + 1, indent, frame: true });
      stack.push({ key, indent, path });
      prevWasLeaf = false;
    } else if (/^[|>][+-]?$/.test(rest)) {
      if (rest[0] === ">") throw new SettingsError(`${FILE_NAME}: line ${n}: ">" folded text is not supported; use "|" or a quoted string`, n);
      const block: string[] = [];
      const start = i;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === "") {
          block.push("");
          continue;
        }
        const li = /^ */.exec(l)![0].length;
        if (li <= indent) break;
        block.push(l);
        lastSig = j;
      }
      const used = block.slice(0, lastSig - i);
      const strip = Math.min(...used.filter((l) => l !== "").map((l) => /^ */.exec(l)![0].length), Infinity);
      const textValue = used.map((l) => (l === "" ? "" : l.slice(strip))).join("\n").replace(/\n+$/, "");
      i = lastSig;
      spans.set(path, { start, end: i + 1, indent, frame: false });
      values.set(path, { value: textValue, line: n });
      prevWasLeaf = false;
    } else {
      spans.set(path, { start: i, end: i + 1, indent, frame: false });
      values.set(path, { value: rest.startsWith("[") ? flowList(rest, n) : scalar(rest, n), line: n });
      prevWasLeaf = true;
    }
    prevIndent = indent;
  }
  closeTo(0);
  return { values, spans };
}

/** The settings a parsed file holds, checked: a known key with a bad value is an error naming its line. */
export function settingsOf(p: Parsed): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  const all = new Map<string, { value: string | string[]; line: number }>(p.values);
  // A key written with nothing after the colon is an empty value, which the known keys refuse.
  for (const [path, sp] of p.spans) if (sp.frame && !all.has(path) && sp.end === sp.start + 1) all.set(path, { value: "", line: sp.start + 1 });
  for (const [path, { value, line }] of all) {
    if (!keyInfo(path)) continue; // unknown keys are kept for a newer build; they are not an error here
    try {
      out.set(path, checkValue(path, value));
    } catch (err) {
      if (err instanceof SettingsError) throw new SettingsError(`${FILE_NAME}: line ${line}: ${err.message}`, line);
      throw err;
    }
  }
  return out;
}

// ── reading and writing the file ─────────────────────────────────────────────────────────────────────────────

/** The file's text, or "" when the home has none. */
export function readText(home: string): string {
  const f = filePath(home);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

/** Write atomically (a temp file beside it, then rename), mode 0600. */
export function writeText(home: string, text: string): void {
  const f = filePath(home);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Every setting the home's file holds (checked). Empty when there is no file. */
export function loadSettings(home: string): Map<string, string | string[]> {
  return settingsOf(parse(readText(home)));
}

/** One setting from the file, or undefined. */
export function getSetting(home: string, key: string): string | string[] | undefined {
  if (!keyInfo(key)) throw unknownKey(key);
  return loadSettings(home).get(key);
}

const QUOTE_FREE = /^[A-Za-z0-9_./:@+-]+$/;
function render(v: string): string {
  return QUOTE_FREE.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) ? v : JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function entryLines(segs: string[], value: string | string[], indent: number): string[] {
  const pad = (n: number) => " ".repeat(n);
  const out: string[] = [];
  segs.slice(0, -1).forEach((s, i) => out.push(`${pad(indent + 2 * i)}${s}:`));
  const at = indent + 2 * (segs.length - 1);
  const last = segs[segs.length - 1]!;
  if (Array.isArray(value)) {
    out.push(`${pad(at)}${last}:`);
    for (const v of value) out.push(`${pad(at + 2)}- ${render(v)}`);
  } else out.push(`${pad(at)}${last}: ${render(value)}`);
  return out;
}

/** The text with `key` set to `value` (already checked), changing nothing else. */
export function setInText(text: string, key: string, value: string | string[]): string {
  const p = parse(text);
  const segs = key.split(".");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split(/\r?\n/);
  const own = p.spans.get(key);
  if (own) {
    if (own.frame && !p.values.has(key) && own.end > own.start + 1) throw new SettingsError(`${FILE_NAME}: "${key}" holds other keys; edit the file by hand`);
    lines.splice(own.start, own.end - own.start, ...entryLines([segs[segs.length - 1]!], value, own.indent));
    return `${lines.join("\n")}\n`;
  }
  for (let k = segs.length - 1; k >= 1; k--) {
    const anc = p.spans.get(segs.slice(0, k).join("."));
    if (!anc) continue;
    if (!anc.frame || p.values.has(segs.slice(0, k).join(".")))
      throw new SettingsError(`${FILE_NAME}: line ${anc.start + 1}: "${segs.slice(0, k).join(".")}" already has a value, so "${key}" cannot go under it`, anc.start + 1);
    // The parent's children's indent: from its first child line, skipping blank lines and comments (a column-0 comment
    // or a blank line under `server:` says nothing about where children go).
    let first: string | undefined;
    for (let j = anc.start + 1; j < anc.end; j++) {
      const t = lines[j]!.trim();
      if (t !== "" && !t.startsWith("#")) { first = lines[j]; break; }
    }
    const childIndent = first ? /^ */.exec(first)![0].length : anc.indent + 2;
    lines.splice(anc.end, 0, ...entryLines(segs.slice(k), value, childIndent));
    return `${lines.join("\n")}\n`;
  }
  lines.push(...entryLines(segs, value, 0));
  return `${lines.join("\n")}\n`;
}

/** The text without `key`, and without any parent left empty by it. Unchanged when the key is not there. */
export function unsetInText(text: string, key: string): string {
  let cur = text;
  let p = parse(cur);
  const own = p.spans.get(key);
  if (!own) return text;
  const lines = cur.replace(/\n$/, "").split(/\r?\n/);
  lines.splice(own.start, own.end - own.start);
  cur = lines.length ? `${lines.join("\n")}\n` : "";
  const segs = key.split(".");
  for (let k = segs.length - 1; k >= 1; k--) {
    p = parse(cur);
    const anc = p.spans.get(segs.slice(0, k).join("."));
    if (!anc || !anc.frame || anc.end !== anc.start + 1) break;
    const l = cur.replace(/\n$/, "").split(/\r?\n/);
    l.splice(anc.start, 1);
    cur = l.length ? `${l.join("\n")}\n` : "";
  }
  return cur;
}

/** Set one setting in the home's file (value checked first). Returns the value as stored. */
export function setSetting(home: string, key: string, raw: string | string[]): string | string[] {
  const value = checkValue(key, raw);
  const text = readText(home);
  parse(text); // refuse to edit a file that is already broken: the error names its line
  const next = setInText(text, key, value);
  // Never write a file this module cannot read back to what was asked.
  const back = settingsOf(parse(next)).get(key);
  if (JSON.stringify(back) !== JSON.stringify(value)) throw new SettingsError(`could not write ${key} so that it reads back; the file was not changed`);
  writeText(home, next);
  return value;
}

/** Remove one setting. Returns whether it was there. */
export function unsetSetting(home: string, key: string): boolean {
  if (!keyInfo(key)) throw unknownKey(key);
  const text = readText(home);
  const next = unsetInText(text, key);
  if (next === text) return false;
  settingsOf(parse(next)); // the result must still read
  writeText(home, next);
  return true;
}

/** Notes on keys under `server` or `vaults.<name>` that no setting uses (a misspelling), each with the nearest name. */
export function fileWarnings(text: string): string[] {
  const p = parse(text);
  const out: string[] = [];
  for (const [path, sp] of p.spans) {
    const segs = path.split(".");
    const leafLevel = (segs[0] === "server" && segs.length === 2) || (segs[0] === "vaults" && segs.length === 3);
    if (!leafLevel || keyInfo(path)) continue;
    const msg = unknownKey(path).message.replace(/ Known settings:.*$/, "");
    out.push(`${FILE_NAME}: line ${sp.start + 1}: ${msg}; ignored`);
  }
  return out;
}
