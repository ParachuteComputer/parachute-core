// Consent phishing on the box (audit L3-04, the box side of cloud-identity F2), and the box's password lockout.
//
// The chain: anyone may register an OAuth client (public DCR), name it anything, and point it at any https host.
// Before the fix the consent page named the app and its client_id but never said where it sends you back, so
// "Parachute Console (official)" with redirect https://evil.example looked like Parachute's own. The box also carried
// a person's earlier trust in an app *by name* onto any newly registered client of that name (hub#409), with only a
// same-origin check that a plain link passes (no Origin or Referer falls back to the Host header): a stranger who
// registered "Claude" pointing at their own host got a code for the vault silently, without a consent page.
//
// Fixed in packages/hub: the consent page shows the redirect origin for every client; public DCR refuses a
// Parachute-looking client_name unless the registration is first-party, and caps client_name at 100 characters; the
// name carry-over applies only when every redirect of the new client goes where the trusted one's did.
// Mutants "consent-hides-redirect", "dcr-any-name", "dcr-name-uncapped" and "name-trust-any-redirect" put each back.
//
// The lockout part pins today's behaviour (green before the fix): the limiter counts before the password check, so a
// parallel burst can't slip extra guesses past it (cloud's L3-03 is the same check-then-act bug in a Durable Object).
//
// Candidate only (safety/). Logins: every password attempt from 127.0.0.1 counts against the box's per-IP ceiling
// (60 per 15 min) and each username's floor (5 per 15 min), shared with every other suite in the run, so this file
// signs in as users it creates (the admin's one shared session only creates them), and keeps its bursts small.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { runId, safeFetch, services } from "../lib.ts";
import { adminSession } from "../oauth.ts";

const s = services();
const HUB = new URL(s.hub).origin;
const READ = `vault:${s.vaultName}:read`;
// Users made through /api/users start with a temporary password and must change it before /oauth/authorize serves them.
const TEMP = "contracts-consent-temporary";
const PASSWORD = "contracts-consent-passphrase";

// ── helpers: HTTP only ──────────────────────────────────────────────────────────────────────────────────────

function cookie(r: Response, name: string): string | undefined {
  for (const c of r.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(";")[0]!.slice(name.length + 1);
}
const csrfIn = (html: string) => html.match(/name="__csrf"\s+value="([^"]+)"/)?.[1];

async function register(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await safeFetch(`${s.hub}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], ...body }),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json };
}

async function registered(name: string, redirect: string | string[], headers: Record<string, string> = {}): Promise<string> {
  const r = await register({ client_name: name, redirect_uris: [redirect].flat() }, headers);
  if (r.status !== 201) throw new Error(`setup: registering "${name}" gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.client_id as string;
}

let hostAdmin: string | null = null;
/** A made-up user on this box with the throwaway vault assigned (never the box's admin; see the header). */
async function newUser(label: string): Promise<string> {
  if (!hostAdmin) {
    // The admin SPA's way to a host-admin bearer: the admin's session (signed in once per run, suites/oauth.ts).
    const r = await safeFetch(`${s.hub}/admin/host-admin-token`, { headers: { cookie: `parachute_hub_session=${(await adminSession()).session}` } });
    const body: any = await r.json().catch(() => null);
    if (r.status !== 200 || typeof body?.token !== "string") throw new Error(`setup: /admin/host-admin-token gave ${r.status}`);
    hostAdmin = body.token as string;
  }
  const username = runId(label).toLowerCase();
  const r = await safeFetch(`${s.hub}/api/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${hostAdmin}`, "content-type": "application/json" },
    body: JSON.stringify({ username, password: TEMP, assigned_vaults: [s.vaultName] }),
  });
  if (r.status !== 201) throw new Error(`setup: creating user ${username} gave ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return username;
}

async function csrfPair(): Promise<{ token: string; cookie: string }> {
  const page = await safeFetch(`${s.hub}/login`, { redirect: "manual" });
  const c = cookie(page, "parachute_hub_csrf");
  const token = csrfIn(await page.text()) ?? c;
  if (!c || !token) throw new Error("setup: /login gave no CSRF cookie");
  return { token, cookie: c };
}

/** POST /login once; returns the status and the session cookie, if one was set. */
async function login(username: string, password: string, csrf: { token: string; cookie: string }) {
  const r = await safeFetch(`${s.hub}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf.cookie}` },
    body: new URLSearchParams({ __csrf: csrf.token, username, password }),
  });
  await r.arrayBuffer();
  return { status: r.status, session: cookie(r, "parachute_hub_session") };
}

/** Sign a made-up user in and change their temporary password, as they would on first sign-in. */
async function signIn(username: string): Promise<string> {
  const csrf = await csrfPair();
  const r = await login(username, TEMP, csrf);
  if (!r.session) throw new Error(`setup: signing in ${username} gave ${r.status} and no session`);
  const c = await safeFetch(`${s.hub}/account/change-password`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `parachute_hub_session=${r.session}; parachute_hub_csrf=${csrf.cookie}`,
      origin: HUB,
    },
    body: new URLSearchParams({ __csrf: csrf.token, current_password: TEMP, new_password: PASSWORD, new_password_confirm: PASSWORD }),
  });
  await c.arrayBuffer();
  if (c.status !== 302) throw new Error(`setup: changing ${username}'s temporary password gave ${c.status}`);
  return cookie(c, "parachute_hub_session") ?? r.session;
}

