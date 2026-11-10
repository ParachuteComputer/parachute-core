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
