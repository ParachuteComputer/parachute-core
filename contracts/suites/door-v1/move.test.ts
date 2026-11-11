// 1.0 grants: what carries on a move (docs/SPEC-1.0-grants.md §9, §2.3). The export a move is made of holds every
// statement word for word and the vault's own id, and never a credential.
//
// The export is read over HTTP, as the door suite's exit contract reads it. A box exports only by its own command,
// which a contract can't run, so on a box these skip through `lacks("export-over-http")` (deliberate.json), never
// quietly: there they are not shown red until the box's export is read by the runner or served over HTTP.
//
// Red today: no door takes a signed statement, so the contract stops where `granted()` files one. Its body starts
// with a grant that must be taken, so an export with no statements can't pass because none was ever filed.
import { describe, expect, test } from "bun:test";
import { LANE, NO_GRANTS, claimEvent, declareType, file, granted, linkEvent, newKey, ownerKey, records, red, revokeEvent, rest, runId, safeFetch, tokenAs, vaultUrl, type Event } from "./_grants.ts";
import { lacks, token } from "../door/_door.ts";
import { untar, type TarFile } from "../door/_tar.ts";

/** The vault's export over HTTP, as files. */
async function exported(): Promise<TarFile[]> {
  const r = await safeFetch(`${vaultUrl()}/api/export`, { headers: { authorization: `Bearer ${await token("read")}` } });
  if (r.status !== 200) throw new Error(`setup: GET /api/export answered ${r.status}`);
  return untar(new Uint8Array(await r.arrayBuffer()));
}
const text = (f: TarFile) => new TextDecoder().decode(f.bytes);
/** An event as the vault must keep it: exactly the signed fields. */
const signed = (e: Event) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

describe.skipIf(lacks("export-over-http"))("the export a move is made of", () => {
  test("setup holds today: the export is readable here, with the vault's own file", async () => {
    await records("write").make({ body: "something to export" });
    const names = (await exported()).map((f) => f.name);
    expect(names).toContain(".parachute/vault.yaml");
  });

  red("holds every statement word for word, the vault's own id, and no credential", { reason: NO_GRANTS, lane: LANE }, async () => {
    const recipe = await declareType("recipe");
    const owner = await ownerKey();
    // A grant, then one that is revoked, then a service's link and the person's claim: six statements of four kinds.
    const key = await newKey();
    const kept = await granted({ to: key, types: { [recipe]: ["read"] } });
    // A token handed out under it: the export must not carry it.
    const handedOut = await tokenAs(key);
    const ended = await granted({ to: await newKey(), types: { [recipe]: ["read"] } });
    const revoke = await revokeEvent(ended);
    expect((await file(revoke)).status).toBe(201);
    const service = await newKey();
    const prefix = `${runId("portal")}.example`;
    const names = await granted({ to: service, by: { names: prefix }, types: { [recipe]: ["create"] } });
    const mara = await newKey();
    const link = await linkEvent(service, `${prefix}:client-42`, mara);
    expect((await file(link, { as: service })).status).toBe(201);
    const claim = await claimEvent(mara, `${prefix}:client-42`, "mine");
    expect((await file(claim, { as: mara })).status).toBe(201);

    const files = await exported();
    const byName = new Map(files.map((f) => [f.name, f]));

    // Every statement, one signed event per line, exactly as signed.
    const jsonl = byName.get(".parachute/statements.jsonl");
    expect(jsonl, files.map((f) => f.name).join(" ")).toBeTruthy();
    const lines = text(jsonl!).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const e of [kept, ended, revoke, names, link, claim]) expect(lines.find((x) => x.id === e.id), `kind ${e.kind} ${e.id}`).toEqual(signed(e));

    // The vault's own id, the one its info shows.
    const id = (await rest("read").get("/vault")).body?.id;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(text(byName.get(".parachute/vault.yaml")!)).toMatch(new RegExp(`^id: ["']?${id}["']?$`, "m"));

    // No credential anywhere: no token, no key, no session.
    for (const f of files) {
      const t = text(f);
      expect(t, f.name).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      expect(t, f.name).not.toContain("vault_token");
      expect(t.includes(handedOut), f.name).toBe(false);
      for (const k of [key, service, mara, owner]) expect(t.includes(k.secretKey), f.name).toBe(false);
    }
  });
});
