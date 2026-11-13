/**
 * The data housekeeping `parachute doctor` reports and `parachute doctor --fix` repairs (T-463, 0.9.3). Two kinds,
 * both with a fixer that already existed and is safe to run any time:
 *   - a vault whose history compaction hints differ from history (was `parachute-vault history rebuild-state`):
 *     the finding `history-state:<vault>`. The hub never opens a vault's data itself: it asks the vault's own
 *     command (`history rebuild-state --check`, then the rebuild), so the vault keeps the one definition of "stale".
 *   - OAuth clients nothing uses, registered over 30 days ago (was `parachute auth reap-clients`): the finding
 *     `oauth-clients`, from the same `findReapableClients` gate the old command used.
 * Detection writes nothing. Both fixers only drop derived or provably dead rows.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ReapableClient, findReapableClients, reapClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

export interface DataDeps {
  /** Vault names under `<home>/vault/data` (a folder with a vault.yaml). */
  listVaults?: (configDir: string) => string[];
  /** Notes whose hints differ from history, or null when the vault can't be asked. */
  historyDrift?: (configDir: string, vault: string) => { checked: number; drifted: number } | null;
  /** Rebuild one vault's hints. True when it worked. */
  rebuildHistory?: (configDir: string, vault: string) => boolean;
  /** Clients nothing uses; [] with no hub.db yet; null when hub.db exists but can't be read. */
  findReapable?: (configDir: string) => ReapableClient[] | null;
  /** Delete these clients, re-checking each is still unused at that moment; returns the ids deleted (the rest are now in use and kept). */
  reapClients?: (configDir: string, clientIds: string[]) => string[];
}

export interface StaleHistory {
  vault: string;
  checked: number;
  /** Notes whose hints differ; null when the vault could not be asked. */
  drifted: number | null;
}

export interface DataFindings {
  /** Every vault the vault command could be asked about, with how many notes differ (0 = fine). */
  history: StaleHistory[];
  /** Null when hub.db exists but can't be read (reported as "could not check"). */
  reapable: ReapableClient[] | null;
}

export interface DataCheck {
  name: string;
  title: string;
  status: "pass" | "warn";
  detail: string;
  fix?: string;
}

function defaultListVaults(configDir: string): string[] {
  const dir = join(configDir, "vault", "data");
  try {
    return readdirSync(dir)
      .filter((n) => existsSync(join(dir, n, "vault.yaml")) && existsSync(join(dir, n, "vault.db")))
      .sort();
  } catch {
    return [];
  }
}

/**
 * This install's own `parachute-vault`: the one in the bin folder of the running program (packages/cli/bin, next to
 * `parachute`), else the first on PATH. Null when there is none.
 */
function vaultBin(): string | null {
  // This module sits at packages/hub/src/commands/ from source and in the bundle (lib/packages/…); the program's own
  // `parachute-vault` is packages/cli/bin/. process.argv[1] can't be used: dispatch rewrites it to the hub's cli.ts.
  const own = join(import.meta.dir, "..", "..", "..", "cli", "bin", "parachute-vault");
  if (existsSync(own)) return own;
  return Bun.which("parachute-vault");
}

