// Sharing a vault with a friend (T-476; share-invites.ts, api-share-invites.ts; app docs/design/SHARING.md), through
// the hub's own fetch handler with a real hub.db: the owner invites by name with their key (account MCP), the friend
// reads the invite and accepts it with their key, the friend is a member and named, names answer only a vault's own
// people, and ending the share ends the friend's names read. Plus the doors that must stay shut.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { shareInviteRateLimiter } from "../api-share-invites.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { listInvites } from "../invites.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import { bindPubkeyFromHttpAuth } from "../pubkey-links.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser, vaultVerbsForUserVault } from "../users.ts";

const ORIGIN = "http://127.0.0.1:1939";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (byte: string) => {
  const secret = Uint8Array.from(Buffer.from(byte.repeat(32), "hex"));
  return { secret, pubkey: hex(schnorr.getPublicKey(secret)) };
};
const AARON = key("11");
const BO = key("22");
const STRANGER = key("33");

function signed(secret: Uint8Array, url: string, body: string): string {
  const unsigned = {
    pubkey: hex(schnorr.getPublicKey(secret)),
    created_at: Math.floor(Date.now() / 1000),
    kind: NOSTR_AUTH_KIND,
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")],
    ],
    content: `${Math.random()}`,
  };
  const id = nostrEventId(unsigned);
  const event: NostrEvent = {
    ...unsigned,
    id,
    sig: hex(schnorr.sign(Uint8Array.from(Buffer.from(id, "hex")), secret)),
  };
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
}

let dir: string;
let db: Database;
let ownerId: string;
let fetchHub: (req: Request) => Promise<Response>;

beforeEach(async () => {
  shareInviteRateLimiter.reset();
  dir = mkdtempSync(join(tmpdir(), "phub-share-"));
  db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  writeFileSync(
    join(dir, "services.json"),
    JSON.stringify({
      services: [
        {
          name: "parachute-vault",
          port: 4101,
          paths: ["/vault/recipes", "/vault/journal"],
          health: "/health",
          version: "0.9.0",
        },
      ],
    }),
  );
  ownerId = (
    await createUser(db, "owner", "correct-horse-battery-staple", { passwordChanged: true })
  ).id;
  bindPubkeyFromHttpAuth(db, {
    userId: ownerId,
    pubkey: AARON.pubkey,
    proofEvent: "{}",
    proofEventId: "a".repeat(64),
    label: "test",
    now: new Date(),
  });
  const f = hubFetch(dir, { getDb: () => db, manifestPath: join(dir, "services.json") });
  fetchHub = async (req) => (await f(req)) as Response;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One account-MCP tool, signed by `who`'s key, or carried by a bearer. */
async function tool(
  who: { secret: Uint8Array } | { bearer: string },
  name: string,
  args: Record<string, unknown>,
) {
  const url = `${ORIGIN}/account/mcp`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const authorization = "bearer" in who ? `Bearer ${who.bearer}` : signed(who.secret, url, body);
  const res = await fetchHub(
    new Request(url, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    }),
  );
  const text = await res.text();
  const json = JSON.parse(
    text.startsWith("{")
      ? text
      : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5),
  ) as {
    result?: { isError?: boolean; content: { text: string }[] };
  };
  const inner = json.result?.content?.[0]?.text;
  return {
    status: res.status,
    isError: json.result?.isError === true || !json.result,
    body: inner
      ? (() => {
          try {
            return JSON.parse(inner);
          } catch {
            return inner;
          }
        })()
      : null,
  };
}

