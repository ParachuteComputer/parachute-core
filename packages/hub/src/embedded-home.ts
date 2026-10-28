/**
 * An embedded home (v0.8 PLAN §3): a PARACHUTE_HOME that `parachute serve --embedded` has opened. A host (Prism)
 * manages Parachute there, so the issuer is decided the same way every time and nothing a box install leaves
 * behind decides it:
 *
 *   - `$PARACHUTE_HOME/embedded.json` marks the home and records the issuer of the latest start plus every
 *     earlier one (`accepted_issuers`), so tokens from an earlier port keep verifying;
 *   - in an embedded home, `expose-state.json` and `hub/run/hub.port` are never read (closes Benjamin's gap 1);
 *   - `run/ready.json` is the running serve's state, for the host to read.
 *
 * `serve --embedded` (packages/cli/src/embedded.ts) writes these files; the hub's CLI and server only read them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EMBEDDED_FILE = "embedded.json";

export interface EmbeddedState {
  /** The issuer of the latest start: PARACHUTE_HUB_ORIGIN when the host set it, else http://127.0.0.1:<hub port>. */
  issuer: string;
  /** Every issuer this home has used, the latest included. Tokens carrying any of them verify. */
  accepted_issuers: string[];
}

export function embeddedStatePath(configDir: string): string {
  return join(configDir, EMBEDDED_FILE);
}

/** True when `configDir` is an embedded home. */
export function isEmbeddedHome(configDir: string): boolean {
  return existsSync(embeddedStatePath(configDir));
}

/** The home's embedded state, or undefined when it isn't an embedded home (or the file can't be read). */
export function readEmbeddedState(configDir: string): EmbeddedState | undefined {
  const p = embeddedStatePath(configDir);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<EmbeddedState>;
    if (typeof raw?.issuer !== "string" || !raw.issuer) return undefined;
    const accepted = Array.isArray(raw.accepted_issuers)
      ? raw.accepted_issuers.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    return { issuer: raw.issuer, accepted_issuers: accepted.includes(raw.issuer) ? accepted : [...accepted, raw.issuer] };
  } catch {
    return undefined;
  }
}
