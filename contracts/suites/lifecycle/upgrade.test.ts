// lifecycle/upgrade: the 0.8 → 0.9 step on a home, and the way back (DESIGN-0.9 §6 "every step up to 1.0 has a
// migration path", §7 "data always migrates automatically, forward, with a backup first"; packages/cli/src/release.ts).
//
// The home is made by the real 0.8 (pins.json previous_core, `bun run build:previous`): a vault, a tag with fields,
// made-up notes and a minted key. Then the candidate:
//   - its first command backs the databases up, outside the home, before it opens them, and only once;
//   - it serves the home: 0.8's key still reads, the tag with fields is a type, `keys list` names 0.8's key;
//   - `upgrade --rollback` refuses while anything holds the data (exit 7); stopped, it is code-only: 0.9's step
//     moved no schema number, so nothing on disk changes, and 0.8 serves every 0.9 write. 0.9 then picks up what
//     0.8 wrote meanwhile (and backs up again first);
//   - `upgrade --rollback --restore --yes` exports the notes changed since the backup, then puts the backup back,
//     and 0.8 serves that;
//   - a home 0.9 made has no earlier release: no backup, nothing to roll back.
// Each machine has its own network (the box holds 1940; _takeover-lib.ts). Red on 0.8 (no release record, no
// rollback); green from 0.9's release.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidate, freePort, newHome, until } from "../candidate-lib.ts";
import { cli } from "../candidate-lib.ts";
import { must, rest, safeFetch } from "../lib.ts";
import { dbHolders, newMachine, type Machine, type Proc } from "./_takeover-lib.ts";

let m: Machine;
const vault = `up${randomBytes(3).toString("hex")}`;
let origin = "";
let base: Record<string, string> = {};
let serveEnv: Record<string, string> = {};
let writer = "";
let nine = "";
const ids: Record<string, string> = {};

const info = candidate();
const prevBin = join(info.previousCoreDir, "bin", "parachute");
const prevVaultBin = join(info.previousCoreDir, "bin", "parachute-vault");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const vaultDb = () => join(m.home, "vault", "data", vault, "vault.db");
const dbHashes = () => ({ hub: sha(join(m.home, "hub.db")), vault: sha(vaultDb()) });
const release = () => JSON.parse(readFileSync(join(m.home, "run", "release.json"), "utf8"));
const backups = () => {
  const d = join(dirname(m.home), "parachute-upgrade");
  return existsSync(d) ? readdirSync(d).sort() : [];
};
const api = (token: string) => rest(`${origin}/vault/${vault}`, token);

/** `parachute serve` from `bin` on the machine, up once it serves the vault; stop waits until nothing holds the data. */
async function serve(bin: string, what: string): Promise<Proc> {
  const box = m.spawn([bin, "serve"], { env: serveEnv });
  const up = await until(async () => {
    if (box.proc.exitCode !== null) return true;
    const r = await safeFetch(`${origin}/vault/${vault}/mcp`);
    return r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes(`/vault/${vault}/`);
  }, 60_000);
  must(up && box.proc.exitCode === null, `${what} did not come up (exit ${box.proc.exitCode}):\n${box.log().slice(-2000)}`);
  const stop = box.stop;
  box.stop = async (signal, ms) => {
    const code = await stop(signal, ms);
    must(await until(() => dbHolders(m.home).length === 0, 15_000, 100), `${what} left the data held after it stopped`);
    return code;
  };
  return box;
}

const run = (bin: string, args: string[]) => m.run([bin, ...args], { env: base });
const core = (args: string[]) => run(info.bin, args);
const prev = (args: string[]) => run(prevBin, args);

async function mintWith(bin: string, label: string, level: "read" | "write" | "admin") {
  const levels = { read: ["read"], write: ["read", "write"], admin: ["read", "write", "admin"] }[level];
  const r = await run(bin, ["auth", "mint-token", "--scope", levels.map((l) => `vault:${vault}:${l}`).join(" "), "--label", label]);
  const t = r.stdout.trim().split("\n").pop()!.trim();
  must(r.code === 0 && t.split(".").length === 3, `mint ${label} exited ${r.code}: ${r.stderr.slice(-600)}`);
  return t;
}