function runVault(configDir: string, args: string[]): { code: number; out: string } | null {
  const bin = vaultBin();
  if (!bin) return null;
  try {
    const r = Bun.spawnSync([bin, "history", "rebuild-state", ...args], {
      env: { ...process.env, PARACHUTE_HOME: configDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    return { code: r.exitCode ?? 1, out: r.stdout.toString() };
  } catch {
    return null;
  }
}

function defaultHistoryDrift(configDir: string, vault: string) {
  const r = runVault(configDir, ["--vault", vault, "--check", "--json"]);
  if (!r || r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out.trim().split("\n").pop() ?? "");
    return typeof j.drifted_notes === "number" ? { checked: Number(j.checked_notes) || 0, drifted: j.drifted_notes as number } : null;
  } catch {
    return null;
  }
}

function defaultRebuildHistory(configDir: string, vault: string): boolean {
  return runVault(configDir, ["--vault", vault, "--json"])?.code === 0;
}

function defaultFindReapable(configDir: string): ReapableClient[] | null {
  const path = hubDbPath(configDir);
  // No hub.db yet is a fresh install (doctor stays green there); one that exists and can't be read is "could not check".
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    // Read-only: doctor never migrates or writes a database it only reports on.
    db = new Database(path, { readonly: true });
    return findReapableClients(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function defaultReapClients(configDir: string, clientIds: string[]): string[] {
  const db = openHubDb(hubDbPath(configDir));
  try {
    // The list was made before a prompt that can wait any time: under one write lock, ask the gate again and delete
    // only what is still unused (a client that got a grant meanwhile is kept).
    return db
      .transaction(() => {
        const still = new Set(findReapableClients(db).map((c) => c.clientId));
        return clientIds.filter((id) => still.has(id) && reapClient(db, id));
      })
      .immediate();
  } finally {
    db.close();
  }
}

export function findDataProblems(configDir: string, d: DataDeps | undefined): DataFindings {
  const history: StaleHistory[] = [];
  for (const vault of (d?.listVaults ?? defaultListVaults)(configDir)) {
    const drift = (d?.historyDrift ?? defaultHistoryDrift)(configDir, vault);
    history.push({ vault, ...(drift ?? { checked: 0, drifted: null }) });
  }
  return { history, reapable: (d?.findReapable ?? defaultFindReapable)(configDir) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The report's "Data" group. Always one `oauth-clients` check, and one `history-state:<vault>` per vault asked. */
export function dataChecks(f: DataFindings): DataCheck[] {
  const out: DataCheck[] = f.history.map((h) =>
    h.drifted === null
      ? {
          name: `history-state:${h.vault}`,
          title: `History hints of vault "${h.vault}" match its history`,
          status: "warn" as const,
          detail: `could not check: this install's parachute-vault did not answer \`history rebuild-state --check\` (missing, older, timed out or refused the home)`,
          fix: `parachute-vault history rebuild-state --vault ${h.vault} --check`,
        }
      : h.drifted > 0
      ? {
          name: `history-state:${h.vault}`,
          title: `History hints of vault "${h.vault}" match its history`,
          status: "warn" as const,
          detail: `${plural(h.drifted, "note's", "notes'")} compaction hints differ from history (history itself is fine; the hints only schedule compaction).`,
          fix: "parachute doctor --fix",
        }
      : {
          name: `history-state:${h.vault}`,
          title: `History hints of vault "${h.vault}" match its history`,
          status: "pass" as const,
          detail: `${plural(h.checked, "note", "notes")} with history, hints match`,
        },
  );
  if (f.reapable === null) {
    out.push({
      name: "oauth-clients",
      title: "No unused OAuth clients",
      status: "warn",
      detail: "could not check: hub.db exists but can't be read",
      fix: "parachute auth reap-clients",
    });
    return out;
  }
  out.push(
    f.reapable.length > 0
      ? {
          name: "oauth-clients",
          title: "No unused OAuth clients",
          status: "warn",
          detail: `${plural(f.reapable.length, "OAuth client is", "OAuth clients are")} registered over 30 days ago with no grants, live tokens or open codes: ${f.reapable
            .map((c) => c.clientName ?? c.clientId)
            .join(", ")}`,
          fix: "parachute doctor --fix",
        }
      : { name: "oauth-clients", title: "No unused OAuth clients", status: "pass", detail: "none to remove" },
  );
  return out;
}

export function hasDataFixes(f: DataFindings): boolean {
  return (f.reapable?.length ?? 0) > 0 || f.history.some((h) => (h.drifted ?? 0) > 0);
}

/** What `--fix` would do, one line each. */
export function describeDataFixes(f: DataFindings): string[] {
  const lines: string[] = [];
  for (const h of f.history.filter((x) => (x.drifted ?? 0) > 0)) {
    lines.push(`  vault "${h.vault}": rebuild the compaction hints of ${plural(h.drifted!, "note", "notes")} (history itself is not changed)`);
  }
  for (const c of f.reapable ?? []) {
    lines.push(`  OAuth client "${c.clientName ?? c.clientId}" (${c.clientId}, ${c.ageDays} days old, unused): delete it`);
  }
  return lines;
}

/** Run the fixers. Returns the number that failed. */
export function applyDataFixes(configDir: string, f: DataFindings, d: DataDeps | undefined, print: (line: string) => void): number {
  let failed = 0;
  for (const h of f.history.filter((x) => (x.drifted ?? 0) > 0)) {
    if ((d?.rebuildHistory ?? defaultRebuildHistory)(configDir, h.vault)) print(`Rebuilt the compaction hints of vault "${h.vault}".`);
    else {
      failed++;
      print(`Could not rebuild the compaction hints of vault "${h.vault}": run \`parachute-vault history rebuild-state --vault ${h.vault}\` to see why.`);
    }
  }
  if (f.reapable && f.reapable.length > 0) {
    const gone = new Set((d?.reapClients ?? defaultReapClients)(configDir, f.reapable.map((c) => c.clientId)));
    for (const c of f.reapable) {
      // The same audit line `parachute auth reap-clients` writes.
      if (gone.has(c.clientId)) {
        print(`client reaped: client_id=${c.clientId} client_name=${c.clientName ?? ""} age_days=${c.ageDays} status=${c.status}`);
      } else {
        print(`client kept: client_id=${c.clientId} client_name=${c.clientName ?? ""} is in use now`);
      }
    }
    print(`Removed ${plural(gone.size, "unused OAuth client", "unused OAuth clients")}.`);
  }
  return failed;
}