function authorizeParams(clientId: string, redirect: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  return {
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
    state: randomBytes(8).toString("hex"),
  };
}

/** GET /oauth/authorize as a browser following a plain link: a session cookie, no Origin, no Referer. */
async function authorize(session: string, params: Record<string, string>) {
  const r = await safeFetch(`${s.hub}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: { cookie: `parachute_hub_session=${session}` },
  });
  return { status: r.status, location: r.headers.get("location"), html: await r.text(), csrf: cookie(r, "parachute_hub_csrf") };
}

/** What a person reads on the page: no hidden inputs, no tags, no script or style. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<input\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The consent page for a client, as the signed-in user sees it. */
async function consentPage(session: string, clientId: string, redirect: string): Promise<string> {
  // Unnamed `vault:read` always shows the page (it needs the vault picker), even for a first-party client.
  const r = await authorize(session, authorizeParams(clientId, redirect, "vault:read"));
  if (r.status !== 200 || !r.html.includes('value="consent"')) {
    throw new Error(`setup: expected the consent page, got ${r.status} ${r.location ?? r.html.slice(0, 200)}`);
  }
  return r.html;
}

// ── 1. the consent page says where the app sends you back ───────────────────────────────────────────────────

describe("the consent page shows where the app sends you back", () => {
  let session: string;
  test("setup: a made-up user signs in", async () => {
    session = await signIn(await newUser("consent-viewer"));
  });

  test("a self-registered app: its redirect origin is in plain view next to its name", async () => {
    const redirect = "https://Consent-Phish.EXAMPLE:8443/auth/callback?x=1";
    const id = await registered("Contracts Phish App", redirect);
    const html = await consentPage(session, id, redirect);
    const text = visibleText(html);
    expect(text).toContain("Contracts Phish App");
    expect(text).toContain("https://consent-phish.example:8443");
    // In the card's header with the name, before the permissions, not buried below the form.
    const header = html.slice(html.indexOf("<h1"), html.indexOf('class="scopes"'));
    expect(visibleText(header)).toContain("https://consent-phish.example:8443");
  });

  test("a first-party app registered by a signed-in user on this hub: shown too", async () => {
    const redirect = `${HUB}/contracts-surface/oauth/callback`;
    const id = await registered("Contracts Own Surface", redirect, { cookie: `parachute_hub_session=${session}`, origin: HUB });
    expect(visibleText(await consentPage(session, id, redirect))).toContain(HUB);
  });

  test("a loopback app (a CLI or desktop client)", async () => {
    const redirect = "http://127.0.0.1:53682/callback";
    const id = await registered("Contracts CLI", redirect);
    expect(visibleText(await consentPage(session, id, redirect))).toContain("http://127.0.0.1:53682");
  });
});

// ── 2. public registration can't take Parachute's name ──────────────────────────────────────────────────────

describe("public registration refuses names that look like Parachute's own", () => {
  const evil = "https://consent-phish.example/cb";
  for (const name of [
    "Parachute",
    "Parachute Console (official)",
    "parachute notes",
    "PARACHUTE HUB",
    "My Para-chute Vault",
    "P.A.R.A.C.H.U.T.E",
    "Ｐａｒａｃｈｕｔｅ", // fullwidth
    "Pаrаchutе", // Cyrillic а and е
    "Раrасһutе", // six Cyrillic look-alikes: only the look-alike table catches it
    "ParachutᎬ", // Cherokee E, a letter the table lacks: only the "parachute with unknown letters" rule catches it
    "ᴘarachute", // small capital
    "Parachut3",
  ]) {
    test(`refused: ${JSON.stringify(name)} with a stranger's redirect`, async () => {
      const r = await register({ client_name: name, redirect_uris: [evil] });
      expect({ status: r.status, error: r.body?.error }).toEqual({ status: 400, error: "invalid_client_metadata" });
    });
  }

  test("refused when only some redirects are first-party", async () => {
    const r = await register({ client_name: "Parachute Notes", redirect_uris: [`${HUB}/oauth/callback`, evil] });
    expect({ status: r.status, error: r.body?.error }).toEqual({ status: 400, error: "invalid_client_metadata" });
  });

  test("client_name is capped at 100 characters", async () => {
    const at = await register({ client_name: "a".repeat(100), redirect_uris: [evil] });
    expect(at.status).toBe(201);
    for (const len of [101, 200_000]) {
      const r = await register({ client_name: "a".repeat(len), redirect_uris: [evil] });
      expect({ len, status: r.status, error: r.body?.error }).toEqual({ len, status: 400, error: "invalid_client_metadata" });
    }
  });

  test("other names are still accepted from anyone", async () => {
    for (const name of ["Claude", "Cursor", "Contracts Phish App", "Notes"]) {
      const r = await register({ client_name: name, redirect_uris: [evil] });
      expect({ name, status: r.status }).toEqual({ name, status: 201 });
    }
  });
});