async function post(token: string, key: string, content: string, tags: string[] = []) {
  const r = await api(token).post("/notes", { path: `upgrade/${key}-${randomBytes(2).toString("hex")}`, content, tags });
  must(r.status === 201, `writing ${key} gave ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  ids[key] = r.body.id;
}

beforeAll(async () => {
  must(existsSync(prevBin), `no build of the previous release at ${info.previousCoreDir}: run \`bun run build:previous\``);
  m = await newMachine("upgrade", { oldInstall: false });
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  base = { PORT: String(port), PARACHUTE_HUB_ORIGIN: origin };
  serveEnv = { ...base, PARACHUTE_BIND_HOST: "127.0.0.1", PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: `pw-${randomBytes(12).toString("hex")}` };
  // A home as 0.8 leaves it.
  const made = await m.run([prevVaultBin, "create", vault, "--no-mirror", "--json"], { env: { ...base, EMBEDDINGS_ENABLED: "false" } });
  must(made.code === 0, `setup: 0.8 parachute-vault create exited ${made.code}: ${made.stderr.slice(-600)}`);
  await m.expose(port);
  const box = await serve(prevBin, "0.8 serve");
  try {
    const rot = await prev(["auth", "rotate-operator"]);
    must(rot.code === 0, `setup: 0.8 auth rotate-operator exited ${rot.code}: ${rot.stderr.slice(-600)}`);
    writer = await mintWith(prevBin, "old-writer", "write");
    const admin = await mintWith(prevBin, "old-admin", "admin");
    const t = await api(admin).put("/tags/project", { fields: { status: { type: "string" } } });
    must(t.status === 200 || t.status === 201, `setup: a tag with fields gave ${t.status}: ${JSON.stringify(t.body).slice(0, 300)}`);
    await post(writer, "plan", "A made-up plan for the community garden.", ["project"]);
    await post(writer, "label", "Bring the seed catalogue on Saturday.", ["pinned"]);
  } finally {
    await box.stop();
  }
  expect(existsSync(join(m.home, "run", "release.json"))).toBe(false);
}, 240_000);

afterAll(async () => {
  await m?.dispose();
});

