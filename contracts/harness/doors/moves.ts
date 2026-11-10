// `bun run moves`: one made-up vault moves between the three doors in every direction, with the move tool
// (tools/move) as a person would run it, and every arrival is checked by digest.
//
//   CANDIDATE_DIR=<dir>   the box (default .cache/candidate-core)
//   CLOUD_REPO=<dir>      Parachute Cloud: a parachute-cloud checkout with the account door's import
//   PERSONAL_REPO=<dir>   the personal door: a checkout with deploy/personal (and the same import)
//   MOVE_RESULTS=<dir>    where the evidence goes (default .cache/moves)
//
// The trip: cloud → personal → box → cloud, the old door closed a different way each time, and the vault that comes
// home must digest the same as the one that left. Then the three remaining directions (cloud → box, box → personal,
// personal → cloud), and the refusals: a taken name, a target that was changed, a source written to before it is
// deleted, a note the export format can't carry.
//
// Everything runs inside the sandbox on one private loopback (harness/sandbox.ts). The data is made up (seed.ts).
// What is written to MOVE_RESULTS holds counts, digests and the tool's own output: no note text, no credential.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { enterSandbox, inSandbox } from "../sandbox.ts";
import { loadCandidate, prepareInfo, runCli } from "../candidate.ts";
import { safeFetch } from "../guard.ts";
import { compareDigests, digestFromBox, digestOverRest } from "../../../tools/move/digest.ts";
import { emptyBoxHome, serveBoxHome, startBoxDoor } from "./box.ts";
import { seedVault } from "./seed.ts";
import { makeOwnerKey, nostrAuthorization, signUp, startWorkersDoor } from "./workers.ts";

const contracts = resolve(import.meta.dir, "..", "..");
const repo = resolve(contracts, "..");
if (!inSandbox() && !process.env.PCORE_SANDBOX) {
  const results = resolve(process.env.MOVE_RESULTS ?? join(contracts, ".cache", "moves"));
  mkdirSync(results, { recursive: true });
  process.env.MOVE_RESULTS = results;
  for (const k of ["CLOUD_REPO", "PERSONAL_REPO"]) if (!process.env[k]) throw new Error(`moves: set ${k}`);
  process.env.DOOR_SHARE = [...(process.env.DOOR_SHARE ?? "").split(":").filter(Boolean), results, resolve(process.env.CLOUD_REPO!), resolve(process.env.PERSONAL_REPO!)].join(":");
  delete process.env.TMPDIR;
}
await enterSandbox();

