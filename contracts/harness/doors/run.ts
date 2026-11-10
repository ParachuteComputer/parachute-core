// `bun run doors`: run the door contracts (suites/door) against each door, then compare the doors.
//
//   bun run doors                              the box (the built candidate) and, when CLOUD_REPO is set, cloud
//   bun run doors -- --doors box,cloud,personal
//   bun run doors -- suites/door/rest.test.ts  only those files; other args go to `bun test`
//
//   CANDIDATE_DIR=<dir>     the box: a built candidate (default .cache/candidate-core, from `bun run build:core`)
//   CLOUD_REPO=<dir>        cloud: a parachute-cloud checkout, dependencies installed, engine pin materialised
//   PERSONAL_REPO=<dir>     personal: a checkout that has the single-owner profile (OWNER_PUBKEY)
//   DOOR_RESULTS=<dir>      where the results go (default .cache/doors); the only thing a run leaves behind
//
// Everything runs inside the sandbox (harness/sandbox.ts): the box and both workers of each cloud-style door share
// one private loopback, and nothing can reach the network or the machine's own Parachute. The contracts are the same
// files for every door. What differs per door is how the first sign-in is made, and that happens here.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { enterSandbox, inSandbox } from "../sandbox.ts";
import { loadCandidate, prepareInfo, runCli } from "../candidate.ts";
import { safeFetch } from "../guard.ts";
import type { Door } from "../../suites/door/_door.ts";
import { linkOwnerKeyOnBox, startBoxDoor } from "./box.ts";
import { makeOwnerKey, nostrAuthorization, signUp, startWorkersDoor } from "./workers.ts";
import { compare, readFingerprint, type Deliberate } from "./compare.ts";
import { recordExport } from "../../suites/door/_exit.ts";
import { appendFileSync, readdirSync, statSync } from "node:fs";

const contracts = resolve(import.meta.dir, "..", "..");
if (!inSandbox() && !process.env.PCORE_SANDBOX) {
  // Outside: name what the sandbox must keep. Results and the cloud checkouts are writable (wrangler builds into its
  // checkout); everything else of the host's home stays hidden.
  const results = resolve(process.env.DOOR_RESULTS ?? join(contracts, ".cache", "doors"));
  mkdirSync(results, { recursive: true });
  process.env.DOOR_RESULTS = results;
  const share = [results, process.env.CLOUD_REPO, process.env.PERSONAL_REPO].filter(Boolean).map((p) => resolve(p!));
  process.env.DOOR_SHARE = [...(process.env.DOOR_SHARE ?? "").split(":").filter(Boolean), ...share].join(":");
  // The sandbox's /tmp is its own; a TMPDIR under the hidden home would not exist inside.
  delete process.env.TMPDIR;
}
await enterSandbox();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const want = (flag("--doors") ?? ["box", process.env.CLOUD_REPO ? "cloud" : "", process.env.PERSONAL_REPO ? "personal" : ""].filter(Boolean).join(",")).split(",");
const files = args.filter((a) => a.startsWith("suites/"));
const rest = args.filter((a) => !a.startsWith("suites/"));
const results = process.env.DOOR_RESULTS!;
const scratch = join(process.env.TMPDIR ?? "/tmp", `doors-${randomBytes(4).toString("hex")}`);
mkdirSync(scratch, { recursive: true });

