// launchd agents for `parachute-core takeover` (macOS): a pure reader and writer for XML property lists, and what
// takeover decides from an agent's plist alone. No plutil and no launchctl here; takeover.ts makes those calls.
//
// Only XML plists are read (what Parachute's own agents are, renderManagedLaunchdPlist); a binary one, or anything
// that isn't a well-formed plist, throws, and takeover treats that agent's home as unknown.
import { join } from "node:path";

export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/** The agent label core's own launchd agent gets (parachute-core.service on systemd). */
export const CORE_AGENT = "computer.parachute.core";
/** The old programs' own agent labels (0.7 hub and vault). Any other agent whose program serves the old hub or vault counts too. */
export const OLD_AGENT_LABELS = new Set(["computer.parachute.hub", "computer.parachute.vault"]);
/** The PATH launchd gives an agent whose plist sets none (_PATH_STDPATH). */
export const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    const v = ENTITIES[e];
    if (v === undefined) throw new Error(`plist: unknown entity ${whole}`);
    return v;
  });
}

/** Parse an XML property list (the whole document). Throws on a binary plist or anything not well formed. */
export function parsePlist(text: string): PlistValue {
  if (text.startsWith("bplist")) throw new Error("plist: a binary plist (convert it with `plutil -convert xml1` to read it)");
  let i = 0;
  const skip = () => {
    for (;;) {
      const at = i;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("<?", i)) {
        const end = text.indexOf("?>", i);
        if (end < 0) throw new Error("plist: an unclosed <?…?>");
        i = end + 2;
      } else if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        if (end < 0) throw new Error("plist: an unclosed comment");
        i = end + 3;
      } else if (text.startsWith("<!DOCTYPE", i)) {
        const end = text.indexOf(">", i);
        if (end < 0) throw new Error("plist: an unclosed DOCTYPE");
        i = end + 1;
      }
      if (i === at) return;
    }
  };
  /** The next tag: its name, whether it closes (</x>) and whether it is empty (<x/>). */
  const tag = (): { name: string; close: boolean; empty: boolean } => {
    skip();
    const m = /^<(\/?)([A-Za-z]+)(?:\s+[^<>]*?)?\s*(\/?)>/.exec(text.slice(i, i + 512));
    if (!m) throw new Error(`plist: expected a tag at ${i}`);
    i += m[0].length;
    return { name: m[2]!, close: m[1] === "/", empty: m[3] === "/" };
  };
  /** Text up to </name>, decoded. */
  const body = (name: string): string => {
    const end = text.indexOf(`</${name}>`, i);
    if (end < 0) throw new Error(`plist: no </${name}>`);
    const raw = text.slice(i, end);
    if (raw.includes("<")) throw new Error(`plist: markup inside <${name}>`);
    i = end + name.length + 3;
    return decode(raw);
  };
  const value = (t: { name: string; close: boolean; empty: boolean }): PlistValue => {
    if (t.close) throw new Error(`plist: unexpected </${t.name}>`);
    switch (t.name) {
      case "true":
      case "false":
        if (!t.empty) {
          const c = tag();
          if (!c.close || c.name !== t.name) throw new Error(`plist: <${t.name}> isn't empty`);
        }
        return t.name === "true";
      case "string":
        return t.empty ? "" : body("string");
      case "integer": {
        const s = t.empty ? "" : body("integer").trim();
        if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(s)) throw new Error(`plist: <integer>${s}</integer>`);
        return Number(s);
      }
      case "real": {
        const n = Number(t.empty ? "" : body("real").trim());
        if (Number.isNaN(n)) throw new Error("plist: a <real> that isn't a number");
        return n;
      }
      case "date":
        return t.empty ? "" : body("date").trim();
      case "data":
        return t.empty ? new Uint8Array() : new Uint8Array(Buffer.from(body("data").replace(/\s+/g, ""), "base64"));
      case "array": {
        const out: PlistValue[] = [];
        if (t.empty) return out;
        for (;;) {
          const n = tag();
          if (n.close && n.name === "array") return out;
          out.push(value(n));
        }
      }
      case "dict": {
        const out: PlistDict = {};
        if (t.empty) return out;
        for (;;) {
          const k = tag();
          if (k.close && k.name === "dict") return out;
          if (k.name !== "key" || k.close) throw new Error(`plist: expected <key> in a <dict>, got <${k.close ? "/" : ""}${k.name}>`);
          const key = k.empty ? "" : body("key");
          if (Object.hasOwn(out, key)) throw new Error(`plist: the key ${key} twice in one <dict>`);
          out[key] = value(tag());
        }
      }
      default:
        throw new Error(`plist: unknown element <${t.name}>`);
    }
  };
  const top = tag();
  if (top.name !== "plist" || top.close || top.empty) throw new Error("plist: the document isn't a <plist>");
  const v = value(tag());
  const end = tag();
  if (!end.close || end.name !== "plist") throw new Error("plist: more than one value in <plist>");
  skip();
  if (i !== text.length) throw new Error("plist: text after </plist>");
  return v;
}

