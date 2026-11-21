// One address for an AI (T-476): `<issuer>/mcp`. An app given only that address is led to the account door: it
// sees every vault the person lets it reach, picks one per call, and, when the person allows it, makes a new one.
// The per-vault address (`/vault/<name>/mcp`) stays the narrow choice, held by connect.test.ts. HTTP and MCP only.
//
// What a person sees on the consent screen when an app asks for the account door: "All your vaults" (read and write
// in each, now and later, and it may make new ones) chosen to start, or "Only these vaults", one level each. The form
// posts `vault_reach=all|chosen`; a form without it is the per-vault form of 0.9.1 (multivault.test.ts).
import { describe, expect, test } from "bun:test";
import { connectAccount } from "./_connect.ts";
import { accountToken, door, lacks, mcp, rest, runId, safeFetch } from "./_door.ts";

const d = door();
const one = () => `${d.issuer}/mcp`;
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const owner = async () => ({ authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" });
const cold = () =>
  safeFetch(one(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
const freshName = (label: string) => `${label}${runId("")}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);

describe.skipIf(d.release !== "0.9.1" || lacks("one-address"))("one address: <issuer>/mcp is the account door", () => {
  const a = d.vault;
  const b = d.otherVault;

  test("a cold app at <issuer>/mcp is led to the account door, and the hub names the address", async () => {
    const r = await cold();
    expect(r.status).toBe(401);
    const prmUrl = (r.headers.get("www-authenticate") ?? "").match(/resource_metadata="([^"]+)"/)?.[1];
    expect(prmUrl).toBe(`${d.issuer}/.well-known/oauth-protected-resource/mcp`);
    const prm = await (await safeFetch(prmUrl!)).json();
    expect(prm.resource).toBe(one());
    expect(prm.authorization_servers).toEqual([d.issuer]);
    // Only the account door's ask: an app copies this list whole, and the account door's ask can't sit beside a
    // vault verb (the hub refuses the pair).
    expect(prm.scopes_supported).toEqual(["account:vaults"]);
    const desc = await (await safeFetch(`${d.issuer}/.well-known/parachute-account`)).json();
    expect(desc.mcp_endpoint).toBe(one());
    // The account door's own address is unchanged: shipped apps check it.
    expect(desc.account_mcp_endpoint).toBe(`${d.issuer}/account/mcp`);
  });

  test.skipIf(d.signIn.how !== "cookie")(
    "the owner's default: every vault at read and write, and the app can make a new vault and write there",
    async () => {
      let html = "";
      const got = await connectAccount({ appName: `one-${runId("all")}`, resource: one(), levels: {}, form: { vault_reach: "all" }, seen: (h) => (html = h) });
      expect(got.ok, got.ok ? "" : got.refusal).toBe(true);
      if (!got.ok) return;
      // "All your vaults" is the choice the page starts on.
      expect(html).toMatch(/<input[^>]*name="vault_reach"[^>]*value="all"[^>]*checked/);
      expect(claimsOf(got.access).aud).toBe("account");
      // Capped at write, not the owner's admin; and allowed to make vaults.
      expect(got.scope.split(" ").sort()).toEqual(["account:self:vault-create", "account:self:vaults:*:write"]);

      const third = freshName("one");
      const c = await mcp("read", { url: one(), bearer: got.access });
      try {
        const listed = await c.call("list-vaults", {});
        expect(listed.covered).toBe("all");
        const names = listed.vaults.map((v: { name: string }) => v.name);
        for (const v of [a, b]) expect(names).toContain(v);
        const tools = (await c.tools()).map((t) => t.name);
        for (const t of ["list-vaults", "create-vault", "query-records", "create-record", "update-record"]) expect(tools).toContain(t);

        // A write on each vault, named per call, lands there and only there.
        const path = `${runId("one")}/note`;
        for (const v of [a, b]) expect(await c.call("create-record", { vault: v, path, body: `written to ${v} through one address` })).toBeTruthy();
        for (const v of [a, b]) {
          const back = await rest("read", v).get(`/records/${encodeURIComponent(path)}`);
          expect(back.status).toBe(200);
          expect(JSON.stringify(back.body)).toContain(`written to ${v} through one address`);
        }

        // A new vault, made by the app; it is in reach at once, at write.
        const made = await c.call("create-vault", { name: third });
        expect(made.name).toBe(third);
        const again = (await c.call("list-vaults", {})).vaults.map((v: { name: string }) => v.name);
        expect(again).toContain(third);
        expect(await c.call("create-record", { vault: third, path, body: "the first record in a vault the app made" })).toBeTruthy();
        expect((await rest("read", third).get(`/records/${encodeURIComponent(path)}`)).status).toBe(200);
        for (const v of [a, b]) expect((await rest("write", v).del(`/notes/${encodeURIComponent(path)}`)).status).toBeLessThan(300);
      } finally {
        await c.close();
        await safeFetch(`${d.issuer}/account/vaults/${third}`, { method: "DELETE", headers: await owner(), body: JSON.stringify({ confirm: third }) });
      }
    },
  );

  test.skipIf(d.signIn.how !== "cookie")("“Only these vaults” at <issuer>/mcp: one vault at write is all the app reaches", async () => {
    const got = await connectAccount({ appName: `one-${runId("just")}`, resource: one(), levels: { [a]: "write", [b]: "none" }, form: { vault_reach: "chosen" } });
    expect(got.ok, got.ok ? "" : got.refusal).toBe(true);
    if (!got.ok) return;
    expect(got.scope).toBe(`account:self:vaults:${a}:write`);
    const c = await mcp("read", { url: one(), bearer: got.access });
    try {
      expect((await c.call("list-vaults", {})).vaults.map((v: { name: string }) => v.name)).toEqual([a]);
      expect((await c.tools()).map((t) => t.name)).not.toContain("create-vault");
      const refused = await c.call("create-record", { vault: b, path: `${runId("no")}/note`, body: "not here" }).then(() => null, (e: Error) => e.message);
      expect(refused).not.toBeNull();
    } finally {
      await c.close();
    }
  });

  test.skipIf(d.signIn.how !== "cookie")("an app that asks <issuer>/mcp for vault verbs gets the same account-door consent", async () => {
    let html = "";
    const got = await connectAccount({ appName: `one-${runId("verbs")}`, resource: one(), scope: "vault:read vault:write", levels: {}, form: { vault_reach: "all" }, seen: (h) => (html = h) });
    expect(got.ok, got.ok ? "" : got.refusal).toBe(true);
    if (!got.ok) return;
    expect(html).toContain('name="vault_reach"');
    expect(claimsOf(got.access).aud).toBe("account");
    const c = await mcp("read", { url: one(), bearer: got.access });
    try {
      const names = (await c.call("list-vaults", {})).vaults.map((v: { name: string }) => v.name);
      for (const v of [a, b]) expect(names).toContain(v);
    } finally {
      await c.close();
    }
  });

  test("a one-vault credential at <issuer>/mcp still reaches its own vault, as before", async () => {
    const c = await mcp("write", { url: one() });
    try {
      const tools = (await c.tools()).map((t) => t.name);
      expect(tools).toContain("create-record");
      expect(tools).not.toContain("list-vaults");
    } finally {
      await c.close();
    }
  });
});
