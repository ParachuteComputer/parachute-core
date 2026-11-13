/**
 * When this vault last gave out a full export, and to which key (0.9.3 "the exit"). A person who set up a cron pull
 * can see here that it ran. One small file beside the vault's database: the stamp is about the vault's backups, not
 * a note, so it is not in the note store (and not in the export itself).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vaultDir } from "./config.ts";

export interface LastExport {
  last_export_at: string | null;
  last_export_by: string | null;
}

const file = (vault: string) => join(vaultDir(vault), "last-export.json");

export function readLastExport(vault: string): LastExport {
  try {
    const p = file(vault);
    if (!existsSync(p)) return { last_export_at: null, last_export_by: null };
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<LastExport>;
    return {
      last_export_at: typeof j.last_export_at === "string" ? j.last_export_at : null,
      last_export_by: typeof j.last_export_by === "string" ? j.last_export_by : null,
    };
  } catch {
    return { last_export_at: null, last_export_by: null };
  }
}

/** Record a finished export. Best effort: a failure to write the stamp must not undo a backup that went out. */
export function recordExport(vault: string, by: string | null, at: Date = new Date()): void {
  try {
    const p = file(vault);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ last_export_at: at.toISOString(), last_export_by: by }) + "\n", { mode: 0o600 });
    renameSync(tmp, p);
  } catch (err) {
    console.warn(`[export] could not record the export time for ${vault}: ${(err as Error).message}`);
  }
}
