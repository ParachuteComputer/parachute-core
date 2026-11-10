// The box as a door: the built candidate, started the way a user starts it (harness/candidate.ts), with its admin
// signed in the way a person signs in: the login form.
import type { CandidateInfo } from "../candidate.ts";
import { startCandidateBox } from "../candidate.ts";
import { safeFetch } from "../guard.ts";

function cookie(r: Response, name: string): string | undefined {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
}

/** The admin's session as a cookie header. One sign-in per run: the box locks out after five wrong or repeated tries. */
export async function signInAdmin(hub: string, admin: { username: string; password: string }): Promise<{ cookie: string; csrf: string }> {
  const page = await safeFetch(`${hub}/login`);
  const csrf = cookie(page, "parachute_hub_csrf");
  const field = (await page.text()).match(/name="__csrf"\s+value="([^"]+)"/)?.[1];
  const login = await safeFetch(`${hub}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf}` },
    body: new URLSearchParams({ __csrf: field ?? csrf ?? "", ...admin }),
  });
  const session = cookie(login, "parachute_hub_session");
  if (!session || !csrf) throw new Error(`door: the box admin's sign-in gave ${login.status} and no session`);
  return { cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}`, csrf };
}

export async function startBoxDoor(info: CandidateInfo, opts: { keep?: boolean } = {}) {
  const running = await startCandidateBox(info, opts);
  try {
    const s = running.services;
    const session = await signInAdmin(s.hub, s.admin);
    return { running, issuer: s.hub, vaultOrigin: s.hub, vault: s.vaultName, session, admin: s.admin };
  } catch (err) {
    await running.stop();
    throw err;
  }
}

/**
 * Link a sign-in key to the box admin's account, the box's own way: ask for a challenge, sign the event the hub
 * hands back, present it with the admin's password again, since it is the account's first key
 * (`/api/account/pubkeys/challenge`, then `/verify`; cookie session and CSRF). A cloud-style
 * door links a key with one call on the account door instead; the difference is named in deliberate.json.
 */
export async function linkOwnerKeyOnBox(hub: string, session: { cookie: string; csrf: string }, secretKey: string, password: string): Promise<void> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const { createHash } = await import("node:crypto");
  const post = (path: string, body: Record<string, unknown>) =>
    safeFetch(`${hub}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: hub, cookie: session.cookie },
      body: JSON.stringify({ __csrf: session.csrf, ...body }),
    });
  const asked = await post("/api/account/pubkeys/challenge", {});
  const ch: any = await asked.json().catch(() => ({}));
  if (!asked.ok || !ch.event_template) throw new Error(`door: the box's key challenge gave ${asked.status}: ${JSON.stringify(ch).slice(0, 200)}`);
  const sk = Buffer.from(secretKey, "hex");
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  const t = ch.event_template;
  const created_at = typeof t.created_at === "number" ? t.created_at : Math.floor(Date.now() / 1000);
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, created_at, t.kind, t.tags, t.content])).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), sk)).toString("hex");
  const done = await post("/api/account/pubkeys/verify", { event: { id, pubkey, created_at, kind: t.kind, tags: t.tags, content: t.content, sig }, label: "door contracts", password });
  if (!done.ok) throw new Error(`door: linking the owner key on the box gave ${done.status}: ${(await done.text()).slice(0, 300)}`);
}