/** parsePlist, for an agent: its top-level dict, or null when it isn't one (or can't be read). */
export function readAgentPlist(text: string): PlistDict | null {
  try {
    const v = parsePlist(text);
    return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : null;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(v: PlistValue, pad: string): string {
  if (typeof v === "string") return `${pad}<string>${esc(v)}</string>`;
  if (typeof v === "boolean") return `${pad}<${v}/>`;
  if (typeof v === "number") return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`;
  if (v instanceof Uint8Array) return `${pad}<data>${Buffer.from(v).toString("base64")}</data>`;
  if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map((x) => render(x, `${pad}  `)).join("\n")}\n${pad}</array>` : `${pad}<array/>`;
  const keys = Object.keys(v);
  if (!keys.length) return `${pad}<dict/>`;
  return `${pad}<dict>\n${keys.map((k) => `${pad}  <key>${esc(k)}</key>\n${render(v[k]!, `${pad}  `)}`).join("\n")}\n${pad}</dict>`;
}

/**
 * An XML plist for `dict`, with `comment` (any text) after the header. An XML comment can't hold "--", so the text is
 * written with every backslash and "-" escaped by a backslash; plistComment reads it back exactly.
 */
export function renderPlist(dict: PlistDict, comment?: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    ...(comment === undefined ? [] : [`<!-- ${comment.replace(/[\\-]/g, "\\$&")} -->`]),
    `<plist version="1.0">`,
    render(dict, ""),
    `</plist>`,
    "",
  ].join("\n");
}

/** The first comment of a plist, read back as renderPlist wrote it (its backslash escapes undone), or undefined. */
export function plistComment(text: string): string | undefined {
  const m = /<!-- ([\s\S]*?) -->/.exec(text);
  return m ? m[1]!.replace(/\\([\s\S])/g, "$1") : undefined;
}

const strings = (v: PlistValue | undefined): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** The command an agent runs: ProgramArguments, else Program alone; [] when the plist names none. */
export function agentProgram(plist: PlistDict): string[] {
  const args = strings(plist.ProgramArguments);
  if (args?.length) return args;
  return typeof plist.Program === "string" ? [plist.Program] : [];
}

/** An agent's EnvironmentVariables (string values only; others aren't passed by launchd either). */
export function agentEnv(plist: PlistDict): Record<string, string> {
  const env: Record<string, string> = {};
  const e = plist.EnvironmentVariables;
  if (e && typeof e === "object" && !Array.isArray(e) && !(e instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(e)) if (typeof v === "string") env[k] = v;
  }
  return env;
}

/** Runs core (any copy of parachute-core): never the old programs, whatever its PATH holds. */
export function runsCore(plist: PlistDict): boolean {
  return agentProgram(plist).some((a) => /parachute-core/.test(a));
}

/**
 * Serves the old hub or vault, by its program: `parachute serve`, `parachute-vault serve`, or a Bun script of
 * @openparachute/hub or @openparachute/vault given `serve` (what the 0.7 hub's agent runs: bun, …/hub/src/cli.ts,
 * serve). Not core, and not another verb (a vault's scheduled backup agent runs `… vault backup`).
 */
export function servesOld(plist: PlistDict): boolean {
  const args = agentProgram(plist);
  if (runsCore(plist) || !args.includes("serve")) return false;
  const before = args.slice(0, args.indexOf("serve"));
  return before.some((a) => /(^|\/)(parachute|parachute-vault)$/.test(a) || /@openparachute\/(hub|vault)\//.test(a));
}

/**
 * Looks like the old hub or vault: its program serves them (servesOld), or it carries their own label and doesn't run
 * core (the 0.7 vault's agent runs a bash wrapper, start.sh). A cloudflared tunnel (computer.parachute.cloudflared.<name>,
 * whatever the name) or a backup agent is neither.
 */
export function agentLooksOld(label: string, plist: PlistDict | null): boolean {
  if (plist && runsCore(plist)) return false;
  return OLD_AGENT_LABELS.has(label) || (!!plist && servesOld(plist));
}

/**
 * The home an agent serves, read from its plist alone, or "unknown". Known only when its program is the old program
 * itself (servesOld: no wrapper in between that could set another): its PARACHUTE_HOME, else ~/.parachute under its
 * HOME (EnvironmentVariables, else the user's). A plist is the whole configuration (no drop-ins), so for those agents
 * this is what launchd starts at login.
 */
export function agentHome(plist: PlistDict | null, userHome: string): string | "unknown" {
  if (!plist || !servesOld(plist)) return "unknown";
  const env = agentEnv(plist);
  if (env.PARACHUTE_HOME) return env.PARACHUTE_HOME;
  return join(env.HOME || userHome, ".parachute");
}

/** Loaded at login: a plist with Disabled true isn't (launchctl's own disable overrides aren't read here). */
export function agentEnabled(plist: PlistDict | null): boolean {
  return !(plist && plist.Disabled === true);
}

/**
 * `launchctl list` (no label): a header, then `PID<tab>Status<tab>Label` per loaded job, PID "-" when it has no
 * process. Every loaded label with its pid (0: none). null when the output isn't that table.
 */
export function parseLaunchctlList(out: string): Map<string, number> | null {
  const lines = out.split("\n").filter((l) => l.trim());
  if (!lines.length || !/^PID\s+Status\s+Label$/.test(lines[0]!.trim())) return null;
  const jobs = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const m = /^(-|\d+)\t(-|-?\d+)\t(.+)$/.exec(line);
    if (!m) return null;
    jobs.set(m[3]!, m[1] === "-" ? 0 : Number(m[1]));
  }
  return jobs;
}