async function friendCall(path: "look" | "accept", code: unknown, signer?: { secret: Uint8Array }) {
  const url = `${ORIGIN}/account/invites/${path}`;
  const body = JSON.stringify({ code });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signer) headers.authorization = signed(signer.secret, url, body);
  const res = await fetchHub(new Request(url, { method: "POST", headers, body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const userOf = (pubkey: string) =>
  db
    .query<{ user_id: string }, [string]>("SELECT user_id FROM user_pubkeys WHERE pubkey = ?")
    .get(pubkey)?.user_id ?? null;

async function vaultToken(sub: string, vault = "recipes"): Promise<string> {
  return (
    await signAccessToken(db, {
      sub,
      scopes: [`vault:${vault}:read`, `vault:${vault}:write`],
      audience: `vault.${vault}`,
      clientId: "parachute-app",
      issuer: ORIGIN,
      ttlSeconds: 600,
    })
  ).token;
}

async function names(token: string, stamps: string[], vault = "recipes") {
  const q = stamps.map((s) => `by=${encodeURIComponent(s)}`).join("&");
  const res = await fetchHub(
    new Request(`${ORIGIN}/account/vaults/${vault}/names?${q}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as { names?: Record<string, { name: string | null; you: boolean }> },
  };
}

async function invite(name = "Bo", from: string | undefined = "Aaron") {
  const r = await tool(AARON, "invite-to-vault", {
    vault: "recipes",
    name,
    ...(from ? { from } : {}),
  });
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return r.body as { id: string; code: string; url: string; expires_at: string };
}

describe("Aaron invites Bo to recipes; Bo accepts with his own key", () => {
  test("invite, look, accept: Bo is a member of recipes (never admin), named Bo; Aaron is Aaron", async () => {
    const inv = await invite();
    expect(inv.url).toBe(`${ORIGIN}/invite#${inv.code}`);
    expect(inv.code.length).toBeGreaterThanOrEqual(40);

    // Bo reads it first; nothing is used
    const look = await friendCall("look", inv.code);
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({
      vault: "recipes",
      from: "Aaron",
      name: "Bo",
      can: "read and write",
    });
    expect((await friendCall("look", inv.code)).status).toBe(200);

    // Aaron's list shows the open invite
    const before = await tool(AARON, "list-access", { vault: "recipes" });
    expect(before.body.invites).toEqual([{ id: inv.id, name: "Bo", expires_at: inv.expires_at }]);

    const accepted = await friendCall("accept", inv.code, BO);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ vault: "recipes", from: "Aaron", name: "Bo" });
    const bo = userOf(BO.pubkey);
    expect(bo).not.toBeNull();
    expect(vaultVerbsForUserVault(db, bo!, "recipes")).toEqual(["read", "write"]);
    expect(vaultVerbsForUserVault(db, bo!, "journal")).toBeNull();

    // the list: Bo by name, the invite gone
    const after = await tool(AARON, "list-access", { vault: "recipes" });
    expect(after.body.invites).toEqual([]);
    expect(after.body.access).toEqual([
      expect.objectContaining({
        pubkey: BO.pubkey,
        vault: "recipes",
        role: "member",
        name: "Bo",
        granted_via: "invite",
      }),
    ]);

    // names: each reads the other by name, and themselves as you
    const asBo = await names(await vaultToken(bo!), [ownerId, bo!]);
    expect(asBo.status).toBe(200);
    expect(asBo.body.names).toEqual({
      [ownerId]: { name: "Aaron", you: false },
      [bo!]: { name: "Bo", you: true },
    });
    const asAaron = await names(await vaultToken(ownerId), [ownerId, bo!]);
    expect(asAaron.body.names).toEqual({
      [ownerId]: { name: "Aaron", you: true },
      [bo!]: { name: "Bo", you: false },
    });
  });

  test("the invite works once: a second accept, by Bo or anyone, is the one 404", async () => {
    const inv = await invite();
    expect((await friendCall("accept", inv.code, BO)).status).toBe(200);
    for (const k of [BO, STRANGER]) {
      const again = await friendCall("accept", inv.code, k);
      expect(again.status).toBe(404);
      expect(again.body.error).toBe("no_invite");
    }
    expect(userOf(STRANGER.pubkey)).toBeNull();
    expect((await friendCall("look", inv.code)).status).toBe(404);
  });

  test("two accepts at once: exactly one wins, the other is the 404 and gets no role", async () => {
    const inv = await invite();
    const both = await Promise.all([
      friendCall("accept", inv.code, BO),
      friendCall("accept", inv.code, STRANGER),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 404]);
    const members = [BO, STRANGER]
      .map((k) => userOf(k.pubkey))
      .filter((u) => u && vaultVerbsForUserVault(db, u, "recipes"));
    expect(members.length).toBe(1);
  });

  test("taken back, it opens nothing; a made-up code and a wrong-shaped one read the same 404", async () => {
    const inv = await invite();
    const back = await tool(AARON, "take-back-invite", { vault: "recipes", id: inv.id });
    expect(back.body).toMatchObject({ taken_back: true });
    for (const code of [inv.code, "A".repeat(43), 42, null, "../../etc"]) {
      expect((await friendCall("look", code)).status).toBe(404);
      expect((await friendCall("accept", code, BO)).status).toBe(404);
    }
    expect(userOf(BO.pubkey)).toBeNull();
  });

  test("accepting needs Bo's signature: unsigned, or signed for another address, is 401 and uses nothing", async () => {
    const inv = await invite();
    expect((await friendCall("accept", inv.code)).status).toBe(401);
    const body = JSON.stringify({ code: inv.code });
    const wrongU = signed(BO.secret, `${ORIGIN}/account/invites/look`, body);
    const res = await fetchHub(
      new Request(`${ORIGIN}/account/invites/accept`, {
        method: "POST",
        headers: { authorization: wrongU, "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(401);
    // and a signature over another body (another code) doesn't carry over
    const other = signed(
      BO.secret,
      `${ORIGIN}/account/invites/accept`,
      JSON.stringify({ code: "x".repeat(43) }),
    );
    const res2 = await fetchHub(
      new Request(`${ORIGIN}/account/invites/accept`, {
        method: "POST",
        headers: { authorization: other, "content-type": "application/json" },
        body,
      }),
    );
    expect(res2.status).toBe(401);
    expect((await friendCall("look", inv.code)).status).toBe(200);
  });

  test("the owner's own key accepting is refused and the invite stays open", async () => {
    const inv = await invite();
    expect((await friendCall("accept", inv.code, AARON)).status).toBe(404);
    expect((await friendCall("look", inv.code)).status).toBe(200);
  });

  test("ending the share: Bo is no longer a member, his names read is refused, and his old writes keep his name", async () => {
    const inv = await invite();
    await friendCall("accept", inv.code, BO);
    const bo = userOf(BO.pubkey)!;
    const token = await vaultToken(bo);
    expect((await names(token, [bo])).status).toBe(200);

    const ended = await tool(AARON, "revoke-access", { pubkey: BO.pubkey, vault: "recipes" });
    expect(ended.body).toMatchObject({ revoked: true });
    expect(vaultVerbsForUserVault(db, bo, "recipes")).toBeNull();
    expect((await names(token, [bo])).status).toBe(401);
    // Aaron still reads Bo's name on the stamps Bo left
    expect((await names(await vaultToken(ownerId), [bo])).body.names).toEqual({
      [bo]: { name: "Bo", you: false },
    });
  });
});

describe("who may invite", () => {
  test("Bo (a member) can't invite, list or take back; nor can a vault token's bearer or a key the hub doesn't know", async () => {
    const inv = await invite();
    await friendCall("accept", inv.code, BO);
    const second = await invite("Cy");
    for (const [name, args] of [
      ["invite-to-vault", { vault: "recipes", name: "Mallory" }],
      ["list-access", { vault: "recipes" }],
      ["take-back-invite", { vault: "recipes", id: second.id }],
    ] as const) {
      expect((await tool(BO, name, args)).isError, `${name} by Bo`).toBe(true);
      expect(
        (await tool({ bearer: await vaultToken(ownerId) }, name, args)).isError,
        `${name} by a vault token`,
      ).toBe(true);
      expect((await tool(STRANGER, name, args)).isError, `${name} by a stranger`).toBe(true);
    }
    expect((await friendCall("look", second.code)).status).toBe(200);
  });

  test("admin on one vault invites to that vault only: a member of recipes who runs journal can't invite to recipes", async () => {
    const CY = key("44");
    const cy = (
      await createUser(db, "cy", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: [],
      })
    ).id;
    bindPubkeyFromHttpAuth(db, {
      userId: cy,
      pubkey: CY.pubkey,
      proofEvent: "{}",
      proofEventId: "c".repeat(64),
      label: "test",
      now: new Date(),
    });
    expect(
      (await tool(AARON, "grant-access", { pubkey: CY.pubkey, vault: "journal", role: "write" }))
        .isError,
    ).toBe(false);
    expect(
      (await tool(AARON, "grant-access", { pubkey: CY.pubkey, vault: "recipes", role: "member" }))
        .isError,
    ).toBe(false);
    expect((await tool(CY, "invite-to-vault", { vault: "journal", name: "Dee" })).isError).toBe(
      false,
    );
    const toRecipes = await tool(CY, "invite-to-vault", { vault: "recipes", name: "Mallory" });
    expect(toRecipes.isError).toBe(true);
    const open = await tool(AARON, "list-access", { vault: "recipes" });
    expect(open.body.invites).toEqual([]);
  });

  test("a name is checked: empty, too long, a control character or 'You' is refused", async () => {
    for (const name of ["", "   ", "x".repeat(41), "Bo\u0000", "Bo‮", "you"]) {
      expect(
        (await tool(AARON, "invite-to-vault", { vault: "recipes", name })).isError,
        JSON.stringify(name),
      ).toBe(true);
    }
    expect((await tool(AARON, "invite-to-vault", { vault: "nope", name: "Bo" })).isError).toBe(
      true,
    );
  });
});

describe("a share invite is not an account invite", () => {
  test("the password page doesn't redeem it, and /api/invites doesn't list it", async () => {
    const inv = await invite();
    const page = await fetchHub(new Request(`${ORIGIN}/account/setup/${inv.code}`));
    expect(await page.text()).not.toContain("recipes");
    const post = await fetchHub(
      new Request(`${ORIGIN}/account/setup/${inv.code}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "username=mallory&password=correct-horse-battery-staple-1&password_confirm=correct-horse-battery-staple-1",
      }),
    );
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(db.query("SELECT id FROM users WHERE username = 'mallory'").get()).toBeNull();
    expect(listInvites(db).map((i) => i.tokenHash)).not.toContain(inv.id);
    expect((await friendCall("look", inv.code)).status).toBe(200);
  });
});

describe("what the review found (round 1)", () => {
  const cyWith = async (roles: Record<string, "read" | "member" | "write">) => {
    const CY = key("44");
    for (const [vault, role] of Object.entries(roles)) {
      expect((await tool(AARON, "grant-access", { pubkey: CY.pubkey, vault, role })).isError).toBe(
        false,
      );
    }
    return { ...CY, id: userOf(CY.pubkey)! };
  };

  test("an invite holds only while its maker can run the vault: Cy's invite dies when Aaron takes Cy's role away", async () => {
    const cy = await cyWith({ recipes: "write" });
    const made = await tool(cy, "invite-to-vault", { vault: "recipes", name: "Dee" });
    expect(made.isError, JSON.stringify(made.body)).toBe(false);
    expect((await friendCall("look", made.body.code)).status).toBe(200);
    expect(
      (await tool(AARON, "revoke-access", { pubkey: cy.pubkey, vault: "recipes" })).body,
    ).toMatchObject({ revoked: true });
    expect((await friendCall("look", made.body.code)).status).toBe(404);
    expect((await friendCall("accept", made.body.code, STRANGER)).status).toBe(404);
    expect(userOf(STRANGER.pubkey)).toBeNull();
  });

  test("someone already on the vault can't use an invite to change their role, and the invite stays open", async () => {
    const cy = await cyWith({ recipes: "read" });
    const inv = await invite("Cy");
    expect((await friendCall("accept", inv.code, cy)).status).toBe(404);
    expect(vaultVerbsForUserVault(db, cy.id, "recipes")).toEqual(["read"]);
    expect((await friendCall("look", inv.code)).status).toBe(200);
  });

  test("taking back is the vault's owner's: Cy, who runs journal, can't take back an invite to recipes", async () => {
    const cy = await cyWith({ journal: "write" });
    const inv = await invite();
    expect((await tool(cy, "take-back-invite", { vault: "recipes", id: inv.id })).isError).toBe(
      true,
    );
    expect((await friendCall("look", inv.code)).status).toBe(200);
  });

  test("an app's or an AI's connection (OAuth, account:vaults) can't invite or take back, and isn't shown the tools", async () => {
    const connector = (
      await signAccessToken(db, {
        sub: ownerId,
        scopes: ["account:vaults"],
        audience: "account",
        clientId: "claude-connector",
        issuer: ORIGIN,
        ttlSeconds: 600,
      })
    ).token;
    expect(
      (await tool({ bearer: connector }, "invite-to-vault", { vault: "recipes", name: "Mallory" }))
        .isError,
    ).toBe(true);
    const inv = await invite();
    expect(
      (await tool({ bearer: connector }, "take-back-invite", { vault: "recipes", id: inv.id }))
        .isError,
    ).toBe(true);
    expect((await friendCall("look", inv.code)).status).toBe(200);
    const url = `${ORIGIN}/account/mcp`;
    const res = await fetchHub(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connector}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const text = await res.text();
    expect(text).toContain("list-access");
    expect(text).not.toContain("invite-to-vault");
  });

  test("the losing accept of two leaves no hub user behind for its key", async () => {
    const inv = await invite();
    const DEE = key("55");
    const both = await Promise.all([
      friendCall("accept", inv.code, BO),
      friendCall("accept", inv.code, DEE),
    ]);
    const lost = both[0].status === 200 ? DEE : BO;
    expect(userOf(lost.pubkey)).toBeNull();
  });

  test("a name may carry a joiner (Persian names, emoji sequences), not a bidi override", async () => {
    expect(
      (await tool(AARON, "invite-to-vault", { vault: "recipes", name: "می\u200cخواهم" })).isError,
    ).toBe(false);
    expect(
      (await tool(AARON, "invite-to-vault", { vault: "recipes", name: "Bo\u202e" })).isError,
    ).toBe(true);
  });
});

describe("names", () => {
  test("only a vault's people are named: someone with no tie to recipes is left out, and a token for another vault is refused", async () => {
    const outsider = (
      await createUser(db, "cy", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["journal"],
      })
    ).id;
    db.prepare("UPDATE users SET display_name = 'Cy' WHERE id = ?").run(outsider);
    const r = await names(await vaultToken(ownerId), [outsider, ownerId, "not-a-user"]);
    expect(Object.keys(r.body.names ?? {})).toEqual([ownerId]);
    expect((await names(await vaultToken(ownerId, "journal"), [ownerId])).status).toBe(401);
    expect((await names(await vaultToken(outsider), [ownerId])).status).toBe(401);
  });

  test("asked for no stamp, names answers every person of the vault, an ended member too, and no one else", async () => {
    const inv = await invite();
    await friendCall("accept", inv.code, BO);
    const bo = userOf(BO.pubkey)!;
    await tool(AARON, "revoke-access", { pubkey: BO.pubkey, vault: "recipes" });
    await createUser(db, "cy", "correct-horse-battery-staple", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["journal"],
    });
    const all = await names(await vaultToken(ownerId), []);
    expect(all.body.names).toEqual({
      [ownerId]: { name: "Aaron", you: true },
      [bo]: { name: "Bo", you: false },
    });
  });
});
