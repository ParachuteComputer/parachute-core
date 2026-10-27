// The probes embedded/hostile-local makes: admin, module and token routes, called from loopback (as any process of
// the same user can), with no credential or with one that isn't enough. Every answer must be a 4xx refusal, and
// afterwards nothing they asked for has happened (effects(), below).
import { safeFetch } from "../candidate-lib.ts";

/** Routes only the operator (or a signed-in admin) may use. Made-up bodies; a refusal must come before parsing. */
export function adminRoutes(vaultName: string, operatorJti: string): [string, string, unknown?][] {
  return [
    ["GET", "/api/modules"],
    ["GET", "/api/hub"],
    ["POST", "/api/hub/upgrade", {}],
    ["POST", "/api/modules/vault/install", {}],
    ["POST", "/api/modules/vault/upgrade", {}],
    ["POST", "/api/modules/vault/restart", {}],
    ["POST", "/api/modules/vault/stop", {}],
    ["POST", "/api/modules/vault/uninstall", {}],
    ["POST", "/api/auth/mint-token", { scope: "parachute:host:admin" }],
    ["GET", "/api/auth/tokens"],
    ["GET", "/api/users"],
    ["POST", "/api/users", { username: "intruder", password: "made-up-password-123" }],
    ["PUT", "/api/settings/hub-origin", { hub_origin: "https://attacker.example.test" }],
    ["GET", "/admin/host-admin-token"],
    ["GET", "/admin/module-token/scribe"],
    ["GET", `/admin/vault-admin-token/${vaultName}`],
    ["PUT", `/vault/${vaultName}/api/tags/hostile-schema`, { description: "x", fields: { f: { type: "string" } } }],
    // Last, since it would end the operator's token if it got through.
    ["POST", "/api/auth/revoke-token", { jti: operatorJti }],
  ];
}

/** Call each route with `token` (or none) and return the ones that weren't refused with a 4xx. */
export async function notRefused(hub: string, vaultName: string, operatorJti: string, token: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const [method, path, body] of adminRoutes(vaultName, operatorJti)) {
    const r = await safeFetch(`${hub}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // Spoofed hints that a request is local or forwarded must not count for anything.
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await r.arrayBuffer();
    if (r.status < 400 || r.status > 499) out.push(`${method} ${path} → ${r.status}`);
  }
  return out;
}

/** A token with its signature broken (the last bytes changed): a forgery any local process could make. */
export function forged(token: string): string {
  const [h, p, s] = token.split(".");
  return `${h}.${p}.${s!.slice(0, -4)}${s!.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
}

/** After the probes: the operator's token still works, no account was added, and the vault still serves. */
export async function effects(hub: string, vaultBase: string, vaultName: string, operator: string, write: string): Promise<string[]> {
  const out: string[] = [];
  const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
  const modules = await safeFetch(`${hub}/api/modules`, auth(operator));
  if (modules.status !== 200) out.push(`the operator's token no longer works (GET /api/modules → ${modules.status})`);
  await modules.arrayBuffer();
  const users = await safeFetch(`${hub}/api/users`, auth(operator));
  const text = await users.text();
  if (users.status === 200 && text.includes("intruder")) out.push("an account named intruder was created");
  const notes = await safeFetch(`${vaultBase}/vault/${vaultName}/api/notes?limit=1`, auth(write));
  if (notes.status !== 200) out.push(`the vault stopped serving (GET notes → ${notes.status})`);
  await notes.arrayBuffer();
  return out;
}
