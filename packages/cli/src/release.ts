// The step from one release to the next on a home (DESIGN-0.9 §6 "every step up to 1.0 has a migration path", §7
// "data always migrates automatically, forward, with a backup first"), and its way back.
//
//   run/release.json             which release last served this home, the one before it, and the backup taken
//                                between them. `parachute changes` and the rollback read it.
//   parachute upgrade --rollback [--restore] [--yes] [--json]
//
// 0.8 → 0.9 is additive: the vault's tags gain a `kind` column and the hub a `keys` table, and neither schema number
// moves (DESIGN §8a, build note). So, by the 0.8 takeover's own rule (takeover.ts detect(): a migration is a schema
// number below the program's), there is no migration and 0.8 opens a 0.9 home unchanged. What 0.8 doesn't know it
// leaves alone, and 0.9 re-derives it on its next start (a NULL kind from the rule, a token 0.8 minted as a key).
//
// Still, the first 0.9 start on a home an older release served takes a backup first, the takeover's way: every
// database copied (VACUUM INTO: a consistent copy even with a -wal beside it) to
// <home>/../parachute-upgrade/<from>-to-<to>-<time>/home/, with manifest.json (a sha256 and the schema number per
// file). A home the 0.8 takeover just made (its record names this version) already has that backup and gets no
// second one. A host-managed (embedded) home is the host's to back up, so it gets none (Prism's contract v1).
//
// The rollback, like the takeover's:
//   - code-only (the default): every database is at a schema number the previous release opens, so nothing changes
//     on disk and every 0.9 write is kept. It checks that, refuses while anything holds the data (exit 7), and
//     records the rollback, so the next 0.9 start backs up again;
//   - --restore: the backup's databases go back in place, after every note changed since is exported beside the
//     backup; what 0.9 left moves aside. Needed once a release moves a schema number (the first is planned for
//     0.9.1's enforced key scopes) or when 0.9 damaged data.
// Exit codes, as the takeover's: 0 done · 1 nothing to roll back, or it can't be done code-only · 2 flags, or no
// --yes where nobody can be asked · 5 no room for the backup · 7 a process holds the data.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import core from "../../../package.json" with { type: "json" };
import { databases, readDatabase, schemaOf } from "./home.ts";
import { exportChanged, holders, RECORD_FILE, serveRefusal } from "./takeover.ts";

export const RELEASE_FILE = join("run", "release.json");
export const EXIT = { ok: 0, failed: 1, usage: 2, noRoom: 5, held: 7 } as const;

export interface Release {
  /** The release serving this home now. */
  version: string;
  /** The release that served it before, or null for a home this release made. */
  previous: string | null;
  since: string;
  /** The backup taken before this release first opened the home (a folder with home/ and manifest.json), or null. */
  backup: string | null;
  state: "current" | "rolled-back";
  rolled_back_at?: string;
  restored_at?: string;
  moved_aside?: string;
}

