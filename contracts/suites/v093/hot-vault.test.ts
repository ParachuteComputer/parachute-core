// v093/hot-vault: a vault made or deleted on a running box needs no restart (0.9.3, T-463 PR 6).
//
// The box is the run's own (`bun run candidate`): `parachute serve`, the default process model. With a host-admin
// pass, `POST /vaults {name}` makes a second vault; at once, with no wait and no retry:
//   - its REST, MCP and the hub's own list all answer, and the pass the hub handed back opens it;
//   - a key can be minted for it;
//   - the first vault answers every request made throughout (a sampler hits it every 10 ms across the whole run);
//   - nothing restarted: the same processes hold the same listeners, and the vault part of the server never stopped or started again (its log).
// Then `DELETE /vaults/<name>`: the new vault is gone (404 on REST), the first still answers, and again nothing
// restarted. Black box: HTTP, MCP and the real CLI on a made-up home; note text is made up.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { listeningProcesses } from "../candidate-lib.ts";
import { enc, mcp, must, rest, safeFetch, services } from "../lib.ts";

const s = services();

async function cli(args: string[]) {
  const p = Bun.spawn([...s.cli!, ...args], { env: s.cliEnv, cwd: s.home.replace(/\/[^/]+$/, ""), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

/** The pids that hold a listener, and what each listens on: a restart of any part changes this. */
const listeners = () =>
  listeningProcesses()
    .filter((p) => p.pid !== process.pid)
    .map((p) => `${p.pid} ${p.listens.join(",")}`)
    .sort();

/**
 * How many times the vault part of the server has started, from the box's own log (the hub's module list carries no
 * start time). A restart in the same process keeps the pid, so the log is what shows it.
 */
const vaultStarts = () => {
  const log = readFileSync(join(s.home, "..", "serve.log"), "utf8");
  return { started: (log.match(/Parachute Vault server listening/g) ?? []).length, stopped: (log.match(/vault shutting down/g) ?? []).length };
};

describe("v093/hot-vault", () => {
  test("a vault made and deleted on a running box: usable at once, nothing restarts, the first vault never misses a request", async () => {
    // The box's operator token (written by `auth rotate-operator`, which the run did) is the host-admin pass.
    const admin = readFileSync(join(s.home, "operator.token"), "utf8").trim();
    must(admin.split(".").length === 3, "setup: no operator token in the box's home");
    const json = { authorization: `Bearer ${admin}`, "content-type": "application/json" };

    const pidsBefore = listeners();
    const startsBefore = vaultStarts();
    const first = rest(s.vaultViaHub, s.operatorToken);
    expect((await first.post("/notes", { content: "first vault, before", path: "hot/first-before" })).status).toBe(201);

    // The sampler: the first vault answers every request, from here to the end.
    let stop = false;
    const missed: string[] = [];
    let samples = 0;
    const sampler = (async () => {
      while (!stop) {
        samples++;
        try {
          const r = await first.get("/notes?limit=1");
          if (r.status !== 200) missed.push(`status ${r.status}`);
        } catch (e) {
          missed.push(String((e as Error).message ?? e).slice(0, 80));
        }
        await Bun.sleep(10);
      }
    })();

    try {
      // ── create ──
      const name = `hot${randomBytes(3).toString("hex")}`;
      const made = await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) });
      const madeBody: any = await made.json();
      must(made.status === 201, `POST /vaults answered ${made.status}: ${JSON.stringify(madeBody).slice(0, 300)}`);
      const base = `${s.hub}/vault/${name}`;

      // REST: a record is made and read back, with the pass the hub handed back.
      const api = rest(base, madeBody.token);
      const made1 = await api.post("/notes", { content: "Made-up hot note: the heron counted nine pebbles.", path: "hot/one" });
      must(made1.status === 201, `REST create in the new vault: ${made1.status} ${JSON.stringify(made1.body).slice(0, 200)}`);
      const read = await api.get(`/notes/${enc(made1.body.id)}`);
      must(read.status === 200 && /nine pebbles/.test(read.body?.content ?? ""), `REST read in the new vault: ${read.status}`);

      // MCP: connects, lists tools, queries.
      const c = await mcp(`${base}/mcp`, madeBody.token);
      try {
        const tools = await c.tools();
        must(tools.length > 3, `MCP tools in the new vault: ${tools.join(",")}`);
        const q = await c.call("query-records", { search: "pebbles" }).catch(() => c.call("query-notes", { search: "pebbles" }));
        expect(JSON.stringify(q)).toContain("pebbles");
      } finally {
        await c.close();
      }

      // The hub lists it, and a key can be minted for it.
      const wk = await safeFetch(`${s.hub}/.well-known/parachute.json`);
      expect(JSON.stringify(await wk.json())).toContain(`/vault/${name}`);
      const key = await cli(["keys", "new", `hot-${randomBytes(2).toString("hex")}`, "--vault", name, "--can", "read", "--expires-in", "600"]);
      must(key.code === 0, `keys new for the new vault exited ${key.code}: ${key.stderr.slice(-300)}`);
      const keyToken = key.stdout.trim().split("\n").pop()!.trim();
      expect((await rest(base, keyToken).get("/notes?limit=1")).status).toBe(200);

      // Nothing restarted.
      expect(listeners()).toEqual(pidsBefore);
      expect(vaultStarts()).toEqual(startsBefore);

      // ── delete ──
      const del = await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) });
      const delBody: any = await del.json().catch(() => null);
      must(del.status === 200, `DELETE /vaults/${name} answered ${del.status}: ${JSON.stringify(delBody).slice(0, 300)}`);
      // Gone: the hub no longer lists it, and its door says no such vault (its passes died with it).
      expect(JSON.stringify(await (await safeFetch(`${s.hub}/.well-known/parachute.json`)).json())).not.toContain(`/vault/${name}`);
      expect((await safeFetch(`${base}/mcp`)).status).toBe(404);
      expect([401, 404]).toContain((await rest(base, madeBody.token).get("/notes?limit=1")).status);
      expect((await first.get("/notes?limit=1")).status).toBe(200);
      expect(listeners()).toEqual(pidsBefore);
      expect(vaultStarts()).toEqual(startsBefore);
      // Made again under the same name: an empty vault (no leftovers from the deleted one).
      const again = await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) });
      must(again.status === 201, `POST /vaults again answered ${again.status}`);
      const reborn: any = await again.json();
      const left = await rest(base, reborn.token).get("/notes?limit=5");
      expect(left.status).toBe(200);
      expect(JSON.stringify(left.body)).not.toContain("pebbles");
      await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) });
    } finally {
      stop = true;
      await sampler;
    }
    must(samples > 10, `the sampler only ran ${samples} times`);
    expect(missed).toEqual([]);
  }, 180_000);

  test("a vault deleted and made again at once under the same name carries nothing over: its trigger stays silent and its live socket is closed", async () => {
    const admin = readFileSync(join(s.home, "operator.token"), "utf8").trim();
    const json = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
    const name = `swap${randomBytes(3).toString("hex")}`;
    const base = `${s.hub}/vault/${name}`;
    const hits: string[] = [];
    const hook = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (r: Request) => { hits.push(await r.text()); return Response.json({ ok: true }); } });
    try {
      const old: any = await (await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) })).json();
      const trig = await rest(base, old.token).post("/triggers", { name: "old", events: ["created"], when: { tags: ["x"] }, action: { webhook: `http://127.0.0.1:${hook.port}/hook` } });
      must(trig.status === 201 || trig.status === 200, `trigger create: ${trig.status} ${JSON.stringify(trig.body).slice(0, 200)}`);
      // A live socket opened with the old vault's pass.
      const ws = new WebSocket(`${base}/api/subscribe`.replace(/^http/, "ws"));
      const frames: string[] = [];
      let closed = "";
      ws.onmessage = (e) => frames.push(String(e.data));
      ws.onclose = (e) => (closed = `${e.code}`);
      await new Promise((ok) => (ws.onopen = ok));
      ws.send(JSON.stringify({ type: "auth", token: old.token }));
      await Bun.sleep(800);

      // Delete and make again at once: no wait between, no request in between that names the vault.
      const del = await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) });
      must(del.status === 200, `DELETE answered ${del.status}`);
      const again = await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) });
      must(again.status === 201, `POST again answered ${again.status}`);
      const fresh: any = await again.json();
      const made = await rest(base, fresh.token).post("/notes", { content: "made-up text for the new owner", path: "q", tags: ["x"] });
      expect(made.status).toBe(201);
      await Bun.sleep(1500);

      expect(hits).toEqual([]); // the deleted vault's webhook never hears of the new vault's note
      expect(frames.filter((f) => f.includes("new owner"))).toEqual([]); // nor does its socket
      expect(closed).toBe("1001"); // which the server closed, as a restart used to
    } finally {
      hook.stop(true);
      await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) }).catch(() => {});
    }
  }, 60_000);

  test("the same, when the new vault's first write comes through the root /mcp door (which never names the vault in its path)", async () => {
    const admin = readFileSync(join(s.home, "operator.token"), "utf8").trim();
    const json = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
    const name = `root${randomBytes(3).toString("hex")}`;
    const hits: string[] = [];
    const hook = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (r: Request) => { hits.push(await r.text()); return Response.json({ ok: true }); } });
    try {
      const old: any = await (await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) })).json();
      const trig = await rest(`${s.hub}/vault/${name}`, old.token).post("/triggers", { name: "old", events: ["created"], when: { tags: ["x"] }, action: { webhook: `http://127.0.0.1:${hook.port}/hook` } });
      must(trig.status === 201 || trig.status === 200, `trigger create: ${trig.status}`);
      const del = await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) });
      must(del.status === 200, `DELETE answered ${del.status}`);
      const again = await safeFetch(`${s.hub}/vaults`, { method: "POST", headers: json, body: JSON.stringify({ name }) });
      must(again.status === 201, `POST again answered ${again.status}`);
      const fresh: any = await again.json();
      const c = await mcp(`${s.hub}/mcp`, fresh.token);
      try {
        await c.call("create-note", { content: "made-up text for the new owner", path: "q", tags: ["x"] });
      } finally {
        await c.close();
      }
      await Bun.sleep(1500);
      expect(hits).toEqual([]);
    } finally {
      hook.stop(true);
      await safeFetch(`${s.hub}/vaults/${name}`, { method: "DELETE", headers: json, body: JSON.stringify({ confirm: name }) }).catch(() => {});
    }
  }, 60_000);
});
