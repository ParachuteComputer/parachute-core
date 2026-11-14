// One multi-vault door (ROADMAP 0.9.1, T-446): the account door (`/account/mcp`) with a key that covers several
// vaults, each at its own level. The owner mints the key by name at `/account/keys` with `vaults: {<vault>: level}`;
// the key opens the account door and no vault directly. Through the door it reads where it may read, writes only
// where it may write (the hop to each vault carries that vault's level, never the owner's), must name the vault on a
// write, and stops when revoked. HTTP and MCP only, so any door with an account door can be held to it.
import { describe, expect, test } from "bun:test";
import { connectAccount } from "./_connect.ts";
import { accountToken, door, fp, lacks, mcp, rest, runId, safeFetch, vaultUrl } from "./_door.ts";

const d = door();
const is091 = d.release === "0.9.1";
const accountMcp = () => `${d.issuer}/account/mcp`;
const bearer = async () => ({ authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" });
const tokens = (x: unknown) => Math.ceil((typeof x === "string" ? x : JSON.stringify(x)).length / 4);
// What the model reads of a tool list: not the tools' MCP annotations, which are for the client (mcp/budget).
const forModel = (tools: { annotations?: unknown }[]) => tools.map(({ annotations: _client, ...t }) => t);
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
const mint = async (body: unknown) =>
  safeFetch(`${d.issuer}/account/keys`, { method: "POST", headers: await bearer(), body: JSON.stringify(body) });

describe.skipIf(!is091 || lacks("multi-vault-door"))("one multi-vault door", () => {
  // `d.vault` read, `d.otherVault` write: one key, two levels.
  const read = d.vault;
  const write = d.otherVault;

  test("a key read on one vault and write on another: each vault at its own level, and writes must name the vault", async () => {
    const name = `door-multi-${runId("k")}`;
    const made = await mint({ name, vaults: { [read]: "read", [write]: "write" } });
    expect(made.status, (await made.clone().text()).slice(0, 300)).toBe(201);
    const key = await made.json();
    expect(key.vaults).toEqual({ [read]: "read", [write]: "write" });
    fp("multivault/key.mint.keys", Object.keys(key).sort());
    const claims = claimsOf(key.token);
    expect(claims.aud).toBe("account");
    expect(String(claims.scope).split(" ").sort()).toEqual([`account:self:vaults:${read}:read`, `account:self:vaults:${write}:write`].sort());

    // It opens the account door, and no vault directly.
    const direct = await safeFetch(`${vaultUrl(write)}/api/records?limit=1`, { headers: { authorization: `Bearer ${key.token}` } });
    expect([401, 403]).toContain(direct.status);

    const c = await mcp("read", { url: accountMcp(), bearer: key.token });
    try {
      // It sees exactly the vaults it covers.
      const listed = await c.call("list-vaults", {});
      expect(listed.vaults.map((v: { name: string }) => v.name).sort()).toEqual([read, write].sort());

      // The writer's tool list: the record tools and list-vaults, no account-admin tools, within the 4,000-token budget.
      const tools = await c.tools();
      const names = tools.map((t) => t.name);
      for (const t of ["list-vaults", "query-records", "create-record", "update-record", "delete-record"]) expect(names).toContain(t);
      for (const t of ["create-vault", "grant-access", "revoke-access", "list-access", "manage-token"]) expect(names).not.toContain(t);
      expect(tokens(forModel(tools))).toBeLessThanOrEqual(4000);
      fp("multivault/writer.tools", names);
      const create = tools.find((t) => t.name === "create-record")!;
      expect((create.inputSchema as { required?: string[] }).required ?? []).toContain("vault");

      // A write with no vault is refused, and the refusal names the vaults the key reaches.
      const path = `${runId("multi")}/note`;
      const noVault = await c.call("create-record", { path, body: "where?" }).then(() => null, (e: Error) => e.message);
      expect(noVault).not.toBeNull();
      expect(noVault).toContain(read);
      expect(noVault).toContain(write);

      // Read-level on `read`: the write is refused there, in any spelling of the name, and nothing is written.
      for (const v of [read, read.toUpperCase()]) {
        const refused = await c.call("create-record", { vault: v, path, body: "not here" }).then(() => null, (e: Error) => e.message);
        expect(refused, `a write on the read vault spelled ${v}`).not.toBeNull();
      }
      const smuggled = await c.call("create-record", { vault: `${write}/../${read}`, path, body: "nor here" }).then(() => null, (e: Error) => e.message);
      expect(smuggled).not.toBeNull();
      expect((await rest("read", read).get(`/records/${encodeURIComponent(path)}`)).status).toBe(404);

      // Write-level on `write`: the write lands there, and the per-vault door reads it back.
      const wrote = await c.call("create-record", { vault: write, path, body: "written through the account door" });
      expect(wrote).toBeTruthy();
      const back = await rest("read", write).get(`/records/${encodeURIComponent(path)}`);
      expect(back.status).toBe(200);
      expect(JSON.stringify(back.body)).toContain("written through the account door");

      // The write stamp: a write through the account door is stamped with the key that made it, the same as that key
      // writing at a vault door (`via` comes from the key the door authenticated, never from the client).
      const stamped = (await rest("read", write).get(`/notes/${encodeURIComponent(path)}`)).body;
      expect(stamped.createdVia, "created through the account door").toBe(`key:${name}`);
      await c.call("update-note", { vault: write, id: path, content: "written through the account door, again", force: true });
      const id = (await rest("read", write).get(`/notes/${encodeURIComponent(path)}`)).body.id;
      const versions = (await rest("read", write).get(`/notes/${encodeURIComponent(id)}/versions`)).body.versions as any[];
      expect(versions[0]?.via, "the revision the update made").toBe(`key:${name}`);
      if (!lacks("revision-key-kind")) expect(versions[0]?.via_kind).toBe("app");
      fp("multivault/write-stamp.via", { created: String(stamped.createdVia).replace(name, "<name>"), revision: String(versions[0]?.via).replace(name, "<name>") });

      // A query with no vault reads every covered vault, each at read.
      const q = await c.call("query-records", { search: "written through the account door", limit: 5 });
      expect([...q.vaults_queried].sort()).toEqual([read, write].sort());
      fp("multivault/query.fan-out.keys", Object.keys(q).sort());
      // Leave the second vault as it was: rest's "a new vault starts with the same notes" reads it, in whatever order
      // the files run.
      expect((await rest("write", write).del(`/notes/${encodeURIComponent(path)}`)).status).toBeLessThan(300);
    } finally {
      await c.close();
    }

    // Revoked: the account door refuses it on the next call.
    const gone = await safeFetch(`${d.issuer}/account/keys/${encodeURIComponent(name)}`, { method: "DELETE", headers: await bearer() });
    expect(gone.status).toBe(200);
    const after = await safeFetch(accountMcp(), {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  test("a multi-vault key is never admin, and names only vaults that exist", async () => {
    const admin = await mint({ name: `door-multi-${runId("a")}`, vaults: { [read]: "admin" } });
    expect(admin.status).toBe(400);
    const missing = await mint({ name: `door-multi-${runId("m")}`, vaults: { [read]: "read", [`${runId("nope")}`]: "read" } });
    expect(missing.status).toBe(404);
    const both = await mint({ name: `door-multi-${runId("b")}`, vault: read, can: "read", vaults: { [write]: "write" } });
    expect(both.status).toBe(400);
    fp("multivault/refusals", [admin.status, missing.status, both.status]);
  });

  // Consent per vault: an app that asks for the account door gets each vault at the level the person chose on the
  // consent screen (none, read or write), never the person's own role, and a vault left at none is not reachable.
  test.skipIf(d.signIn.how !== "cookie")("consent per vault: A read, B write, C none; through the account door each is held to its level", async () => {
    const owner = await bearer();
    const third = `mv${runId("c")}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
    const made = await safeFetch(`${d.issuer}/account/vaults`, { method: "POST", headers: owner, body: JSON.stringify({ name: third }) });
    expect(made.status).toBe(201);
    try {
      // A level above write, or a vault the person can't reach, is refused: no token.
      const admin = await connectAccount({ appName: `mv-admin-${runId("a")}`, levels: { [read]: "admin" } });
      expect(admin.ok, "a posted level above write").toBe(false);
      const stranger = await connectAccount({ appName: `mv-nope-${runId("n")}`, levels: { [read]: "read", [`${runId("nope")}`.toLowerCase()]: "read" } });
      expect(stranger.ok, "a vault that doesn't exist").toBe(false);
      const nothing = await connectAccount({ appName: `mv-none-${runId("z")}`, levels: { [read]: "none" } });
      expect(nothing.ok, "every vault at none").toBe(false);
      // The app can't choose a level itself: a per-vault scope in its own ask never reaches the token.
      const smuggled = await connectAccount({ appName: `mv-ask-${runId("s")}`, scope: `account:vaults account:self:vaults:${write}:write`, levels: { [read]: "read", [write]: "none" } });
      expect(smuggled.ok && smuggled.scope.includes(write), "a per-vault scope the app asked for itself").toBe(false);

      const got = await connectAccount({ appName: `mv-${runId("app")}`, levels: { [read]: "read", [write]: "write", [third]: "none" } });
      expect(got.ok, got.ok ? "" : got.refusal).toBe(true);
      if (!got.ok) return;
      fp("multivault/consent.scope", got.scope.split(" ").map((s) => s.replace(read, "<A>").replace(write, "<B>")).sort());
      const c = await mcp("read", { url: accountMcp(), bearer: got.access });
      try {
        const listed = (await c.call("list-vaults", {})).vaults.map((v: { name: string }) => v.name).sort();
        expect(listed).toEqual([read, write].sort());
        const path = `${runId("consent")}/note`;
        const onA = await c.call("create-record", { vault: read, path, body: "not on A" }).then(() => null, (e: Error) => e.message);
        expect(onA, "a write on A (read)").not.toBeNull();
        const onC = await c.call("create-record", { vault: third, path, body: "not on C" }).then(() => null, (e: Error) => e.message);
        expect(onC, "a write on C (none)").not.toBeNull();
        const readC = await c.call("query-records", { vault: third, limit: 1 }).then(() => null, (e: Error) => e.message);
        expect(readC, "a read on C (none)").not.toBeNull();
        expect(await c.call("create-record", { vault: write, path, body: "on B" })).toBeTruthy();
        expect((await rest("read", write).get(`/records/${encodeURIComponent(path)}`)).status).toBe(200);
        expect((await rest("read", read).get(`/records/${encodeURIComponent(path)}`)).status).toBe(404);
        expect((await rest("read", third).get(`/records/${encodeURIComponent(path)}`)).status).toBe(404);
        expect((await rest("write", write).del(`/notes/${encodeURIComponent(path)}`)).status).toBeLessThan(300);
      } finally {
        await c.close();
      }
    } finally {
      await safeFetch(`${d.issuer}/account/vaults/${third}`, { method: "DELETE", headers: owner, body: JSON.stringify({ confirm: third }) });
    }
  });
});
