import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { ServeEntry } from "./tailscale/commands.ts";

export const EXPOSE_STATE_PATH = join(CONFIG_DIR, "expose-state.json");

export type ExposeMode = "path" | "subdomain";
export type ExposeLayer = "tailnet" | "public";

export interface ExposeState {
  version: 1;
  layer: ExposeLayer;
  mode: ExposeMode;
  canonicalFqdn: string;
  port: number;
  funnel: boolean;
  entries: ServeEntry[];
  /**
   * Hub origin emitted when this exposure was brought up — the URL OAuth
   * clients will see as the issuer. `parachute start vault` reads it to set
   * PARACHUTE_HUB_ORIGIN so vault's OAuth metadata matches reality. Optional
   * for pre-Phase-0 state files; writers always populate it.
   */
  hubOrigin?: string;
}

export class ExposeStateError extends Error {
  override name = "ExposeStateError";
}

function validate(raw: unknown, path: string): ExposeState {
  if (!raw || typeof raw !== "object") {
    throw new ExposeStateError(`${path}: root must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new ExposeStateError(`${path}: unsupported version ${String(r.version)}`);
  }
  if (r.layer !== "tailnet" && r.layer !== "public") {
    throw new ExposeStateError(`${path}: layer must be "tailnet" or "public"`);
  }
  if (r.mode !== "path" && r.mode !== "subdomain") {
    throw new ExposeStateError(`${path}: mode must be "path" or "subdomain"`);
  }
  if (typeof r.canonicalFqdn !== "string" || r.canonicalFqdn.length === 0) {
    throw new ExposeStateError(`${path}: canonicalFqdn must be a non-empty string`);
  }
  if (typeof r.port !== "number" || !Number.isInteger(r.port)) {
    throw new ExposeStateError(`${path}: port must be an integer`);
  }
  if (typeof r.funnel !== "boolean") {
    throw new ExposeStateError(`${path}: funnel must be a boolean`);
  }
  if (!Array.isArray(r.entries)) {
    throw new ExposeStateError(`${path}: entries must be an array`);
  }
  if (r.hubOrigin !== undefined && typeof r.hubOrigin !== "string") {
    throw new ExposeStateError(`${path}: hubOrigin must be a string if present`);
  }
  const entries: ServeEntry[] = r.entries.map((e, i) => {
    if (!e || typeof e !== "object") {
      throw new ExposeStateError(`${path} entries[${i}]: expected object`);
    }
    const entry = e as Record<string, unknown>;
    const kind = entry.kind;
    if (kind !== "proxy" && kind !== "file") {
      throw new ExposeStateError(`${path} entries[${i}]: kind must be "proxy" or "file"`);
    }
    if (typeof entry.mount !== "string" || !entry.mount.startsWith("/")) {
      throw new ExposeStateError(`${path} entries[${i}]: mount must start with "/"`);
    }
    if (typeof entry.target !== "string" || entry.target.length === 0) {
      throw new ExposeStateError(`${path} entries[${i}]: target must be non-empty string`);
    }
    if (typeof entry.service !== "string" || entry.service.length === 0) {
      throw new ExposeStateError(`${path} entries[${i}]: service must be non-empty string`);
    }
    return { kind, mount: entry.mount, target: entry.target, service: entry.service };
  });
  const state: ExposeState = {
    version: 1,
    layer: r.layer,
    mode: r.mode,
    canonicalFqdn: r.canonicalFqdn,
    port: r.port,
    funnel: r.funnel,
    entries,
  };
  if (typeof r.hubOrigin === "string") state.hubOrigin = r.hubOrigin;
  return state;
}

export function readExposeState(path: string = EXPOSE_STATE_PATH): ExposeState | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ExposeStateError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validate(raw, path);
}

export function writeExposeState(state: ExposeState, path: string = EXPOSE_STATE_PATH): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearExposeState(path: string = EXPOSE_STATE_PATH): void {
  if (existsSync(path)) unlinkSync(path);
}
