// What the 0.9.2 contracts share. They are door contracts (suites/door/_door.ts): HTTP and MCP only, the same file for
// every door. They describe ROADMAP 0.9.2 ("the dial works") before it is built, so each is wrapped in `red()` with
// the reason it fails today. A lane that makes one pass removes its `red()` in the same pull request.
import { door, mcp, mcpUrl, token, type Reply } from "../door/_door.ts";

export { must, red } from "../lib.ts";

/** The warnings a REST list carries: the `X-Parachute-Warnings` header (a JSON array, URI-encoded). */
export function restWarnings(r: Reply): { code: string; message?: string; [k: string]: unknown }[] {
  const h = r.headers.get("x-parachute-warnings");
  if (!h) return [];
  try {
    return JSON.parse(decodeURIComponent(h));
  } catch {
    return [];
  }
}

/** An admin MCP client on the run's second vault, for contracts that fill a vault with many types or fields. */
export async function otherMcp() {
  const name = door().otherVault;
  return mcp("admin", { url: mcpUrl(name), bearer: await token("admin", name) });
}

/** Text of a reply, for "does it name X" checks that shouldn't depend on where in the body the name sits. */
export const said = (v: unknown) => JSON.stringify(v ?? null);

/** The doctor's findings over REST (admin). */
export function findings(body: any): { type: string; [k: string]: unknown }[] {
  return Array.isArray(body?.findings) ? body.findings : [];
}