/** Make a vault through the account door, the same call on every door. */
async function ensureVault(issuer: string, accountBearer: string, name: string): Promise<void> {
  const r = await safeFetch(`${issuer}/account/vaults`, {
    method: "POST",
    headers: { authorization: `Bearer ${accountBearer}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`door: making vault ${name} through the account door gave ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
async function accountBearer(issuer: string, s: { cookie: string; csrf: string }): Promise<string> {
  const r = await safeFetch(`${issuer}/account/token`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: issuer, cookie: s.cookie },
    body: JSON.stringify({ __csrf: s.csrf }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`door: POST /account/token gave ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.token;
}

interface Started {
  door: Door;
  provenance: string;
  /** A door with no export over HTTP: its own export of the vault, as files (the box's CLI). */
  exportFiles?: () => Promise<{ name: string; bytes: Uint8Array }[]>;
  stop(): Promise<void>;
  logs(): Promise<string> | string;
}

async function startBox(): Promise<Started> {
  const dir = resolve(process.env.CANDIDATE_DIR ?? join(contracts, ".cache", "candidate-core"));
  const { manifest, sha256 } = await loadCandidate(dir);
  const info = prepareInfo(dir, manifest, sha256);
  const box = await startBoxDoor(info);
  const other = `other${randomBytes(3).toString("hex")}`;
  await ensureVault(box.issuer, await accountBearer(box.issuer, box.session), other);
  const release = /\b0\.9\./.test(JSON.stringify(manifest.version ?? "")) ? "0.9" : "0.8";
  // A 0.9 box: link a made-up key to the admin's account through the account door, as its owner would.
  let ownerKey: string | undefined;
  if (release === "0.9") {
    const owner = await makeOwnerKey();
    await linkOwnerKeyOnBox(box.issuer, box.session, owner.secretKey, box.admin.password);
    ownerKey = owner.secretKey;
  }
  return {
    door: { kind: "box", label: `box-${release}`, release, issuer: box.issuer, vaultOrigin: box.vaultOrigin, vault: box.vault, otherVault: other, signIn: { how: "cookie", ...box.session }, ...(ownerKey ? { ownerKey } : {}) },
    provenance: `box: candidate ${sha256.slice(0, 16)} (${manifest.name}, profile ${manifest.profile}, core ${manifest.core_commit})`,
    exportFiles: async () => {
      const dir = join(info.scratch, `export-${randomBytes(3).toString("hex")}`);
      const s = box.running.services;
      const r = await runCli(info, s.home, ["export", dir, "--vault", box.vault], { bin: info.vaultBin });
      if (r.code !== 0) throw new Error(`door: the box's export failed (${r.code}): ${r.stderr.slice(-400)}`);
      const walk = (d: string, rel = ""): { name: string; bytes: Uint8Array }[] =>
        readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), `${rel}${n}/`) : [{ name: `${rel}${n}`, bytes: new Uint8Array(readFileSync(join(d, n))) }]));
      return walk(dir);
    },
    stop: async () => {
      await box.running.stop();
      rmSync(info.scratch, { recursive: true, force: true });
    },
    logs: () => box.running.logs(),
  };
}