describe("first-party clients keep their names", () => {
  // Every first-party registration found (PR body lists them): the Notes SPA ("Parachute Notes") on this hub's own
  // origin, at app.parachute.computer or my.parachute.computer, or a dev server on loopback; another Parachute hub
  // connecting as an agent ("Parachute Hub (agent connector)", redirect on that hub's origin); and anything the
  // hub's admin registers while signed in on this hub. (On this test box the hub's own origin is loopback, so the
  // hub-origin rows also pass as loopback; the unit tests in packages/hub cover a public hub origin.)
  for (const [name, redirect] of [
    ["Parachute Notes", `${HUB}/oauth/callback`],
    ["Parachute Notes", `${HUB}/notes/oauth/callback`],
    ["Parachute Notes", "https://app.parachute.computer/oauth/callback"],
    ["Parachute Notes", "https://my.parachute.computer/oauth/callback"],
    ["Parachute Notes", "http://localhost:5173/oauth/callback"],
    ["Parachute Notes", "http://127.0.0.1:5173/oauth/callback"],
    ["Parachute Notes", "http://[::1]:5173/oauth/callback"],
    ["Parachute Hub (agent connector)", "https://another-hub.example/admin/agent-grants/callback"],
  ] as const) {
    test(`accepted: ${name} → ${redirect}`, async () => {
      const r = await register({ client_name: name, redirect_uris: [redirect] });
      expect({ status: r.status, error: r.body?.error }).toEqual({ status: 201, error: undefined });
    });
  }

  test("accepted: any name from the hub's admin, signed in on this hub's own origin", async () => {
    const r = await register(
      { client_name: "Parachute Tasks", redirect_uris: ["https://tasks.example/cb"] },
      { cookie: `parachute_hub_session=${(await adminSession()).session}`, origin: HUB },
    );
    expect({ status: r.status, same_hub: r.body?.same_hub }).toEqual({ status: 201, same_hub: true });
  });

  test("refused: the same from another account's session (a friend can't pass an app off as Parachute's)", async () => {
    const session = await signIn(await newUser("consent-friend"));
    const r = await register(
      { client_name: "Parachute Tasks", redirect_uris: ["https://tasks.example/cb"] },
      { cookie: `parachute_hub_session=${session}`, origin: HUB },
    );
    expect({ status: r.status, error: r.body?.error }).toEqual({ status: 400, error: "invalid_client_metadata" });
  });
});

// ── 3. trust in an app's name doesn't follow a stranger's client ────────────────────────────────────────────