describe("lifecycle/upgrade", () => {
  test("0.9's first command on a 0.8 home backs its databases up first, outside the home, and only once", async () => {
    const before = dbHashes();
    const r = await core(["keys", "list", "--json"]);
    must(r.code === 0, `keys list exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(r.stderr).toContain("0.8 → ");
    const keys = JSON.parse(r.stdout);
    expect(keys.find((k: any) => k.name === "old-writer")).toMatchObject({ status: "active", levels: { [vault]: "write" } });

    const rel = release();
    expect(rel).toMatchObject({ previous: "0.8", state: "current" });
    expect(rel.version).toBe(JSON.parse((await core(["version", "--json"])).stdout).version);
    expect(backups().length).toBe(1);
    expect(rel.backup.startsWith(join(dirname(m.home), "parachute-upgrade") + "/")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(rel.backup, "manifest.json"), "utf8"));
    expect(Object.keys(manifest.files).sort()).toEqual(["hub.db", join("vault", "data", vault, "vault.db")].sort());
    for (const [file, hash] of Object.entries(manifest.files)) expect(sha(join(rel.backup, "home", file))).toBe(hash as string);
    // The copy is the home as 0.8 left it: before 0.9 added its keys table.
    const copy = new Database(join(rel.backup, "home", "hub.db"), { readonly: true });
    expect(copy.query("SELECT 1 FROM sqlite_master WHERE name = 'keys'").get()).toBeNull();
    copy.close();
    expect(before.hub).not.toBe(dbHashes().hub); // 0.9 did open it (its keys table), after the copy

    await core(["keys", "list"]);
    expect(backups().length).toBe(1);
  }, 120_000);

  test("0.9 serves the 0.8 home: 0.8's key reads, a tag with fields is a type, 0.9 writes; rollback waits for it to stop", async () => {
    const box = await serve(info.bin, "0.9 serve");
    try {
      expect((await api(writer).get(`/notes/${ids.plan}`)).body).toMatchObject({ types: ["project"] });
      expect((await api(writer).get(`/notes/${ids.label}`)).body).toMatchObject({ types: [], tags: ["pinned"] });
      const made = await core(["keys", "new", "nine-writer", "--vault", vault, "--can", "write"]);
      must(made.code === 0, `keys new exited ${made.code}: ${made.stderr.slice(-600)}`);
      nine = made.stdout.trim().split("\n").pop()!.trim();
      await post(nine, "nine", "Written under 0.9 with a key made by keys new.", ["project"]);
      const held = await core(["upgrade", "--rollback"]);
      expect(held.code).toBe(7);
    } finally {
      await box.stop();
    }
  }, 180_000);

  test("rollback, code-only: nothing on disk changes, 0.8 serves every 0.9 write, and 0.9 then picks up 0.8's", async () => {
    const before = dbHashes();
    const r = await core(["upgrade", "--rollback", "--json"]);
    must(r.code === 0, `upgrade --rollback exited ${r.code}: ${r.stderr.slice(-600)}`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toMatchObject({ rolled_back: true, mode: "code-only", to: "0.8" });
    expect(dbHashes()).toEqual(before);
    expect(release().state).toBe("rolled-back");

    const box = await serve(prevBin, "0.8 serve after the rollback");
    try {
      expect((await api(writer).get(`/notes/${ids.nine}`)).body?.content).toBe("Written under 0.9 with a key made by keys new.");
      expect((await api(nine).get(`/notes/${ids.plan}`)).status).toBe(200); // a 0.9 key is a token 0.8 verifies
      await post(writer, "eight", "Written under 0.8 after the rollback.", ["project"]);
      await mintWith(prevBin, "after-rollback", "read");
    } finally {
      await box.stop();
    }

    const again = await core(["keys", "list", "--json"]);
    must(again.code === 0, `keys list exited ${again.code}: ${again.stderr.slice(-600)}`);
    expect(JSON.parse(again.stdout).map((k: any) => k.name)).toEqual(expect.arrayContaining(["old-writer", "nine-writer", "after-rollback"]));
    expect(backups().length).toBe(2); // forward again, backed up again
    expect(release()).toMatchObject({ previous: "0.8", state: "current" });
  }, 240_000);

  test("rollback --restore: notes changed since the backup are exported, the backup's databases go back, and 0.8 serves them", async () => {
    const box = await serve(info.bin, "0.9 serve");
    try {
      await post(writer, "late", "Written under 0.9 after the second backup.");
    } finally {
      await box.stop();
    }
    expect((await core(["upgrade", "--rollback", "--restore"])).code).toBe(2); // no --yes, nobody to ask
    const r = await core(["upgrade", "--rollback", "--restore", "--yes", "--json"]);
    must(r.code === 0, `upgrade --rollback --restore exited ${r.code}: ${r.stderr.slice(-600)}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out).toMatchObject({ rolled_back: true, mode: "restore" });
    expect(out.exported_notes).toBeGreaterThanOrEqual(1);
    const exported = readdirSync(out.exported_to).map((f) => readFileSync(join(out.exported_to, f), "utf8")).join("\n");
    expect(exported).toContain("Written under 0.9 after the second backup.");

    const back = await serve(prevBin, "0.8 serve on the restored home");
    try {
      expect((await api(writer).get(`/notes/${ids.late}`)).status).toBe(404);
      expect((await api(writer).get(`/notes/${ids.eight}`)).status).toBe(200);
    } finally {
      await back.stop();
    }
    expect((await core(["upgrade", "--rollback"])).code).toBe(1); // nothing left to roll back
  }, 240_000);

  test("a database that can't be read: no backup, no record, no crash; the command goes on and fails its own way", async () => {
    // A vault that can't open must stop serve with its own exit (lifecycle/shutdown "vault start failure"); the
    // upgrade step must not crash first and hide that.
    const home = newHome("up-unreadable");
    must((await cli(home, ["create", "brokenv", "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } })).code === 0, "setup: vault create");
    const db = join(home, "vault", "data", "brokenv", "vault.db");
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, "Made-up bytes that are not a database.\n".repeat(200));
    const r = await cli(home, ["user", "list"]);
    expect(r.stderr).toContain("can't read vault/data/brokenv/vault.db; no upgrade backup taken, and none recorded");
    expect(r.stderr).not.toMatch(/SQLiteError|^\s+at /m);
    expect(existsSync(join(home, "run", "release.json"))).toBe(false);
    expect(existsSync(join(dirname(home), "parachute-upgrade"))).toBe(false);
  }, 120_000);

  test("a home 0.9 made has no earlier release: no backup, nothing to roll back", async () => {
    const home = newHome("up-fresh");
    must((await cli(home, ["user", "password", "--username", "owner", "--password", `pw-${randomBytes(12).toString("hex")}`])).code === 0, "setup: user password");
    must((await cli(home, ["create", "fresh", "--no-mirror", "--json"], { vault: true, env: { EMBEDDINGS_ENABLED: "false" } })).code === 0, "setup: vault create");
    const r = await cli(home, ["keys", "list"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("backing up");
    expect(existsSync(join(dirname(home), "parachute-upgrade"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "run", "release.json"), "utf8"))).toMatchObject({ previous: null, backup: null });
    expect((await cli(home, ["upgrade", "--rollback"])).code).toBe(1);
  }, 120_000);
});