function gitHead(repo: string): string {
  const r = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const dirty = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=no"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  return `${r.stdout.toString().trim() || "?"}${dirty ? " (edited)" : ""}`;
}
function corePin(repo: string): string {
  const f = join(repo, "scripts", "core-source.env");
  return existsSync(f) ? (readFileSync(f, "utf8").match(/^PARACHUTE_CORE_REF="([0-9a-f]{7})/m)?.[1] ?? "?") : "?";
}

async function startCloud(): Promise<Started> {
  const repo = resolve(process.env.CLOUD_REPO ?? "");
  if (!process.env.CLOUD_REPO || !existsSync(join(repo, "workers", "vault"))) throw new Error("door: set CLOUD_REPO to a parachute-cloud checkout");
  const w = await startWorkersDoor({ repo, scratch, label: "cloud" });
  try {
    const me = await signUp(w.issuer);
    const bearer = await accountBearer(w.issuer, me);
    const id = randomBytes(3).toString("hex");
    const vault = `door${id}`;
    const other = `other${id}`;
    await ensureVault(w.issuer, bearer, vault);
    await ensureVault(w.issuer, bearer, other);
    return {
      door: { kind: "cloud", label: "cloud-0.8", release: "0.8", issuer: w.issuer, vaultOrigin: w.vaultOrigin, vault, otherVault: other, signIn: { how: "cookie", cookie: me.cookie, csrf: me.csrf } },
      provenance: `cloud: parachute-cloud ${gitHead(repo)}, core pin ${corePin(repo)}, local workerd`,
      stop: w.stop,
      logs: w.logs,
    };
  } catch (err) {
    await w.stop();
    throw err;
  }
}

/** The owner of a key-only door signs in with the key: NIP-98 on POST /account/token. */
async function accountBearerByKey(issuer: string, secretKey: string): Promise<string> {
  const url = `${issuer}/account/token`;
  const r = await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuthorization(secretKey, url, "POST") } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`door: the owner key's sign-in gave ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.token;
}

async function startPersonal(): Promise<Started> {
  const repo = resolve(process.env.PERSONAL_REPO ?? "");
  if (!process.env.PERSONAL_REPO || !existsSync(join(repo, "deploy", "personal"))) throw new Error("door: set PERSONAL_REPO to a parachute-cloud checkout that has deploy/personal");
  const owner = await makeOwnerKey();
  const w = await startWorkersDoor({ repo, scratch, label: "personal", profile: { kind: "personal", ownerPubkey: owner.pubkey } });
  try {
    const bearer = await accountBearerByKey(w.issuer, owner.secretKey);
    const id = randomBytes(3).toString("hex");
    const vault = `door${id}`;
    const other = `other${id}`;
    await ensureVault(w.issuer, bearer, vault);
    await ensureVault(w.issuer, bearer, other);
    return {
      door: { kind: "personal", label: "personal-0.9", release: "0.9", issuer: w.issuer, vaultOrigin: w.vaultOrigin, vault, otherVault: other, signIn: { how: "nostr", secretKey: owner.secretKey }, ownerKey: owner.secretKey },
      provenance: `personal: parachute-cloud ${gitHead(repo)} (deploy/personal profile), core pin ${corePin(repo)}, local workerd`,
      stop: w.stop,
      logs: w.logs,
    };
  } catch (err) {
    const tail = w.logs();
    await w.stop();
    throw new Error(`${(err as Error).message}\n${tail.slice(-1500)}`);
  }
}

const starters: Record<string, () => Promise<Started>> = { box: startBox, cloud: startCloud, personal: startPersonal };

let failed = 0;
const lines: string[] = [];
const labels: string[] = [];
for (const name of want) {
  const start = starters[name];
  if (!start) throw new Error(`door: no such door "${name}" (have: ${Object.keys(starters).join(", ")})`);
  const t0 = Date.now();
  let s: Started;
  try {
    s = await start();
  } catch (err) {
    console.error(`[doors] ${name}: did not start: ${(err as Error).message}`);
    failed++;
    continue;
  }
  const label = s.door.label;
  labels.push(label);
  const out = join(results, label);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const doorFile = join(scratch, `${label}.door.json`);
  const fingerprint = join(out, "fingerprint.jsonl");
  writeFileSync(doorFile, JSON.stringify({ ...s.door, fingerprint }), { mode: 0o600 });
  console.log(`[doors] ${label}: ${s.provenance} (${Date.now() - t0} ms)`);
  writeFileSync(join(out, "provenance.txt"), `${s.provenance}\n`);
  const child = Bun.spawn(
    ["bun", "test", "--timeout", "120000", "--reporter=junit", `--reporter-outfile=${join(out, "junit.xml")}`, ...(files.length ? files : ["suites/door"]).map((d) => `./${d}`), ...rest],
    { cwd: contracts, env: { ...process.env, CONTRACT_DOOR: doorFile }, stdout: "pipe", stderr: "pipe" },
  );
  const [so, se, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(out, "output.txt"), `${so}${se}`.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<token>"));
  const summary = `${so}${se}`.split("\n").filter((l) => /^\s*\d+ (pass|fail|skip)|^Ran \d+ tests/.test(l)).map((l) => l.trim()).join(", ");
  console.log(`[doors] ${label}: ${code === 0 ? "PASS" : "FAIL"} (${summary})`);
  lines.push(`${code === 0 ? "PASS" : "FAIL"} ${label} (${summary})`);
  // The box's exit is its own command: record what it exports under the same keys the HTTP exit records.
  if (s.exportFiles && !files.length) {
    try {
      recordExport(await s.exportFiles(), (key, value) => appendFileSync(fingerprint, `${JSON.stringify({ key, value })}\n`));
    } catch (err) {
      console.error(`[doors] ${label}: ${(err as Error).message}`);
      failed++;
    }
  }
  if (code !== 0) {
    failed++;
    console.log(`${so}${se}`.split("\n").filter((l) => /\(fail\)|error:|Expected|Received|^\s+at /.test(l)).slice(0, 80).join("\n"));
    writeFileSync(join(out, "door.log"), String(await s.logs()).replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<token>").replace(/pvk_[A-Za-z0-9_-]+/g, "pvk_<redacted>").slice(-200_000));
  }
  await s.stop();
}

// The second half: what an app could branch on must be the same on every door, apart from what deliberate.json names.
if (labels.length > 1 && !files.length) {
  const deliberate: Deliberate[] = JSON.parse(readFileSync(join(contracts, "suites", "door", "deliberate.json"), "utf8")).differences;
  const prints = Object.fromEntries(labels.map((l) => [l, readFingerprint(join(results, l, "fingerprint.jsonl"))]));
  const c = compare(prints, deliberate);
  writeFileSync(join(results, "COMPARE.md"), c.report);
  console.log(c.summary);
  lines.push(c.summary);
  if (!c.ok) failed++;
}
writeFileSync(join(results, "SUMMARY.txt"), `${lines.join("\n")}\n`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
