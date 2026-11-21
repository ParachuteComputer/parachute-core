/**
 * Copy-paste MCP connect URLs and Claude Code commands.
 *
 * Humans are pointed at (T-476, one address for an AI):
 *   - `/mcp` — the one address: the account door. On the approval page the
 *     person gives the AI all their vaults (and leave to make new ones) or
 *     only some, each at a level.
 *   - `/vault/<name>/mcp` — just one vault, the narrow choice.
 *
 * `/account/mcp` is the same door by its own name (shipped apps read it from
 * the descriptor); human-facing copy says `/mcp`.
 */

/** `<hub-origin>/vault/<name>/mcp` — one assigned vault. */
export function assignedVaultMcpEndpoint(trimmedOrigin: string, vaultName: string): string {
  return `${trimmedOrigin}/vault/${vaultName}/mcp`;
}

/** OAuth `claude mcp add` for one assigned vault. Server name `parachute-<name>`. */
export function assignedVaultClaudeMcpAddCommand(trimmedOrigin: string, vaultName: string): string {
  return `claude mcp add --transport http parachute-${vaultName} ${assignedVaultMcpEndpoint(
    trimmedOrigin,
    vaultName,
  )}`;
}

/** `<hub-origin>/mcp` — the one address: every vault the person gives the AI. */
export function rootMcpEndpoint(trimmedOrigin: string): string {
  return `${trimmedOrigin}/mcp`;
}

/** OAuth `claude mcp add` for the hub root. Server name `parachute`. */
export function rootClaudeMcpAddCommand(trimmedOrigin: string): string {
  return `claude mcp add --transport http parachute ${rootMcpEndpoint(trimmedOrigin)}`;
}

/** `<hub-origin>/account/mcp` — honest single-family discovery door. */
export function accountMcpEndpoint(trimmedOrigin: string): string {
  return `${trimmedOrigin}/account/mcp`;
}

/** OAuth `claude mcp add` for `/account/mcp`. Server name `parachute-account`. */
export function accountClaudeMcpAddCommand(trimmedOrigin: string): string {
  return `claude mcp add --transport http parachute-account ${accountMcpEndpoint(trimmedOrigin)}`;
}
