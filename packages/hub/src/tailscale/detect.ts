import type { Runner } from "./run.ts";
import { TailscaleError } from "./run.ts";

/** ACL capability keys Tailscale emits on `Self.CapMap` when the node is
 * allowed to run Funnel. Modern tailscaled (≥ ~1.96) emits the bare
 * `"funnel"` key; older builds emit the URL form. Accept either — the probe
 * is best-effort (see {@link getTailscaleStatus}) and we'd rather cross
 * versions than over-nag users whose ACL is correctly granted. */
export const FUNNEL_CAP_KEYS = ["funnel", "https://tailscale.com/cap/funnel"] as const;

export async function isTailscaleInstalled(runner: Runner): Promise<boolean> {
  try {
    const { code } = await runner(["tailscale", "version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Consolidated read of `tailscale status --json`, returning everything the
 * readiness check needs in one subprocess call:
 *
 * - `loggedIn` — Self.DNSName is present and non-empty. False on `Logged out`,
 *   `Stopped`, install/PATH errors, or parse failures — callers use this to
 *   decide whether to prompt the user to run `tailscale up` before anything
 *   else.
 * - `funnelCapable` — best-effort probe for whether this node is allowed to
 *   expose Funnel, via any key in {@link FUNNEL_CAP_KEYS} on `Self.CapMap`.
 *
 * Caveat on `funnelCapable`: `CapMap` is a semi-internal field whose shape
 * Tailscale can shift across versions. This probe is not load-bearing — a
 * false negative only means we'll point the user at the admin console when
 * they don't actually need to do anything. The downstream `tailscale funnel`
 * call is the real gate; this just lets us nudge the user earlier in the flow.
 *
 * Any error (non-zero exit, parse failure) returns `{ loggedIn: false,
 * funnelCapable: false }` rather than throwing; the readiness check is an
 * advisory pre-flight, not a hard gate.
 */
export async function getTailscaleStatus(
  runner: Runner,
): Promise<{ loggedIn: boolean; funnelCapable: boolean }> {
  try {
    const result = await runner(["tailscale", "status", "--json"]);
    if (result.code !== 0) return { loggedIn: false, funnelCapable: false };
    const parsed = JSON.parse(result.stdout) as {
      Self?: { DNSName?: unknown; CapMap?: Record<string, unknown> };
    };
    const dnsName = parsed.Self?.DNSName;
    const loggedIn = typeof dnsName === "string" && dnsName.length > 0;
    const capMap = parsed.Self?.CapMap;
    const funnelCapable =
      loggedIn &&
      !!capMap &&
      typeof capMap === "object" &&
      FUNNEL_CAP_KEYS.some((k) => k in capMap);
    return { loggedIn, funnelCapable };
  } catch {
    return { loggedIn: false, funnelCapable: false };
  }
}

export async function getFqdn(runner: Runner): Promise<string> {
  const result = await runner(["tailscale", "status", "--json"]);
  if (result.code !== 0) {
    throw new TailscaleError(
      `tailscale status --json exited ${result.code}: ${result.stderr.trim()}`,
      ["tailscale", "status", "--json"],
      result,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new TailscaleError(
      `failed to parse tailscale status JSON: ${err instanceof Error ? err.message : String(err)}`,
      ["tailscale", "status", "--json"],
      result,
    );
  }
  const self = (parsed as { Self?: { DNSName?: unknown } }).Self;
  const dnsName = self?.DNSName;
  if (typeof dnsName !== "string" || dnsName.length === 0) {
    throw new TailscaleError(
      "tailscale status did not return Self.DNSName — is this machine logged in?",
      ["tailscale", "status", "--json"],
      result,
    );
  }
  return dnsName.replace(/\.$/, "");
}

/**
 * Detect whether wildcard MagicDNS is active — i.e. whether subdomains of the
 * current machine (vault.<fqdn>, notes.<fqdn>, …) resolve back to this node.
 *
 * Tailscale's standard MagicDNS gives each machine a single hostname and does
 * not auto-resolve arbitrary subdomains; wildcard MagicDNS exists in the
 * Services feature but requires explicit advertisement. For launch we return
 * false (path-routing) and let a later PR add real detection once the
 * subdomain-per-service path is supported end-to-end.
 */
export async function detectWildcardMagicDNS(_runner: Runner): Promise<boolean> {
  return false;
}