describe("earlier trust in an app's name", () => {
  let session: string;
  const trusted = "https://trusted-agent.example/oauth/callback";
  const name = `Contracts Agent ${randomBytes(3).toString("hex")}`;

  test("setup: a user approves the app once on the consent page", async () => {
    session = await signIn(await newUser("consent-truster"));
    const id = await registered(name, trusted);
    const params = authorizeParams(id, trusted, READ);
    const page = await authorize(session, params);
    expect(page.status).toBe(200);
    const csrf = page.csrf!;
    const r = await safeFetch(`${s.hub}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${csrf}`,
        origin: HUB,
      },
      body: new URLSearchParams({ ...params, __action: "consent", __csrf: csrfIn(page.html) ?? csrf, approve: "yes" }),
    });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).origin).toBe("https://trusted-agent.example");
  });

  test("a stranger's client of the same name gets the consent page, not a silent code", async () => {
    const evil = "https://consent-phish.example/oauth/callback";
    const id = await registered(name, evil);
    const r = await authorize(session, authorizeParams(id, evil, READ));
    const where = r.location ? new URL(r.location, HUB) : null;
    expect({ status: r.status, codeSentTo: where?.searchParams.get("code") ? where.origin : null }).toEqual({ status: 200, codeSentTo: null });
    expect(r.html).toContain('value="consent"');
  });

  test("a stranger's client listing the trusted redirect beside its own gets the consent page for either", async () => {
    // The grant recorded for a client covers every redirect it registered, so trust carried for the trusted one
    // would let the next link send the code to the stranger's.
    const evil = "https://consent-phish.example/oauth/callback";
    const id = await registered(name, [trusted, evil]);
    for (const redirect of [trusted, evil]) {
      const r = await authorize(session, authorizeParams(id, redirect, READ));
      expect({ redirect, status: r.status }).toEqual({ redirect, status: 200 });
    }
  });

  test("the app itself, registered again (same redirect origin), still reconnects silently", async () => {
    const again = `${new URL(trusted).origin}/oauth/callback?session=2`;
    const id = await registered(name, again);
    const r = await authorize(session, authorizeParams(id, again, READ));
    expect(r.status).toBe(302);
    const where = new URL(r.location!);
    expect(where.origin).toBe("https://trusted-agent.example");
    expect(where.searchParams.get("code")).toBeString();
  });

  test("a loopback app on a new port reconnects silently (CLI clients pick a fresh port each run)", async () => {
    const cli = `Contracts CLI ${randomBytes(3).toString("hex")}`;
    const first = "http://127.0.0.1:41001/callback";
    const id1 = await registered(cli, first);
    const p1 = authorizeParams(id1, first, READ);
    const page = await authorize(session, p1);
    expect(page.status).toBe(200);
    const ok = await safeFetch(`${s.hub}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `parachute_hub_session=${session}; parachute_hub_csrf=${page.csrf}`,
        origin: HUB,
      },
      body: new URLSearchParams({ ...p1, __action: "consent", __csrf: csrfIn(page.html) ?? page.csrf!, approve: "yes" }),
    });
    expect(ok.status).toBe(302);
    const next = "http://localhost:41999/callback";
    const id2 = await registered(cli, next);
    const r = await authorize(session, authorizeParams(id2, next, READ));
    expect(r.status).toBe(302);
    expect(new URL(r.location!).searchParams.get("code")).toBeString();
  });
});

// ── 3b. the consent page says what the connection can read (0.9.1, T-446; SPEC §3.4) ─────────────────────
// A vault scope reaches the whole vault at its level, and what an app reads goes to whoever runs it. The page says
// both, for read and for write (a write grant reads everything too: never less than it can do). A snapshot of the
// permissions section as a person reads it, with the vault's name written <vault>. Red before T-446: the read row
// said "Read your notes, tags, attachments, and vault config.", the write row didn't say it reads, and nothing said
// where what it reads goes.

describe("the consent page says what the connection can read", () => {
  let session: string;
  const redirect = "https://fernhill-bakery.example/oauth/callback";
  let id: string;
  const permissions = async (scope: string) => {
    const r = await authorize(session, authorizeParams(id, redirect, scope));
    if (r.status !== 200 || !r.html.includes('value="consent"')) throw new Error(`setup: expected the consent page for ${scope}, got ${r.status}`);
    const section = r.html.slice(r.html.indexOf('<section class="scopes"'), r.html.indexOf("</section>", r.html.indexOf('<section class="scopes"')));
    return visibleText(section).trim().split(s.vaultName).join("<vault>");
  };

  test("setup: a made-up user signs in; an app registers itself", async () => {
    session = await signIn(await newUser("consent-reach"));
    id = await registered("Fernhill Planner", redirect);
  });

  test("read: the whole vault, and where it goes", async () => {
    expect(await permissions(READ)).toBe(
      "Permissions requested vault:<vault>:read read Read the whole vault: every note, tag and attachment, and its settings. What this app reads from your vault goes to the company that runs it.",
    );
  });

  test("write: it reads the whole vault too", async () => {
    expect(await permissions(`vault:${s.vaultName}:write`)).toBe(
      "Permissions requested vault:<vault>:write write Read the whole vault. Create, edit, and delete notes and attachments, and apply existing tags to them. What this app reads from your vault goes to the company that runs it.",
    );
  });
});

// ── 4. the box's lockout holds under a parallel burst ───────────────────────────────────────────────────────

describe("a parallel burst of wrong passwords locks the account out at the limit", () => {
  const LIMIT = 5; // per username and IP, per 15 minutes (packages/hub/src/rate-limit.ts MAX_ATTEMPTS)
  const BURST = 12;
  const tally = (rs: { status: number; session?: string }[]) => ({
    checked: rs.filter((r) => r.status === 401 || (r.status === 302 && r.session)).length,
    limited: rs.filter((r) => r.status === 429).length,
    limitedWithSession: rs.filter((r) => r.status === 429 && r.session).length,
  });

  test("control: a fresh made-up user signs in with the right password", async () => {
    const r = await login(await newUser("consent-control"), TEMP, await csrfPair());
    expect(r.status).toBe(302);
    expect(r.session).toBeString();
  });

  test("POST /login: only the first five reach the password check; the right password after them gets no session", async () => {
    const user = await newUser("consent-burst");
    const csrf = await csrfPair();
    // The right password rides last in the burst. Whatever order the box takes them in, exactly five reach the
    // password check (401, or 302 with a session if the right one was among them); every other one is refused unread.
    const tries = [...Array.from({ length: BURST - 1 }, (_, i) => `wrong-${i}-passphrase`), TEMP];
    const results = await Promise.all(tries.map((p) => login(user, p, csrf)));
    expect(tally(results)).toEqual({ checked: LIMIT, limited: BURST - LIMIT, limitedWithSession: 0 });
    const right = await login(user, TEMP, csrf);
    expect({ status: right.status, session: right.session ?? null }).toEqual({ status: 429, session: null });
  });

  test("the /oauth/authorize password door: the same, and it shares the account's bucket with /login", async () => {
    const user = await newUser("consent-door");
    const id = await registered("Contracts Door App", "https://door-app.example/cb");
    const params = authorizeParams(id, "https://door-app.example/cb", READ);
    // The door's form posts here (the page renders it for an approved client and a browser with no session); the
    // limiter runs before anything about the client is checked, so the post is all that matters.
    const csrf = await csrfPair();
    const door = async (password: string) => {
      const r = await safeFetch(`${s.hub}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `parachute_hub_csrf=${csrf.cookie}`, origin: HUB },
        body: new URLSearchParams({ ...params, __action: "login", __csrf: csrf.token, username: user, password }),
      });
      await r.arrayBuffer();
      return { status: r.status, session: cookie(r, "parachute_hub_session") };
    };
    const tries = [...Array.from({ length: BURST - 1 }, (_, i) => `wrong-${i}-passphrase`), TEMP];
    const results = await Promise.all(tries.map((p) => door(p)));
    expect(tally(results)).toEqual({ checked: LIMIT, limited: BURST - LIMIT, limitedWithSession: 0 });
    const right = await door(TEMP);
    expect({ status: right.status, session: right.session ?? null }).toEqual({ status: 429, session: null });
    // One bucket per account: /login is closed for this user too.
    const viaLogin = await login(user, TEMP, await csrfPair());
    expect({ status: viaLogin.status, session: viaLogin.session ?? null }).toEqual({ status: 429, session: null });
  });
});