const results = process.env.MOVE_RESULTS!;
const scratch = join(process.env.TMPDIR ?? "/tmp", `moves-${randomBytes(4).toString("hex")}`);
const secrets = join(scratch, "secrets");
mkdirSync(secrets, { recursive: true, mode: 0o700 });
const summary: string[] = [];
let failed = 0;
const res = (ok: boolean, what: string, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`;
  console.log(`[moves] ${line}`);
  summary.push(line);
  if (!ok) failed++;
  return ok;
};
const clean = (s: string) => s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<token>").split(scratch).join("<run>");
const secretFile = (name: string, value: string) => {
  const f = join(secrets, name);
  writeFileSync(f, value, { mode: 0o600 });
  return f;
};
const doorFile = (name: string, body: Record<string, unknown>) => {
  const f = join(scratch, `${name}.door.json`);
  writeFileSync(f, JSON.stringify(body, null, 1));
  return f;
};

/** Run the move tool as a person would: `bun tools/move/move.ts …`. Its output is the evidence. */
async function tool(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", join(repo, "tools", "move", "move.ts"), ...args], { env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe" });
  const [so, se, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: clean(`${so}${se}`) };
}

interface Moved {
  ok: boolean;
  dir: string;
  manifest: any;
}
let n = 0;
/** One move, kept as evidence under `<results>/<n>-<name>/`. The tool's working folder (with private lines) stays in scratch. */
async function move(name: string, from: string, to: string, vault: string, extra: string[] = []): Promise<Moved> {
  const label = `${String(++n).padStart(2, "0")}-${name}`;
  const work = join(scratch, "moves", label);
  const out = join(results, label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = await tool(["run", from, to, "--vault", vault, "--out", work, ...extra]);
  writeFileSync(join(out, "log.txt"), r.out);
  let manifest: any = null;
  for (const f of ["MOVE.json", "VERIFY.txt", "REKEY.md"]) {
    if (!existsSync(join(work, f))) continue;
    const text = clean(readFileSync(join(work, f), "utf8"));
    writeFileSync(join(out, f), text);
    if (f === "MOVE.json") manifest = JSON.parse(text);
  }
  const ok = r.code === 0 && manifest?.verified === true;
  res(ok, `move ${name}`, ok ? `${manifest.verdict}; ${manifest.digests.source.counts.notes} notes, ${manifest.attached_files.length} files; all ${manifest.digests.target.digests.all.slice(0, 16)}; ${manifest.seconds} s` : `exit ${r.code}: ${r.out.trim().split("\n").slice(-2).join(" / ").slice(0, 300)}`);
  return { ok, dir: work, manifest };
}
/** Run a follow-up on a move's folder (verify, close) and add what it said to that move's log. */
async function after(m: Moved, args: string[]): Promise<{ code: number; out: string }> {
  const r = await tool([args[0]!, m.dir, ...args.slice(1)]);
  const label = m.dir.split("/").pop()!;
  writeFileSync(join(results, label, "log.txt"), `${readFileSync(join(results, label, "log.txt"), "utf8")}\n$ move.ts ${args.join(" ")}\n${r.out}`);
  if (existsSync(join(m.dir, "MOVE.json"))) copyFileSync(join(m.dir, "MOVE.json"), join(results, label, "MOVE.json"));
  return r;
}

// ── a signed-in owner at an HTTP door, for seeding and for checks the tool doesn't make ─────────────────────
interface Owner {
  issuer: string;
  vaultOrigin: string;
  account(): Promise<string>;
}
async function vaultToken(o: Owner, vault: string, levels: string[]): Promise<string> {
  const r = await safeFetch(`${o.issuer}/account/vaults/${vault}/token`, { method: "POST", headers: { authorization: `Bearer ${await o.account()}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: levels.map((l) => `vault:${vault}:${l}`) }) });
  const j: any = await r.json();
  if (!j.vault_token) throw new Error(`moves: a token for ${vault} gave ${r.status}`);
  return j.vault_token;
}
async function makeVault(o: Owner, name: string): Promise<void> {
  const r = await safeFetch(`${o.issuer}/account/vaults`, { method: "POST", headers: { authorization: `Bearer ${await o.account()}`, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (r.status !== 201) throw new Error(`moves: making ${name} gave ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function listVaults(o: Owner): Promise<string[]> {
  const j: any = await (await safeFetch(`${o.issuer}/account/vaults`, { headers: { authorization: `Bearer ${await o.account()}` } })).json();
  return (Array.isArray(j) ? j : j.vaults).map((v: { name: string }) => v.name);
}
const restDigest = async (o: Owner, vault: string) => {
  const token = await vaultToken(o, vault, ["read"]);
  return digestOverRest((path) => safeFetch(`${o.vaultOrigin}/vault/${vault}${path}`, { headers: { authorization: `Bearer ${token}` } }), vault);
};
const cookieOwner = (issuer: string, vaultOrigin: string, s: { cookie: string; csrf: string }): Owner => ({
  issuer,
  vaultOrigin,
  account: async () => {
    const r = await safeFetch(`${issuer}/account/token`, { method: "POST", headers: { "content-type": "application/json", origin: issuer, cookie: s.cookie }, body: JSON.stringify({ __csrf: s.csrf }) });
    return ((await r.json()) as { token: string }).token;
  },
});

const stops: (() => Promise<void>)[] = [];
try {
  // ── the three doors ──────────────────────────────────────────────────────────────────────────────────────
  // The box starts first: its start-up check wants every listener in the sandbox to be the box itself.
  const dir = resolve(process.env.CANDIDATE_DIR ?? join(contracts, ".cache", "candidate-core"));
  const { manifest, sha256 } = await loadCandidate(dir);
  const info = prepareInfo(dir, manifest, sha256);
  // Its home is kept when it stops: a later move exports from it with the box's command, with nothing serving.
  const boxA = await startBoxDoor(info, { keep: true });
  let boxAStopped = false;
  const stopBoxA = async () => {
    if (!boxAStopped) await boxA.running.stop();
    boxAStopped = true;
  };
  stops.push(stopBoxA);
  const cloudW = await startWorkersDoor({ repo: resolve(process.env.CLOUD_REPO!), scratch, label: "cloud" });
  stops.push(cloudW.stop);
  const key = await makeOwnerKey();
  const personalW = await startWorkersDoor({ repo: resolve(process.env.PERSONAL_REPO!), scratch, label: "personal", profile: { kind: "personal", ownerPubkey: key.pubkey } });
  stops.push(personalW.stop);
  const me = await signUp(cloudW.issuer);
  const cloud = cookieOwner(cloudW.issuer, cloudW.vaultOrigin, me);
  const personal: Owner = {
    issuer: personalW.issuer,
    vaultOrigin: personalW.vaultOrigin,
    account: async () => {
      const url = `${personalW.issuer}/account/token`;
      return ((await (await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuthorization(key.secretKey, url, "POST") } })).json()) as { token: string }).token;
    },
  };
  const boxOwner = cookieOwner(boxA.issuer, boxA.vaultOrigin, boxA.session);
  const boxRelease = /\b0\.9\./.test(JSON.stringify(manifest.version ?? "")) ? "0.9" : "0.8";
  console.log(`[moves] doors: box ${manifest.core_commit} (${boxRelease}), cloud and personal on local workerd`);

  // Door files, as a person would write them. Secrets are files beside them, named but never read into a log.
  const CLOUD = doorFile("cloud", { kind: "cloud", issuer: cloudW.issuer, vault_origin: cloudW.vaultOrigin, session_file: secretFile("cloud-session.json", JSON.stringify({ cookie: me.cookie, csrf: me.csrf })), release: "0.8" });
  const keyFile = secretFile("owner.key", key.secretKey);
  const PERSONAL = doorFile("personal", { kind: "personal", issuer: personalW.issuer, vault_origin: personalW.vaultOrigin, owner_key_file: keyFile, release: "0.9" });
  // The same personal door, entered by its operator for the owner (on your own door you are both).
  const PERSONAL_OP = doorFile("personal-operator", { kind: "personal", issuer: personalW.issuer, vault_origin: personalW.vaultOrigin, owner_key_file: keyFile, ops_token_file: personalW.opsTokenFile, owner_email_file: secretFile("owner.email", `${key.pubkey}@nostr.invalid`), release: "0.9" });
  const boxEnv = (home: string) => ({ ...boxA.running.services.cliEnv, PARACHUTE_HOME: home });
  const BOX_A = doorFile("box-a", { kind: "box", home: boxA.running.services.home, cli: [info.vaultBin], env: boxEnv(boxA.running.services.home), release: boxRelease });
  const homeB = await emptyBoxHome(info, "boxb");
  const BOX_B = doorFile("box-b", { kind: "box", home: homeB.home, cli: [info.vaultBin], env: homeB.env, release: boxRelease });
  const homeC = await emptyBoxHome(info, "boxc");
  const BOX_C = doorFile("box-c", { kind: "box", home: homeC.home, cli: [info.vaultBin], env: homeC.env, release: boxRelease });

  // ── the made-up vault, on Parachute Cloud ────────────────────────────────────────────────────────────────
  await makeVault(cloud, "atlas");
  const seeded = await seedVault(`${cloudW.vaultOrigin}/vault/atlas`, await vaultToken(cloud, "atlas", ["read", "write", "admin"]));
  const start = await restDigest(cloud, "atlas");
  res(start.counts.notes >= seeded.notes && start.counts.attachments >= 4 && start.risks.length === 0, "the made-up vault is on cloud", `${start.counts.notes} notes, ${start.counts.links} links, ${start.counts.attachments} files on notes, ${start.counts.tag_schemas} types; all ${start.digests.all.slice(0, 16)}`);

  // ── a box is read two ways, and they agree ───────────────────────────────────────────────────────────────
  // The moves read a box from its database. A door is read over REST. If the two readers disagreed on the same
  // vault, "equal after the move" would mean less than it says.
  await makeVault(boxOwner, "fieldnotes");
  await seedVault(`${boxA.vaultOrigin}/vault/fieldnotes`, await vaultToken(boxOwner, "fieldnotes", ["read", "write", "admin"]));
  const boxDir = join(boxA.running.services.home, "vault", "data", "fieldnotes");
  const viaRest = await restDigest(boxOwner, "fieldnotes");
  const viaDb = await digestFromBox(join(boxDir, "vault.db"), join(boxDir, "assets"), "fieldnotes");
  const witness = compareDigests(viaRest, viaDb, { names: ["over REST", "from the database"] });
  writeFileSync(join(results, "box-two-readers.txt"), `${witness.lines.join("\n")}\n`);
  res(witness.verdict === "DIGEST EQUAL", "a box read over REST and from its database gives one digest", `all ${viaRest.digests.all.slice(0, 16)}; ${viaDb.counts.versions} earlier versions are in the database only`);
  // One box serves at a time here: a box's vault takes a fixed port. This one stops; its files stay.
  await stopBoxA();

  // ── the trip: cloud → personal → box → cloud ─────────────────────────────────────────────────────────────
  const m1 = await move("cloud-to-personal", CLOUD, PERSONAL, "atlas");
  if (m1.ok) {
    const v = await after(m1, ["verify"]);
    res(v.code === 0, "verify again later: both doors still hold what moved");
    const c = await after(m1, ["close", "--delete"]);
    res(c.code === 0 && !(await listVaults(cloud)).includes("atlas"), "close --delete: the old vault is gone from cloud", c.out.trim().split("\n").pop());
  }

  // An app holds a named key at the personal door; closing with --disconnect must stop it.
  const appKey: any = await (await safeFetch(`${personalW.issuer}/account/keys`, { method: "POST", headers: { authorization: `Bearer ${await personal.account()}`, "content-type": "application/json" }, body: JSON.stringify({ name: "atlas-field-app", vault: "atlas", can: "write" }) })).json();
  const keyReads = async () => (await safeFetch(`${personalW.vaultOrigin}/vault/atlas/api/notes?limit=1`, { headers: { authorization: `Bearer ${appKey.token}` } })).status;
  const before = await keyReads();

  const m2 = await move("personal-to-box", PERSONAL, BOX_B, "atlas");
  let boxB: Awaited<ReturnType<typeof serveBoxHome>> | null = null;
  if (m2.ok) {
    // The move wrote the box's files with nothing serving. Now the box serves them: the door must show the same vault.
    boxB = await serveBoxHome(info, homeB.home);
    stops.push(boxB.stop);
    const served = await restDigest(cookieOwner(boxB.issuer, boxB.vaultOrigin, boxB.session), "atlas");
    res(served.digests.all === m2.manifest.digests.target.digests.all, "the box serves what arrived: its REST digest is the move's", `all ${served.digests.all.slice(0, 16)}`);
    const rekey = readFileSync(join(m2.dir, "REKEY.md"), "utf8");
    res(/atlas-field-app/.test(rekey), "REKEY.md names the app key that has to be made again");
    const c = await after(m2, ["close", "--disconnect"]);
    const afterClose = await keyReads();
    res(c.code === 0 && before === 200 && afterClose === 401 && (await listVaults(personal)).includes("atlas"), "close --disconnect: the app's key stops, the vault and its history stay", `key read ${before} then ${afterClose}`);
  }

  const m3 = await move("box-to-cloud", BOX_B, CLOUD, "atlas");
  if (m3.ok) {
    res(m3.manifest.digests.target.digests.all === start.digests.all, "home again: the vault back on cloud digests the same as the one that left", `${start.digests.all.slice(0, 16)} left, ${m3.manifest.digests.target.digests.all.slice(0, 16)} came back`);
    const home = await restDigest(cloud, "atlas");
    const same = compareDigests(start, home, { names: ["before the trip", "after the trip"] });
    writeFileSync(join(results, "round-trip.txt"), `${same.lines.join("\n")}\n`);
    res(same.verdict === "DIGEST EQUAL", "read again through cloud's own door: every section equal to before the trip");
    const c = await after(m3, ["close", "--keep", "the box stays as a local copy"]);
    res(c.code === 0 && JSON.parse(readFileSync(join(m3.dir, "MOVE.json"), "utf8")).closed?.how === "kept", "close --keep: the box's copy stays, and the manifest says why");
  }

  // ── the other three directions ───────────────────────────────────────────────────────────────────────────
  const m4 = await move("cloud-to-box", CLOUD, BOX_C, "atlas");
  if (m4.ok) {
    // The new copy is lost (here: removed from the box). Deleting the old one now would leave none: refused.
    const gone = await runCli(info, homeC.home, ["remove", "atlas", "--yes"], { bin: info.vaultBin });
    const c = await after(m4, ["close", "--delete"]);
    res(gone.code === 0 && c.code === 1 && /is not deleted/.test(c.out) && (await listVaults(cloud)).includes("atlas"), "close --delete is refused when the new door no longer holds the vault", c.out.trim().split("\n").pop()?.slice(0, 150));
  }
  // Entered as the operator, the way a vault is moved for someone (the operator import).
  const m5 = await move("box-to-personal", BOX_A, PERSONAL_OP, "fieldnotes", ["--operator"]);
  if (m5.ok) {
    // The operator can't read a vault once it is handed over, and the door sets the description at that moment. The
    // owner can: read as the owner, every section must equal the box's, the description too.
    const asOwner = await restDigest(personal, "fieldnotes");
    const c = compareDigests(viaDb, asOwner, { names: ["the box", "the personal door, as its owner"] });
    writeFileSync(join(results, "05-box-to-personal", "as-owner.txt"), `${c.lines.join("\n")}\n`);
    res(c.verdict === "DIGEST EQUAL", "after the operator's hand-over, the owner reads the same vault, description included", `all ${asOwner.digests.all.slice(0, 16)}`);
  }
  const m6 = await move("personal-to-cloud", PERSONAL, CLOUD, "atlas", ["--as", "atlas-copy"]);

  // ── the proof can fail ───────────────────────────────────────────────────────────────────────────────────
  const taken = await tool(["plan", CLOUD, PERSONAL, "--vault", "atlas"]);
  res(taken.code === 1 && /already has a vault named atlas/.test(taken.out) && /Nothing was changed/.test(taken.out), "a taken name stops at the plan, before anything is written");

  if (m6.ok) {
    // Someone changes one note at the new door. The move's record no longer matches it.
    const t = await vaultToken(cloud, "atlas-copy", ["read", "write"]);
    const one: any = (await (await safeFetch(`${cloudW.vaultOrigin}/vault/atlas-copy/api/notes?limit=1&sort=asc`, { headers: { authorization: `Bearer ${t}` } })).json())[0];
    await safeFetch(`${cloudW.vaultOrigin}/vault/atlas-copy/api/notes/${one.id}`, { method: "PATCH", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ content: "changed after the move", force: true }) });
    const v = await after(m6, ["verify"]);
    res(v.code === 1 && /DIGEST DIFFERS/.test(v.out) && /no longer matches/.test(v.out), "one changed note at the target fails verify", (v.out.match(/DIFFER notes[^\n]*/) ?? [""])[0].replace(/\s+/g, " ").slice(0, 140));

    // The source is written to after the move. Deleting it would lose that write: refused.
    const st = await vaultToken(personal, "atlas", ["read", "write"]);
    await safeFetch(`${personalW.vaultOrigin}/vault/atlas/api/notes`, { method: "POST", headers: { authorization: `Bearer ${st}`, "content-type": "application/json" }, body: JSON.stringify({ path: "Journal/after the move", content: "Written at the old door after the move.\n" }) });
    const c = await after(m6, ["close", "--delete"]);
    res(c.code === 1 && /written to after the move/.test(c.out) && (await listVaults(personal)).includes("atlas"), "a source written to after the move is not deleted");
  }

  // A note the export format can't carry exactly: found by the plan, not after.
  await makeVault(cloud, "awkward");
  const at = await vaultToken(cloud, "awkward", ["read", "write"]);
  await safeFetch(`${cloudW.vaultOrigin}/vault/awkward/api/notes`, { method: "POST", headers: { authorization: `Bearer ${at}`, "content-type": "application/json" }, body: JSON.stringify({ path: "Odd/one", content: "A field name with a space.\n", metadata: { "review status": "open", ok: true } }) });
  const risky = await tool(["plan", CLOUD, PERSONAL, "--vault", "awkward"]);
  res(risky.code === 1 && /hold something the export format doesn't carry exactly/.test(risky.out), "a note the format can't carry exactly stops at the plan", (risky.out.match(/STOP[^\n]*/) ?? [""])[0].slice(0, 160));
  const accepted = await move("awkward-accepted", CLOUD, PERSONAL, "awkward", ["--accept-format-loss"]);
  if (accepted.ok) res(accepted.manifest.accepted_before_the_move?.notes >= 1, "accepted before the move, it moves, and the manifest says what was accepted", accepted.manifest.verdict);

  res(!failed, "all six directions moved and verified", "cloud→personal, personal→box, box→cloud, cloud→box, box→personal, personal→cloud");
} catch (err) {
  res(false, "the run", (err as Error).message.slice(0, 600));
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  writeFileSync(join(results, "SUMMARY.txt"), `${summary.join("\n")}\n`);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
