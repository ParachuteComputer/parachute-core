// Offline mode (PLAN §3 "Offline by default"; Benjamin's E9). `serve --embedded` and `serve --offline` set
// PARACHUTE_OFFLINE=1 for the hub and the vault it starts (packages/cli/src/dispatch.ts). Then the vault reaches
// nothing off the machine on its own: no model download, no outbound webhook, no embeddings API and no mirror push
// to anywhere but loopback.

/** True when this process runs offline (PARACHUTE_OFFLINE=1). */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.PARACHUTE_OFFLINE?.trim() ?? "");
}

/** True for a URL whose host is this machine: 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Whether the vault may call `url` now: always online, and offline only on loopback. */
export function outboundAllowed(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOffline(env) || isLoopbackUrl(url);
}
