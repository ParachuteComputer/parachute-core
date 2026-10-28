// Offline mode (PLAN §3 "Offline by default"; Benjamin's E9). `serve --embedded` and `serve --offline` set
// PARACHUTE_OFFLINE=1 (packages/cli/src/dispatch.ts). Then the hub makes no call off the machine on its own: no
// registry lookup for module versions and no Buzz relay poll or subscription.

/** True when this process runs offline (PARACHUTE_OFFLINE=1). */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.PARACHUTE_OFFLINE?.trim() ?? "");
}
