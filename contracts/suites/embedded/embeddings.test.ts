// embedded/embeddings (T-418): semantic search turned on works from a fresh install, and says so when it can't.
//
// On 2026-10-29 a box that had semantic search on under 0.7 moved to the 0.8.0-pre.1 bundle. Its config still said
// `embeddings_enabled: true`, but the bundle shipped without @huggingface/transformers, so every note's embed failed
// ("Cannot find package '@huggingface/transformers'") in a log line, while the vault looked healthy. Ten days later
// 2,414 notes had no vector and nothing on /health or the vault's info said why.
//
//   - the bundle as shipped, on a fresh home with semantic search on and no network (the sandbox has none): a note
//     written gets an embedding from the bundled model, and a semantic search finds it with nothing pending;
//   - /health and the vault's info say the embedder is ready;
//   - the same bundle without @huggingface/transformers (what 0.8.0-pre.1 shipped): /health says the embedder is
//     failing, and the vault's info names why, without waiting for a note to be written.
// Red on 0.8.0-pre.3 (no embedding stack in the bundle, nothing on /health). The npm package gets the same check from
// harness/npm-package.ts (a fresh `npm i -g` of the packed .tgz).
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { candidateEnv } from "../../harness/candidate.ts";
import { allowOrigins, candidate, newHome, safeFetch, until, type Served } from "../candidate-lib.ts";
import { embeddedHome, exited, mint, must, ports, tail } from "./_lib.ts";

const ON = { EMBEDDINGS_ENABLED: "true" };

async function getJson(url: string, token?: string): Promise<{ status: number; body: any }> {
  const r = await safeFetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text.slice(0, 300) };
  }
}

describe("embedded/embeddings", () => {
  test("a fresh install with semantic search on embeds a note with the bundled model, offline, and says it is ready", async () => {
    const home = newHome("embed");
    const vault = `em${randomBytes(3).toString("hex")}`;
    const e = await embeddedHome(home, { vault, env: ON });
    try {
      const { token } = await mint(home, `vault:${vault}:write`, [], ON);
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const api = `${e.vault}/vault/${vault}/api`;
      for (const [path, content] of [
        ["garden/seedlings", "Made up: the community garden needs tomato seedlings and bean seeds planted before May."],
        ["bikes/repair", "Made up: the bike shop fixes flat tyres and replaces worn brake pads on Saturdays."],
      ]) {
        const w = await safeFetch(`${api}/notes`, { method: "POST", headers: auth, body: JSON.stringify({ path, content }) });
        must(w.status === 201, `writing ${path} answered ${w.status}: ${(await w.text()).slice(0, 300)}`);
      }
      let last: any;
      const found = await until(async () => {
        last = await getJson(`${api}/notes?semantic=true&near_text=${encodeURIComponent("planting vegetables")}&limit=2`, token);
        const notes = Array.isArray(last.body) ? last.body : (last.body?.notes ?? last.body?.results);
        const pending = (last.body?.warnings ?? []).some((w: any) => w.code === "embeddings_pending");
        return last.status === 200 && !pending && notes?.[0]?.path === "garden/seedlings";
      }, 90_000, 1000);
      must(found, `no note was embedded in 90 s; the last semantic search: ${last?.status} ${JSON.stringify(last?.body).slice(0, 400)}\n--- serve log ---\n${tail(e.log(), 1500)}`);

      const info = await getJson(`${api}/vault`, token);
      expect({ status: info.status, embeddings: info.body?.embeddings }).toMatchObject({ status: 200, embeddings: { enabled: true, state: "ready" } });
      const health = await getJson(`${e.vault}/health`);
      expect({ status: health.status, embeddings: health.body?.embeddings?.state }).toEqual({ status: 200, embeddings: "ready" });
    } finally {
      await e.stop();
    }
  }, 180_000);

  test("a bundle whose embedding stack is missing says so on /health and in the vault's info, before any note is written", async () => {
    const c = candidate();
    // The shipped tree, copied, without @huggingface/transformers: what 0.8.0-pre.1 put on the box.
    const scratch = mkdtempSync(join(c.scratch, "noembed-"));
    const copy = join(scratch, "bundle");
    cpSync(c.dir, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    rmSync(join(copy, "lib", "node_modules", "@huggingface", "transformers"), { recursive: true, force: true });
    const home = newHome("noembed");
    const vault = `ne${randomBytes(3).toString("hex")}`;
    const [h, v] = await ports(2);
    const hub = `http://127.0.0.1:${h}`;
    const vaultOrigin = `http://127.0.0.1:${v}`;
    allowOrigins(hub, vaultOrigin);
    const env = candidateEnv(c, home, { ...ON, PATH: `${copy}/bin:/usr/local/bin:/usr/bin:/bin` });
    const proc = Bun.spawn([join(copy, "bin", "parachute"), "serve", "--embedded", "--listen", `127.0.0.1:${h}`, "--vault-listen", `127.0.0.1:${v}`], {
      env,
      cwd: dirname(home),
      stdout: "pipe",
      stderr: "pipe",
    });
    let log = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) log += new TextDecoder().decode(chunk);
    };
    void drain(proc.stdout);
    void drain(proc.stderr);
    const served: Pick<Served, "proc"> = { proc };
    try {
      const up = await until(async () => exited(served as Served) || (await safeFetch(`${hub}/api/ready`)).status === 200, 45_000);
      must(up && !exited(served as Served), `the copy's serve --embedded did not come up (exit ${proc.exitCode}): ${tail(log)}`);
      const runIn = (args: string[]) => {
        const r = Bun.spawnSync([join(copy, "bin", "parachute"), ...args], { env, cwd: dirname(home), stdout: "pipe", stderr: "pipe" });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };
      const b = runIn(["bootstrap", "--embedded", "--vault", vault, "--json"]);
      must(b.code === 0, `bootstrap --embedded exited ${b.code}: ${tail(b.err || b.out)}`);
      const m = runIn(["auth", "mint-token", "--scope", `vault:${vault}:read`, "--json"]);
      must(m.code === 0, `mint-token exited ${m.code}: ${tail(m.err)}`);
      const token = JSON.parse(m.out).token as string;

      let health: any;
      let info: any;
      const said = await until(async () => {
        health = await getJson(`${vaultOrigin}/health`);
        info = await getJson(`${vaultOrigin}/vault/${vault}/api/vault`, token);
        return health.body?.embeddings?.state === "failing" && info.body?.embeddings?.state === "failing";
      }, 60_000, 500);
      must(said, `the missing embedder was never reported: /health ${JSON.stringify(health?.body).slice(0, 300)}; vault info embeddings ${JSON.stringify(info?.body?.embeddings)}\n--- serve log ---\n${tail(log, 1500)}`);
      expect(info.body.embeddings).toMatchObject({ enabled: false, state: "failing", provider: "onnx-transformers" });
      expect(String(info.body.embeddings.error)).toContain("@huggingface/transformers");
      // The vault's own health, asked with a pass, names the reason too; the anonymous /health only the state.
      const own = await getJson(`${vaultOrigin}/vault/${vault}/api/health`, token);
      expect({ status: own.status, state: own.body?.embeddings?.state }).toEqual({ status: 200, state: "failing" });
      expect(String(own.body.embeddings.error)).toContain("@huggingface/transformers");
      expect(health.body.embeddings.error).toBeUndefined();
    } finally {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(15_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
