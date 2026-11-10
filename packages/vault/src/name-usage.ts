/**
 * Which names agents and apps still use (T-407): every call to an old,
 * note-named MCP tool or parameter, and every request to a note-named REST
 * route, counted by name; the record names too, so the move can be watched.
 * 1.0 removes the old names, and waits on these counts.
 *
 * Counts land in the home's usage log, `run/deprecations.json`, the file the
 * CLI already keeps for old command names (packages/cli/src/front.ts) and
 * `parachute changes` prints: old names under `names`, `mcp <tool>` /
 * `mcp <tool> <param>` / `rest <METHOD> <route>`, and the new names under
 * `adopted`. Only names and counts, never a value, a path or a key.
 *
 * Writes are batched: the first use starts a timer, and the counts are merged
 * into the file at most every FLUSH_MS (and on exit), so a busy vault doesn't
 * write per call. A crash loses at most that window. The CLI writes the same file the same way (read, change,
 * rename, no lock), so in the rare instant both write, one write's counts can be lost: they are advice, not a ledger. Never written on a home a
 * host application manages (Prism's embedded serve, or its `embedded.json`):
 * those homes are its contract, and stay as it left them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_LOG = join("run", "deprecations.json");
const FLUSH_MS = 5_000;
/** At most this many distinct names per section, so caller-chosen text can't grow the file without bound. */
const MAX_NAMES = 512;

type Row = { count: number; first_seen: string; last_seen: string };
type Section = "names" | "adopted";
const pending: Record<Section, Map<string, { n: number; first: string; last: string }>> = { names: new Map(), adopted: new Map() };
let timer: ReturnType<typeof setTimeout> | null = null;
let exitHooked = false;

/** The home the vault serves, as config.ts resolves it: PARACHUTE_HOME, else ~/.parachute (never under bun test). */
function home(): string | null {
  const h = process.env.PARACHUTE_HOME;
  if (h && h.length > 0) return h;
  if (process.env.NODE_ENV === "test") return null; // the live home is never a test's (config.ts says why)
  return join(homedir(), ".parachute");
}

/** A home Prism holds: its embedded marker, or this process run as (or under) its embedded serve. */
function hostManaged(h: string): boolean {
  if (existsSync(join(h, "embedded.json"))) return true;
  if (process.env.PARACHUTE_EMBEDDED_PARENT) return true;
  try {
    const pid = JSON.parse(readFileSync(join(h, "run", "serve.lock"), "utf8"))?.pid;
    if (pid === process.pid && existsSync(join(h, "run", "serve.hold"))) return true;
  } catch {}
  return false;
}

/** Count one use. `old`: a name 1.0 removes. `new`: its replacement. */
export function countName(name: string, kind: "old" | "new"): void {
  const section: Section = kind === "old" ? "names" : "adopted";
  const key = name.replace(/[^\w ./:{}-]/g, "?").slice(0, 96);
  const at = new Date().toISOString();
  const row = pending[section].get(key);
  if (row) {
    row.n += 1;
    row.last = at;
  } else if (pending[section].size < MAX_NAMES) {
    pending[section].set(key, { n: 1, first: at, last: at });
  }
  if (!timer) {
    timer = setTimeout(flushNameUsage, FLUSH_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", flushNameUsage);
  }
}

/** Merge the pending counts into the usage log now. Safe to call any time; never throws. */
export function flushNameUsage(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const h = process.env.PARACHUTE_DEPRECATIONS === "0" ? null : home(); // the CLI's opt-out holds here too
  const empty = pending.names.size === 0 && pending.adopted.size === 0;
  if (empty || !h || !existsSync(h) || hostManaged(h)) {
    pending.names.clear();
    pending.adopted.clear();
    return;
  }
  try {
    mkdirSync(join(h, "run"), { recursive: true, mode: 0o700 });
    const path = join(h, USAGE_LOG);
    let log: Record<string, unknown> = { schema: 1, names: {} };
    try {
      const read = JSON.parse(readFileSync(path, "utf8"));
      if (read && typeof read === "object" && typeof read.names === "object") log = read;
    } catch {}
    for (const section of ["names", "adopted"] as const) {
      const rows = ((log[section] as Record<string, Row> | undefined) ??= {}) as Record<string, Row>;
      for (const [k, p] of pending[section]) {
        if (!rows[k] && Object.keys(rows).length >= MAX_NAMES * 2) continue;
        const r = rows[k] ?? { count: 0, first_seen: p.first, last_seen: p.last };
        rows[k] = { count: r.count + p.n, first_seen: r.first_seen, last_seen: p.last };
      }
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(log, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Advice for 1.0's removals: a read-only or full home must never fail a request.
  } finally {
    pending.names.clear();
    pending.adopted.clear();
  }
}

/**
 * A REST request's route name for the count: the vault-relative path with ids
 * taken out (`/api/notes/:id/versions/:x`). Only note-named routes are counted.
 */
export function restRouteName(method: string, apiPath: string): string | null {
  if (!/^\/notes(\/|$)/.test(apiPath)) return null;
  const parts = apiPath.split("/").filter(Boolean);
  const SUBS = new Set(["attachments", "retry-transcription", "versions", "imports", "restore"]);
  const shape = parts.slice(0, 4).map((p, i) => (i === 0 ? p : i === 1 ? ":id" : i === 2 ? (SUBS.has(p) ? p : "?") : ":x"));
  return `rest ${method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8)} /api/${shape.join("/")}`;
}

/** An `/api/types` request's route name for the count (`apiPath` is its `/tags…` twin): names only, never a type's. */
export function typesRouteName(method: string, apiPath: string): string {
  const parts = apiPath.split("/").filter(Boolean).slice(1, 3);
  const shape = parts.map((p, i) => (i === 0 ? (p === "merge" ? p : ":name") : ["rename", "conformance", "effective"].includes(p) ? p : "?"));
  return `rest ${method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8)} /api/${["types", ...shape].join("/")}`;
}
