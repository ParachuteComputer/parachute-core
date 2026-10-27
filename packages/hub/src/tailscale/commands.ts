export interface ServeEntry {
  kind: "proxy" | "file";
  mount: string;
  target: string;
  service: string;
}

export interface BringupOpts {
  funnel?: boolean;
  port?: number;
}

/**
 * Funnel was a flag on `tailscale serve` through ~1.80; from 1.82 onward
 * it's a separate `tailscale funnel` subcommand with the same syntax minus
 * the `--funnel` flag. Modern tailscale (1.82+) rejects `serve --funnel`
 * outright: "flag provided but not defined: -funnel". Pick the subcommand
 * up-front; we don't support the pre-split syntax.
 */
function serveVerb(funnel: boolean): string {
  return funnel ? "funnel" : "serve";
}

export function bringupCommand(entry: ServeEntry, opts: BringupOpts = {}): string[] {
  const port = opts.port ?? 443;
  const funnel = opts.funnel === true;
  return [
    "tailscale",
    serveVerb(funnel),
    "--bg",
    `--https=${port}`,
    `--set-path=${entry.mount}`,
    entry.target,
  ];
}

export function teardownCommand(entry: ServeEntry, opts: BringupOpts = {}): string[] {
  const port = opts.port ?? 443;
  const funnel = opts.funnel === true;
  return ["tailscale", serveVerb(funnel), `--https=${port}`, `--set-path=${entry.mount}`, "off"];
}
