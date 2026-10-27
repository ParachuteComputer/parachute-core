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

export const EXPOSE_LAST_PROVIDER_PATH = join(CONFIG_DIR, "expose-last-provider.json");

export type ExposeProvider = "tailscale" | "cloudflare";

export interface ExposeLastProvider {
  version: 1;
  provider: ExposeProvider;
  /** ISO-8601 timestamp of the last selection — debugging only. */
  writtenAt: string;
}

/**
 * Persisted cross-invocation preference — remembers which provider the user
 * picked last in the interactive flow so we can default to it next time.
 *
 * Unlike the live state files (`expose-state.json`, `cloudflared-state.json`)
 * this is just a preference hint, so missing or corrupt content is not fatal:
 * we return `undefined` and the caller falls back to its default. A stale file
 * is never load-bearing — the worst case is a one-keystroke re-pick.
 */
export function readLastProvider(
  path: string = EXPOSE_LAST_PROVIDER_PATH,
): ExposeLastProvider | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return undefined;
  if (r.provider !== "tailscale" && r.provider !== "cloudflare") return undefined;
  if (typeof r.writtenAt !== "string" || r.writtenAt.length === 0) return undefined;
  return { version: 1, provider: r.provider, writtenAt: r.writtenAt };
}

export function writeLastProvider(
  provider: ExposeProvider,
  opts: { path?: string; now?: () => Date } = {},
): void {
  const path = opts.path ?? EXPOSE_LAST_PROVIDER_PATH;
  const now = opts.now ?? (() => new Date());
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const record: ExposeLastProvider = {
    version: 1,
    provider,
    writtenAt: now().toISOString(),
  };
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearLastProvider(path: string = EXPOSE_LAST_PROVIDER_PATH): void {
  if (existsSync(path)) unlinkSync(path);
}
