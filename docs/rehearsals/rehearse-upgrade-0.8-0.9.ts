// Rehearsal: 0.8 → 0.9 → rollback (code-only), → 0.9 → rollback --restore, on a COPY of a 0.8 home with made-up data.
// Run inside its own network namespace (unshare -rn), so no port of the live service is touched:
//   unshare -rn bun rehearse.ts <prev-bundle> <new-bundle> <scratch>
// Every process gets HOME and PARACHUTE_HOME inside <scratch>. Prints a plain log of each step and its result.
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [prevDir, newDir, scratch] = process.argv.slice(2) as [string, string, string];
spawnSync("ip", ["link", "set", "lo", "up"]);
const PORT = 41939;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VAULT = "garden";
const log = (s: string) => console.log(s);
const fail = (s: string): never => {
  console.log(`FAIL: ${s}`);
  process.exit(1);
};

function envFor(user: string) {
  return {
    PATH: `${join(newDir, "runtime")}:/usr/bin:/bin`,
    HOME: user,
    PARACHUTE_HOME: join(user, ".parachute"),
    PORT: String(PORT),
    PARACHUTE_HUB_ORIGIN: ORIGIN,
    PARACHUTE_BIND_HOST: "127.0.0.1",
    EMBEDDINGS_ENABLED: "false",
    TMPDIR: join(scratch, "tmp"),
  };
}
function run(dir: string, user: string, args: string[], bin = "parachute") {
  const r = spawnSync(join(dir, "bin", bin), args, { env: envFor(user), encoding: "utf8", timeout: 120_000 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
async function serve(dir: string, user: string, label: string) {
  const p = spawn(join(dir, "bin", "parachute"), ["serve"], {
    env: { ...envFor(user), PARACHUTE_INITIAL_ADMIN_USERNAME: "owner", PARACHUTE_INITIAL_ADMIN_PASSWORD: "rehearsal-made-up-pw-1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  p.stdout.on("data", (b) => (text += b));
  p.stderr.on("data", (b) => (text += b));
  for (let i = 0; i < 300; i++) {
    if (p.exitCode !== null) fail(`${label} exited ${p.exitCode}:\n${text.slice(-1500)}`);
    try {
      const r = await fetch(`${ORIGIN}/vault/${VAULT}/mcp`);
      if (r.status === 401) break;
    } catch {}
    await Bun.sleep(200);
  }
  log(`  ${label}: serving`);
  return {
    text: () => text,
    async stop() {
      p.kill("SIGTERM");
      await new Promise((res) => p.once("exit", res));
      log(`  ${label}: stopped`);
    },
  };
}
const api = (token: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${ORIGIN}/vault/${VAULT}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j: any = t;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
};
function mint(dir: string, user: string, label: string, scope: string, extra: string[] = []) {
  const r = run(dir, user, ["auth", "mint-token", "--scope", scope, "--label", label, ...extra]);
  const t = r.out.trim().split("\n").pop()!.trim();
  if (r.code !== 0 || t.split(".").length !== 3) fail(`mint ${label}: ${r.code} ${r.err.slice(-400)}`);
  return t;
}
const scopes = (lv: string[]) => lv.map((l) => `vault:${VAULT}:${l}`).join(" ");
async function count(token: string) {
  const r = await api(token)("GET", "/notes?limit=500");
  return Array.isArray(r.body) ? r.body.length : r.body?.notes?.length;
}
function hashTree(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(p.slice(root.length)).update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex").slice(0, 16);
}

const a = join(scratch, "original");
const b = join(scratch, "copy");
mkdirSync(a, { recursive: true });
mkdirSync(join(scratch, "tmp"), { recursive: true });

log("## 1. A 0.8 home with made-up data (the real 0.8 build)");
log(`  0.8: ${run(prevDir, a, ["version"]).out.trim()}; 0.9: ${run(newDir, a, ["version"]).out.trim()}`);
let r = run(prevDir, a, ["create", VAULT, "--no-mirror", "--json"], "parachute-vault");
if (r.code) fail(`create: ${r.err}`);
let s = await serve(prevDir, a, "0.8 serve");
if (run(prevDir, a, ["auth", "rotate-operator"]).code) fail("rotate-operator");
const admin = mint(prevDir, a, "rehearsal-admin", scopes(["read", "write", "admin"]));
const writer = mint(prevDir, a, "uni-tasks", scopes(["read", "write"]));
const scoped = mint(prevDir, a, "garden-only", scopes(["read"]), ["--permissions", JSON.stringify({ scoped_tags: ["compost"] })]);
const A = api(admin);
for (const [tag, def] of Object.entries({
  person: { fields: { email: { type: "string" } } },
  task: { fields: { status: { type: "string" }, due: { type: "date" } } },
  "task/chore": { parent_names: ["task"] },
})) {
  const t = await A("PUT", `/tags/${encodeURIComponent(tag)}`, def);
  if (t.status >= 300) fail(`tag ${tag}: ${t.status} ${JSON.stringify(t.body)}`);
}
const notes: [string, string[], string][] = [
  ["people/robin", ["person"], "Robin Example keeps the bees."],
  ["people/sam", ["person"], "Sam Example runs the seed swap."],
  ["tasks/turn-compost", ["task/chore", "compost"], "Turn the compost on Saturday."],
  ["tasks/order-seeds", ["task"], "Order the spring seeds."],
  ["notes/rye", ["pinned"], "Rye starter: feed 1:5:5."],
  ["notes/compost-log", ["compost"], "Pile 2 at 60 °C."],
  ["notes/untagged", [], "A note with no tags."],
  ["journal/2026-10-01", ["journal"], "Made-up journal line."],
];
const ids: Record<string, string> = {};
for (const [path, tags, content] of notes) {
  const w = await api(writer)("POST", "/notes", { path, tags, content });
  if (w.status !== 201) fail(`note ${path}: ${w.status}`);
  ids[path] = w.body.id;
}
log(`  ${notes.length} notes, 3 tags with fields or parents, 3 keys (one tag-scoped to #compost)`);
log(`  admin sees ${await count(admin)}; the #compost key sees ${await count(scoped)}`);
await s.stop();

log("\n## 2. Copy the 0.8 home; everything below runs on the copy");
cpSync(a, b, { recursive: true });
const originalHash = hashTree(join(a, ".parachute"));
log(`  original home hash ${originalHash}`);

log("\n## 3. 0.9's first command on the copy");
r = run(newDir, b, ["keys", "list"]);
log(r.err.split("\n").filter(Boolean).map((l) => `  stderr: ${l}`).join("\n"));
log(r.out.split("\n").filter(Boolean).map((l) => `  ${l}`).join("\n"));
const rel = JSON.parse(readFileSync(join(b, ".parachute", "run", "release.json"), "utf8"));
log(`  release.json: previous ${rel.previous}, version ${rel.version}, backup ${rel.backup.replace(scratch, "<scratch>")}`);
log(`  backup files: ${Object.keys(JSON.parse(readFileSync(join(rel.backup, "manifest.json"), "utf8")).files).join(", ")}`);

log("\n## 4. 0.9 serves it");
s = await serve(newDir, b, "0.9 serve");
const chore = await api(writer)("GET", `/notes/${ids["tasks/turn-compost"]}`);
const rye = await api(writer)("GET", `/notes/${ids["notes/rye"]}`);
log(`  turn-compost: types ${JSON.stringify(chore.body.types)}, tags ${JSON.stringify(chore.body.tags)}`);
log(`  rye: types ${JSON.stringify(rye.body.types)}, tags ${JSON.stringify(rye.body.tags)}`);
log(`  admin sees ${await count(admin)}; the #compost key sees ${await count(scoped)} (unchanged)`);
r = run(newDir, b, ["keys", "new", "rehearsal-nine", "--vault", VAULT, "--can", "write"]);
const nine = r.out.trim().split("\n").pop()!.trim();
const w9 = await api(nine)("POST", "/notes", { path: "tasks/written-under-0.9", tags: ["task"], content: "Written under 0.9." });
log(`  keys new rehearsal-nine → exit ${r.code}; a note written with it → ${w9.status}`);
r = run(newDir, b, ["upgrade", "--rollback"]);
log(`  upgrade --rollback while serving → exit ${r.code}: ${r.err.trim().split("\n")[0]}`);
await s.stop();

log("\n## 5. Roll back, code-only, and run 0.8 on it");
const before = hashTree(join(b, ".parachute", "vault"));
r = run(newDir, b, ["upgrade", "--rollback"]);
log(r.out.split("\n").filter(Boolean).map((l) => `  ${l}`).join("\n"));
log(`  vault files unchanged by the rollback: ${before === hashTree(join(b, ".parachute", "vault"))}`);
s = await serve(prevDir, b, "0.8 serve");
log(`  0.8 reads the 0.9 note: ${(await api(writer)("GET", `/notes/${w9.body.id}`)).status}; the 0.9 key reads: ${(await api(nine)("GET", "/notes?limit=1")).status}`);
log(`  admin sees ${await count(admin)}`);
const w8 = await api(writer)("POST", "/notes", { path: "tasks/written-under-0.8-again", tags: ["task"], content: "Written under 0.8 after the rollback." });
const t8 = await A("PUT", "/tags/event", { fields: { when: { type: "date" } } });
mint(prevDir, b, "minted-by-0.8-again", scopes(["read"]));
log(`  0.8 writes a note (${w8.status}), a new tag with fields (${t8.status}) and a key`);
await s.stop();

log("\n## 6. Forward to 0.9 again");
r = run(newDir, b, ["keys", "list"]);
log(r.err.split("\n").filter(Boolean).map((l) => `  stderr: ${l}`).join("\n"));
log(`  keys named: ${r.out.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean).join(", ")}`);
s = await serve(newDir, b, "0.9 serve");
log(`  0.8's new tag 'event' is a type: ${JSON.stringify((await A("POST", "/notes", { path: "events/fair", tags: ["event"], content: "Made-up fair." })).body.types)}`);
const late = await api(writer)("POST", "/notes", { path: "tasks/late", tags: ["task"], content: "Written under 0.9 after the second backup." });
log(`  a note written now (after the second backup): ${late.status}; admin sees ${await count(admin)}`);
await s.stop();

log("\n## 7. Roll back with --restore");
r = run(newDir, b, ["upgrade", "--rollback", "--restore", "--yes", "--json"]);
log(r.out.split("\n").filter(Boolean).map((l) => `  ${l.replace(new RegExp(scratch, "g"), "<scratch>")}`).join("\n"));
s = await serve(prevDir, b, "0.8 serve");
log(`  after the restore, 0.8: the late note → ${(await api(writer)("GET", `/notes/${late.body.id}`)).status}; the note 0.8 wrote → ${(await api(writer)("GET", `/notes/${w8.body.id}`)).status}; admin sees ${await count(admin)}`);
await s.stop();

log("\n## 8. The original 0.8 home was never touched");
log(`  original home hash ${hashTree(join(a, ".parachute"))} (before: ${originalHash})`);
log("\nREHEARSAL DONE");
