// Sharing a vault with a friend (T-476; app docs/design/SHARING.md, docs/SPEC-1.0-grants.md §5.1): the owner's key
// invites someone to one vault by name at the account door; the friend reads the invite with its code alone, accepts
// it with their own key, and reaches that vault and no other, as a member (read and write, never admin); the owner
// ends it and the friend's next request is refused. HTTP and MCP only. A box has it; Cloud and the personal door don't
// yet (deliberate.json `share-a-vault`).
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { door, lacks, nostrAuth, safeFetch } from "./_door.ts";

const d = door();
const accountMcp = () => `${d.issuer}/account/mcp`;
const newKey = () => randomBytes(32).toString("hex");

/** One account-door tool, signed by `secret` (NIP-98): `{ok, body}` where body is the tool's answer or its words. */
async function tool(secret: string, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = await safeFetch(accountMcp(), {
    method: "POST",
    headers: { authorization: await nostrAuth(secret, accountMcp(), "POST", body), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) return { ok: false, body: `${res.status} ${text.slice(0, 200)}` };
  const json = JSON.parse(text.trimStart().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
  const inner = json.result?.content?.[0]?.text ?? json.error?.message ?? "";
  if (json.error || json.result?.isError) return { ok: false, body: inner };
  try { return { ok: true, body: JSON.parse(inner) }; } catch { return { ok: true, body: inner }; }
}

/** The friend's side: read an invite (no credential), or accept it signed by `secret`. */
async function friend(path: "look" | "accept", code: string, secret?: string): Promise<{ status: number; body: any }> {
  const url = `${d.issuer}/account/invites/${path}`;
  const body = JSON.stringify({ code });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = await nostrAuth(secret, url, "POST", body);
  const res = await safeFetch(url, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const reaches = async (secret: string) => {
  const r = await tool(secret, "list-vaults", {});
  return r.ok ? (r.body.vaults as { name: string }[]).map((v) => v.name) : [];
};

describe.skipIf(lacks("share-a-vault") || !d.ownerKey)("sharing a vault with a friend", () => {
  test("invite by name, read it, accept with your own key: that vault only, as a member; ending it stops the next request", async () => {
    const owner = d.ownerKey!;
    const made = await tool(owner, "invite-to-vault", { vault: d.vault, name: "Bo", from: "Aaron" });
    expect(made.ok, String(made.body)).toBe(true);
    const code = String(made.body.url).split("#")[1]!;
    expect(made.body.url).toBe(`${d.issuer}/invite#${code}`);

    // read with the code alone: who, where, what; nothing used
    const look = await friend("look", code);
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ vault: d.vault, from: "Aaron", name: "Bo", can: "read and write" });

    // accepted with Bo's own key: he reaches this vault and not the owner's other one
    const bo = newKey();
    expect((await friend("accept", code)).status).toBe(401);
    const accepted = await friend("accept", code, bo);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ vault: d.vault, name: "Bo" });
    const his = await reaches(bo);
    expect(his).toContain(d.vault);
    expect(his).not.toContain(d.otherVault);
    // a member reads and writes, and can't invite anyone
    expect((await tool(bo, "query-records", { vault: d.vault, limit: 1 })).ok).toBe(true);
    expect((await tool(bo, "invite-to-vault", { vault: d.vault, name: "Mallory" })).ok).toBe(false);

    // used once: a second accept, by anyone, is the one 404
    const again = await friend("accept", code, newKey());
    expect(again.status).toBe(404);
    expect(again.body?.error).toBe("no_invite");

    // the owner's list names him; End, and his next request is refused
    const listed = await tool(owner, "list-access", { vault: d.vault });
    const row = (listed.body.access as { pubkey: string; role: string; name: string | null }[]).find((r) => r.name === "Bo");
    expect(row?.role).toBe("member");
    expect((await tool(owner, "revoke-access", { pubkey: row!.pubkey, vault: d.vault })).body.revoked).toBe(true);
    expect(await reaches(bo)).not.toContain(d.vault);
    expect((await tool(bo, "query-records", { vault: d.vault, limit: 1 })).ok).toBe(false);
  });

  test("taken back before anyone accepts, an invite opens nothing", async () => {
    const owner = d.ownerKey!;
    const made = await tool(owner, "invite-to-vault", { vault: d.vault, name: "Cy" });
    const code = String(made.body.url).split("#")[1]!;
    expect((await tool(owner, "take-back-invite", { vault: d.vault, id: made.body.id })).body.taken_back).toBe(true);
    expect((await friend("look", code)).status).toBe(404);
    const cy = newKey();
    expect((await friend("accept", code, cy)).status).toBe(404);
    expect(await reaches(cy)).not.toContain(d.vault);
  });
});