interface Manifest {
  from: string;
  to: string;
  at: string;
  home: string;
  files: Record<string, string>;
  schemas: Record<string, number | null>;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readRelease(home: string): Release | undefined {
  const r = readJson(join(home, RELEASE_FILE));
  return r && typeof r.version === "string" ? (r as Release) : undefined;
}

function writeRelease(home: string, r: Release): void {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const path = join(home, RELEASE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Copy each of the home's databases into `dest/home/<rel>`, consistently, with a checked manifest. */
export function snapshot(home: string, dest: string, from: string): Manifest {
  const dbs = databases(home, { hub: 0, vault: 0 });
  const need = dbs.reduce((n, d) => n + statSync(join(home, d.rel)).size + (existsSync(join(home, `${d.rel}-wal`)) ? statSync(join(home, `${d.rel}-wal`)).size : 0), 0);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const free = statfsSync(dirname(dest));
  if (free.bavail * free.bsize < need * 1.1 + 50e6) {
    throw new Exit(EXIT.noRoom, `the backup before ${core.version} first opens this home needs ${size(need)} and ${dirname(dest)} has ${size(free.bavail * free.bsize)} free. Nothing was changed.`);
  }
  mkdirSync(join(dest, "home"), { recursive: true, mode: 0o700 });
  const manifest: Manifest = { from, to: core.version, at: new Date().toISOString(), home, files: {}, schemas: {} };
  for (const d of dbs) {
    const to = join(dest, "home", d.rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    readDatabase(join(home, d.rel), (db) => db.run("VACUUM INTO ?", [to]), dest);
    chmodSync(to, 0o600);
    manifest.files[d.rel] = sha256(to);
    manifest.schemas[d.rel] = schemaOf(to, dest) ?? null;
  }
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/**
 * Before a command of this release opens the home: if another release served it last, record the step and back the
 * databases up first. A fresh home only gets its record. Throws Exit(5) when there is no room, before anything is
 * written. Leaves alone a host's (embedded) home, a home the old 0.7 programs still own (the takeover's job), and
 * the takeover's own check run.
 */
export function beforeOpen(home: string, say: (s: string) => void = (s) => console.error(s)): Release | undefined {
  if (process.env.PARACHUTE_TAKEOVER_CHECK === "1") return undefined;
  if (!existsSync(home) || existsSync(join(home, "embedded.json"))) return undefined;
  const was = readRelease(home);
  if (was && was.version === core.version && was.state === "current") return was;
  if (serveRefusal(home) !== null) return undefined;
  const since = new Date().toISOString();
  const dbs = databases(home, { hub: 0, vault: 0 });
  if (dbs.length === 0) {
    const fresh: Release = { version: core.version, previous: was?.version ?? null, since, backup: null, state: "current" };
    writeRelease(home, fresh);
    return fresh;
  }
  // Before 0.9 nothing wrote this record. A home with data and no record was last served by 0.8 (a 0.7 home is the
  // takeover's until it has moved), unless 0.9 made it: a command that created the home found nothing to record
  // before it ran, and left 0.9's own structures (the hub's keys table, the tags' kind column) behind.
  if (!was && madeByThisLine(home, dbs)) {
    const r: Release = { version: core.version, previous: null, since, backup: null, state: "current" };
    writeRelease(home, r);
    return r;
  }
  const previous = was ? (was.state === "rolled-back" ? (was.previous ?? "0.8") : was.version) : "0.8";
  const takeover = readJson(join(home, RECORD_FILE));
  let backup: string;
  if (!was && takeover?.state === "taken-over" && takeover.version === core.version && typeof takeover.backup === "string") {
    backup = takeover.backup; // this release's own takeover backed the home up minutes ago
  } else {
    backup = join(dirname(home), "parachute-upgrade", `${previous}-to-${core.version}-${stamp()}`);
    say(`parachute: ${previous} → ${core.version} on this home: backing up its databases first, to ${backup}`);
    snapshot(home, backup, previous);
  }
  const r: Release = { version: core.version, previous, since, backup, state: "current" };
  writeRelease(home, r);
  return r;
}

/** Whether 0.9 already opened every database here (it adds `keys` to hub.db and `kind` to each vault's tags). */
function madeByThisLine(home: string, dbs: { rel: string }[]): boolean {
  return dbs.every((d) =>
    readDatabase(
      join(home, d.rel),
      (db) =>
        d.rel === "hub.db"
          ? !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'keys'").get()
          : (db.query("PRAGMA table_info(tags)").all() as { name: string }[]).some((c) => c.name === "kind"),
      dirname(home),
    ),
  );
}

/** `beforeOpen` for dispatch: the exit code to stop with, or null to go on. Help opens nothing and skips it. */
export function beforeOpenOrExit(home: string, help = false): number | null {
  if (help) return null;
  try {
    beforeOpen(home);
    return null;
  } catch (err) {
    if (err instanceof Exit) {
      console.error(`parachute: ${err.message}`);
      return err.code;
    }
    throw err;
  }
}

function plan(home: string, r: Release, restore: boolean) {
  const manifest = r.backup ? (readJson(join(r.backup, "manifest.json")) as Manifest | undefined) : undefined;
  const now = databases(home, { hub: 0, vault: 0 }).map((d) => ({ rel: d.rel, schema: schemaOf(join(home, d.rel), dirname(home)) ?? null }));
  // Code-only needs every database at a number the previous release opens: the number it had in the backup.
  const moved = now.filter((d) => manifest && d.rel in manifest.schemas && (d.schema ?? 0) > (manifest.schemas[d.rel] ?? 0));
  return { manifest, now, moved, mode: restore ? ("restore" as const) : ("code-only" as const) };
}

/** `parachute upgrade --rollback [--restore] [--yes] [--json]`: back to the release before this one. */
export async function rollback(home: string, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const restore = args.includes("--restore");
  const yes = args.includes("--yes") || args.includes("-y");
  const unknown = args.find((a) => !["--rollback", "--restore", "--yes", "-y", "--json"].includes(a));
  const say = (s: string) => (json ? console.error(s) : console.log(s));
  try {
    if (unknown) throw new Exit(EXIT.usage, `unknown argument '${unknown}'\nusage: parachute upgrade --rollback [--restore] [--yes] [--json]`);
    const r = readRelease(home);
    if (!r || r.state !== "current" || !r.previous) {
      throw new Exit(EXIT.failed, r?.state === "rolled-back" ? `this home was rolled back to ${r.previous} on ${r.rolled_back_at}; nothing to roll back` : `no earlier release served this home (run/release.json says ${r ? `${r.version}, first` : "nothing"}); nothing to roll back`);
    }
    const p = plan(home, r, restore);
    if (restore && !p.manifest) throw new Exit(EXIT.failed, `there is no backup to restore (${r.backup ?? "none was taken"})`);
    if (!restore && p.moved.length) {
      throw new Exit(EXIT.failed, `${r.previous} can't open ${p.moved.map((d) => d.rel).join(", ")} as it is now (a schema number moved since the backup). Run with --restore: it exports every note changed since, then puts the backup back.`);
    }
    const held = holders(home);
    if (held.length) {
      throw new Exit(EXIT.held, `something still holds the data: ${held.map((h) => `pid ${h.pid} (${h.cmd.slice(0, 80)})`).join(", ")}. Stop Parachute (parachute stop, or its unit), then run this again.`);
    }
    if (restore && !yes) {
      if (!process.stdin.isTTY) throw new Exit(EXIT.usage, "--restore puts the backup's databases back; add --yes to go ahead");
      process.stdout.write(`Put back the databases backed up at ${p.manifest!.at} (notes changed since are exported first)? [y/N] `);
      const answer = await new Promise<string>((res) => process.stdin.once("data", (b) => res(String(b).trim())));
      if (!/^y(es)?$/i.test(answer)) throw new Exit(EXIT.usage, "not confirmed; nothing was changed");
    }
    const out: Record<string, unknown> = { rolled_back: true, from: r.version, to: r.previous, mode: p.mode, backup: r.backup };
    if (p.mode === "code-only") {
      say(`Every database here is at a schema number ${r.previous} opens, so nothing on disk changes and every ${r.version} write is kept.`);
    } else {
      const dir = join(r.backup!, `changed-since-${stamp()}`);
      out.exported_notes = exportChanged(home, join(r.backup!, "home"), dir);
      out.exported_to = dir;
      say(`Exported ${out.exported_notes} notes changed since the backup to ${dir}`);
      const aside = join(r.backup!, `after-${r.version}-${stamp()}`);
      // Every database now, and every one in the backup: the backup's go back, anything newer moves aside.
      for (const rel of new Set([...p.now.map((d) => d.rel), ...Object.keys(p.manifest!.files)])) {
        for (const suffix of ["", "-wal", "-shm"]) {
          const live = join(home, rel + suffix);
          if (!existsSync(live)) continue;
          mkdirSync(dirname(join(aside, rel)), { recursive: true, mode: 0o700 });
          renameSync(live, join(aside, rel + suffix));
        }
      }
      for (const [rel, hash] of Object.entries(p.manifest!.files)) {
        const to = join(home, rel);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        writeFileSync(to, readFileSync(join(r.backup!, "home", rel)), { mode: 0o600 });
        if (sha256(to) !== hash) throw new Exit(EXIT.failed, `the restored ${rel} doesn't match the backup's manifest; what ${r.version} left is in ${aside}`);
      }
      out.moved_aside = aside;
      say(`Put the backup's databases back; what ${r.version} left is in ${aside}`);
    }
    const at = new Date().toISOString();
    writeRelease(home, { ...r, state: "rolled-back", rolled_back_at: at, ...(p.mode === "restore" ? { restored_at: at, moved_aside: out.moved_aside as string } : {}) });
    say(`Rolled back. Start ${r.previous} on ${home} now (its own \`parachute serve\`, or its unit). Any ${r.version} command run on it again backs up and moves forward again.`);
    if (json) console.log(JSON.stringify(out));
    return EXIT.ok;
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    console.error(`parachute upgrade --rollback: ${err.message}`);
    if (json) console.log(JSON.stringify({ rolled_back: false, error: err.message, exit: err.code }));
    return err.code;
  }
}
