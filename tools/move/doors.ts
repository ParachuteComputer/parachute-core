// The two kinds of door a vault can move between, as the move tool sees them.
//
//   - an HTTP door (Parachute Cloud, or a personal door on your own Cloudflare): the vault leaves through
//     `GET /api/export` and arrives through the account door (`POST /account/vaults/import`, then one
//     `import-file` per attached file), or through the operator's `/ops/vault-import` when someone moves a vault
//     for its owner;
//   - a box: the vault leaves and arrives through the box's own command (`parachute-vault export` / `import`) on
//     the machine the box runs on. A box has no HTTP exit or entrance yet.
//
// A door file is JSON. It never holds a secret, only paths to files that do (mode 0600):
//
//   { "kind": "personal", "issuer": "https://me-identity.example.workers.dev",
//     "vault_origin": "https://me-vault.example.workers.dev", "owner_key_file": "/home/me/.keys/owner.nsec" }
//   { "kind": "cloud", "issuer": "https://cloud.parachute.computer", "vault_origin": "https://my.parachute.computer",
//     "ops_token_file": "...", "owner_email_file": "..." }            (an operator, moving for someone)
//   { "kind": "box", "home": "/home/me/.parachute", "cli": ["parachute-vault"] }
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boxDescription, digestFromBox, digestOverRest, type Digest } from "./digest.ts";
import { isAttachment, tar, untar, type TarFile } from "./tar.ts";

export interface HttpDoorFile {
  kind: "cloud" | "personal";
  issuer: string;
  vault_origin: string;
  /** How the owner signs in. One of these. */
  owner_key_file?: string; // a Nostr secret key (64 hex): NIP-98 on POST /account/token (0.9.1 doors)
  session_file?: string; // {"cookie": "...", "csrf": "..."}: a browser session, for a door with no owner key yet
  account_token_file?: string; // an account credential someone already holds (10 minutes on cloud: short moves only)
  /** An operator moving a vault for its owner: the door's operator token and the owner's address. */
  ops_token_file?: string;
  owner_email_file?: string;
  /** "0.8" or "0.9"; read from the door when absent. */
  release?: string;
}
export interface BoxDoorFile {
  kind: "box";
  /** The box's PARACHUTE_HOME. */
  home: string;
  /** The box's vault command, e.g. ["parachute-vault"] or ["/opt/parachute/bin/parachute-vault"]. */
  cli: string[];
  env?: Record<string, string>;
  release?: string;
}
export type DoorFile = HttpDoorFile | BoxDoorFile;

export interface Exported {
  /** Every file of the export, attached files included (`.parachute/attachments/<id>/<name>`). */
  files: TarFile[];
  /** How it left: the HTTP exit's tar as received, or the box's export folder packed. */
  how: "GET /api/export" | "parachute-vault export";
}

export interface Door {
  kind: DoorFile["kind"];
  /** A name for logs: the host, or the home's folder. Never a credential. */
  where: string;
  release(): Promise<string>;
  hasVault(name: string): Promise<boolean>;
  digest(vault: string): Promise<Digest>;
  description(vault: string): Promise<string | null>;
  export(vault: string): Promise<Exported>;
  /** Bring an export in as a NEW vault. Refuses a name that exists. Files are sent separately where the door caps a tar. */
  importNew(vault: string, exported: Exported, files: { path: string; sha256: string; bytes: Uint8Array }[], log: (line: string) => void): Promise<{ notes: number | null }>;
  /** Set the description again (the export carries it, the import doesn't apply it). False when this door can't here. */
  describe(vault: string, description: string): Promise<boolean>;
  /** Hand an operator-made vault to its owner. A no-op for an owner's own import. */
  finish(vault: string, reference: string, description?: string): Promise<void>;
  /** Remove a vault through the door's own delete. */
  remove(vault: string): Promise<void>;
  /** Who can still reach this vault, by name: connected apps and named keys. Null when the door can't say. */
  whoHolds(vault: string): Promise<{ apps: string[]; keys: { name: string; can: string }[] } | null>;
  /** Disconnect connected apps and revoke named keys for this vault. Returns what it stopped. */
  disconnect(vault: string): Promise<string[]>;
  urls(vault: string): { vault: string; mcp: string } | null;
}

const read = (file: string) => readFileSync(file, "utf8").trim();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Refuse a host by accident: Parachute Cloud itself needs `--production` said out loud. */
export function guardHost(url: string, allowProduction: boolean): void {
  const host = new URL(url).hostname;
  if (/(^|\.)parachute\.computer$/.test(host) && !allowProduction) throw new Error(`refused: ${host} is Parachute Cloud; pass --production if you mean it`);
}

async function nostrAuthorization(secretKeyHex: string, url: string, method: string): Promise<string> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = Buffer.from(secretKeyHex, "hex");
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString("hex");
  const tags = [["u", url], ["method", method], ["nonce", randomBytes(8).toString("hex")]];
  const created_at = Math.floor(Date.now() / 1000);
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, created_at, 27235, tags, ""])).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), sk)).toString("hex");
  return `Nostr ${Buffer.from(JSON.stringify({ id, pubkey, created_at, kind: 27235, tags, content: "", sig })).toString("base64")}`;
}

const expiry = (jwt: string) => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).exp * 1000;
  } catch {
    return Date.now() + 60_000;
  }
};

export function httpDoor(f: HttpDoorFile, opts: { production?: boolean; asOperator?: boolean } = {}): Door {
  const issuer = f.issuer.replace(/\/$/, "");
  const origin = f.vault_origin.replace(/\/$/, "");
  guardHost(issuer, !!opts.production);
  guardHost(origin, !!opts.production);
  const operator = !!opts.asOperator;
  if (operator && !(f.ops_token_file && f.owner_email_file)) throw new Error("an operator move needs ops_token_file and owner_email_file in the door file");
  const call = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: "manual" });
  const held = new Map<string, { token: string; until: number }>();
  const hold = async (key: string, get: () => Promise<string>, renewable = true) => {
    const h = held.get(key);
    if (h && (h.until > Date.now() || !renewable)) return h.token;
    const token = await get();
    held.set(key, { token, until: expiry(token) - 60_000 });
    return token;
  };

  const accountToken = () =>
    hold("account", async () => {
      const url = `${issuer}/account/token`;
      let r: Response;
      if (f.owner_key_file) r = await call(url, { method: "POST", headers: { authorization: await nostrAuthorization(read(f.owner_key_file), url, "POST") } });
      else if (f.session_file) {
        const s = JSON.parse(read(f.session_file)) as { cookie: string; csrf: string };
        r = await call(url, { method: "POST", headers: { "content-type": "application/json", origin: issuer, cookie: s.cookie }, body: JSON.stringify({ __csrf: s.csrf }) });
      } else if (f.account_token_file) return read(f.account_token_file);
      else throw new Error("the door file names no way to sign in (owner_key_file, session_file or account_token_file)");
      const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!r.ok || !j.token) throw new Error(`signing in at ${new URL(issuer).host} gave ${r.status} ${j.error ?? ""}`);
      return j.token;
    });
  const account = async (path: string, init: RequestInit = {}) =>
    call(`${issuer}${path}`, { ...init, headers: { authorization: `Bearer ${await accountToken()}`, ...(init.headers as Record<string, string> | undefined) } });
  const ops = (path: string, init: RequestInit = {}) =>
    call(`${issuer}${path}`, { ...init, headers: { authorization: `Bearer ${read(f.ops_token_file!)}`, ...(init.headers as Record<string, string> | undefined) } });

  const vaultToken = (vault: string, level: "read" | "admin") =>
    hold(`${vault}:${level}`, async () => {
      if (operator) {
        // An operator reads an unfinished import through its own short read token, and nothing else.
        const r = await ops("/ops/vault-import/read-token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault_name: vault }) });
        const j = (await r.json().catch(() => ({}))) as { vault_token?: string; error?: string };
        if (!r.ok || !j.vault_token) throw new Error(`the operator's read token for ${vault} gave ${r.status} ${j.error ?? ""}`);
        return j.vault_token;
      }
      const scopes = (level === "admin" ? ["read", "write", "admin"] : ["read"]).map((l) => `vault:${vault}:${l}`);
      const r = await account(`/account/vaults/${encodeURIComponent(vault)}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes }) });
      const j = (await r.json().catch(() => ({}))) as { vault_token?: string; error?: string };
      if (!r.ok || !j.vault_token) throw new Error(`a ${level} credential for ${vault} gave ${r.status} ${j.error ?? ""}`);
      return j.vault_token;
    });
  const vaultGet = (vault: string, level: "read" | "admin" = "read") => async (path: string, init: RequestInit = {}) => {
    // A vault that was just written can be reset once for memory: a 5xx, then fine.
    for (let i = 1; ; i++) {
      const r = await call(`${origin}/vault/${encodeURIComponent(vault)}${path}`, { ...init, headers: { authorization: `Bearer ${await vaultToken(vault, level)}`, ...(init.headers as Record<string, string> | undefined) } }).catch(() => null);
      if (r && (r.status < 500 || i >= 5)) return r;
      if (!r && i >= 5) throw new Error(`no answer from ${new URL(origin).host}`);
      await new Promise((ok) => setTimeout(ok, 1000 * i));
    }
  };
  const ownerEmail = () => read(f.owner_email_file!);

  const door: Door = {
    kind: f.kind,
    where: new URL(origin).host,
    async release() {
      if (f.release) return f.release;
      const r = await call(`${origin}/vault/x/api/records`);
      return r.status === 404 ? "0.8" : "0.9";
    },
    async hasVault(name) {
      if (operator) {
        const r = await ops("/ops/vault-import", { method: "POST", body: form({ email: ownerEmail(), confirm: ownerEmail(), vault_name: name, reference: "plan a move", dry_run: "true" }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (r.status === 409 && j.error === "vault_name_taken") return true;
        if (r.ok) return false;
        throw new Error(`asking the operator door about ${name} gave ${r.status} ${j.error ?? ""}`);
      }
      const r = await account("/account/vaults");
      const j = (await r.json().catch(() => null)) as any;
      if (!r.ok) throw new Error(`listing vaults gave ${r.status}`);
      return (Array.isArray(j) ? j : j.vaults).some((v: { name: string }) => v.name === name);
    },
    digest: (vault) => digestOverRest(vaultGet(vault), vault),
    async description(vault) {
      const r = await vaultGet(vault)("/api/vault");
      return r.ok ? (((await r.json()) as { description?: string | null }).description ?? null) : null;
    },
    async export(vault) {
      const r = await vaultGet(vault)("/api/export");
      if (!r.ok) throw new Error(`the export of ${vault} gave ${r.status}`);
      return { files: untar(new Uint8Array(await r.arrayBuffer())), how: "GET /api/export" };
    },
    async importNew(vault, exported, files, log) {
      // The tar that goes in holds the notes and types; each attached file follows on its own, checked by sha256.
      // The door reads a tar into memory, and one upload is capped at 50 MiB.
      const notesTar = tar(exported.files.filter((x) => !isAttachment(x.name)));
      const tarForm = () => {
        const fd = new FormData();
        fd.set("vault_name", vault);
        fd.set("tarball", new File([notesTar as unknown as BlobPart], "export.tar", { type: "application/x-tar" }));
        return fd;
      };
      let notes: number | null = null;
      if (operator) {
        const fd = tarForm();
        for (const [k, v] of Object.entries({ email: ownerEmail(), confirm: ownerEmail(), reference: `move ${vault}` })) fd.set(k, v);
        const r = await ops("/ops/vault-import", { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { error?: string; notes?: number };
        if (!r.ok) throw new Error(`the operator import gave ${r.status} ${j.error ?? ""}`);
        notes = j.notes ?? null;
      } else {
        for (let i = 1; ; i++) {
          const r = await account("/account/vaults/import", { method: "POST", body: tarForm() });
          const j = (await r.json().catch(() => ({}))) as { error?: string; notes?: number };
          if (r.status === 201) {
            notes = j.notes ?? null;
            break;
          }
          // A vault of this name was deleted here moments ago: the door keeps the name for us and says to ask again.
          if (r.status === 409 && j.error === "name_just_deleted" && i < 10) {
            log("a vault of this name was just deleted at this door; waiting for the name to come free");
            await new Promise((ok) => setTimeout(ok, 20_000));
            continue;
          }
          throw new Error(`the import gave ${r.status} ${j.error ?? ""}`);
        }
      }
      log(`imported the notes (${notes ?? "?"}); sending ${files.length} file(s)`);
      for (const x of files) {
        const fd = new FormData();
        fd.set("path", x.path);
        fd.set("sha256", x.sha256);
        fd.set("file", new File([x.bytes as unknown as BlobPart], x.path.split("/").pop() ?? "file"));
        if (operator) fd.set("vault_name", vault);
        let last = "";
        for (let i = 1; ; i++) {
          const r = operator ? await ops("/ops/vault-import/file", { method: "POST", body: fd }) : await account(`/account/vaults/${encodeURIComponent(vault)}/import-file`, { method: "POST", body: fd });
          if (r.ok) break;
          last = `${r.status} ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? ""}`;
          if (r.status < 500 || i >= 4) throw new Error(`sending a file gave ${last}`);
          await new Promise((ok) => setTimeout(ok, 1500 * i));
        }
      }
      if (!operator) {
        const c = await account(`/account/vaults/${encodeURIComponent(vault)}/import-check`);
        const j = (await c.json().catch(() => ({}))) as { missing_files?: number };
        if (!c.ok || j.missing_files !== 0) throw new Error(`after the files, the door reports ${j.missing_files ?? "?"} missing`);
      }
      return { notes };
    },
    async describe(vault, description) {
      if (operator) return false; // set by the door at the hand-over (`finish`), which reads it back itself
      const r = await vaultGet(vault, "admin")("/api/vault", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description }) });
      return r.ok;
    },
    async finish(vault, reference, description) {
      if (!operator) return;
      const r = await ops("/ops/vault-import/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ownerEmail(), confirm: ownerEmail(), vault_name: vault, reference, ...(description ? { description } : {}) }) });
      if (!r.ok) throw new Error(`handing ${vault} to its owner gave ${r.status} ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? ""}`);
    },
    async remove(vault) {
      const r = await account(`/account/vaults/${encodeURIComponent(vault)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: vault }) });
      if (!r.ok) throw new Error(`deleting ${vault} gave ${r.status} ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? ""}`);
    },
    async whoHolds(vault) {
      if (operator) return null;
      const out = { apps: [] as string[], keys: [] as { name: string; can: string }[] };
      const c = await account(`/account/vaults/${encodeURIComponent(vault)}/connections`);
      if (c.ok) {
        const j = (await c.json().catch(() => ({}))) as any;
        for (const x of j.connections ?? (Array.isArray(j) ? j : [])) out.apps.push(String(x.client_name ?? x.name ?? x.client_id ?? "an app"));
      }
      const k = await account("/account/keys");
      if (k.ok) {
        const j = (await k.json().catch(() => ({}))) as { keys?: { name: string; vault: string; can: string; status?: string }[] };
        for (const x of j.keys ?? []) if (x.vault === vault && x.status !== "revoked") out.keys.push({ name: x.name, can: x.can });
      }
      return out;
    },
    async disconnect(vault) {
      const stopped: string[] = [];
      const c = await account(`/account/vaults/${encodeURIComponent(vault)}/connections`);
      if (c.ok) {
        const j = (await c.json().catch(() => ({}))) as any;
        for (const x of j.connections ?? (Array.isArray(j) ? j : [])) {
          const r = await account(`/account/vaults/${encodeURIComponent(vault)}/connections/${encodeURIComponent(x.client_id)}`, { method: "DELETE" });
          if (r.ok) stopped.push(`app ${x.client_name ?? x.client_id}`);
        }
      }
      const k = await account("/account/keys");
      if (k.ok) {
        const j = (await k.json().catch(() => ({}))) as { keys?: { name: string; vault: string; status?: string }[] };
        for (const x of j.keys ?? []) {
          if (x.vault !== vault || x.status === "revoked") continue;
          const r = await account(`/account/keys/${encodeURIComponent(x.name)}`, { method: "DELETE" });
          if (r.ok) stopped.push(`key ${x.name}`);
        }
      }
      return stopped;
    },
    urls: (vault) => ({ vault: `${origin}/vault/${vault}`, mcp: `${origin}/vault/${vault}/mcp` }),
  };
  return door;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const LIVE_HOME = () => join(process.env.HOME ?? "/nonexistent", ".parachute");

export function boxDoor(f: BoxDoorFile, opts: { scratch: string; liveBox?: boolean }): Door {
  if (!f.home || !existsSync(dirname(f.home))) throw new Error(`the box home's folder doesn't exist: ${f.home}`);
  // A move writes a new vault into the home and removes one on close. The machine's own everyday box is touched
  // only when asked for by name.
  if (f.home === LIVE_HOME() && !opts.liveBox) throw new Error("refused: that home is this machine's own Parachute; pass --live-box if you mean it");
  const run = (args: string[]) => {
    const p = Bun.spawnSync([...f.cli, ...args], { env: { ...process.env, ...f.env, PARACHUTE_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const vaultDir = (name: string) => join(f.home, "vault", "data", name);
  const walk = (dir: string, rel = ""): TarFile[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${rel}${n}/`) : [{ name: `${rel}${n}`, bytes: new Uint8Array(readFileSync(join(dir, n))) }]));
  return {
    kind: "box",
    where: `box at ${f.home}`,
    async release() {
      if (f.release) return f.release;
      return /\b0\.9\./.test(run(["--version"]).out) ? "0.9" : "0.8";
    },
    hasVault: async (name) => existsSync(vaultDir(name)),
    digest: (vault) => digestFromBox(join(vaultDir(vault), "vault.db"), join(vaultDir(vault), "assets"), vault),
    description: async (vault) => boxDescription(join(vaultDir(vault), "vault.yaml")),
    async export(vault) {
      const dir = join(opts.scratch, `box-export-${randomBytes(4).toString("hex")}`);
      const r = run(["export", dir, "--vault", vault]);
      if (r.code !== 0) throw new Error(`the box's export failed (${r.code}): ${r.err.slice(-400)}`);
      const files = walk(dir);
      rmSync(dir, { recursive: true, force: true });
      return { files, how: "parachute-vault export" };
    },
    async importNew(vault, exported, _files, log) {
      if (existsSync(vaultDir(vault))) throw new Error(`the box already has a vault named ${vault}`);
      const dir = join(opts.scratch, `box-import-${randomBytes(4).toString("hex")}`);
      for (const x of exported.files) {
        const to = join(dir, x.name);
        if (!to.startsWith(`${dir}/`)) throw new Error(`the export names a file outside itself: ${x.name}`);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, x.bytes);
      }
      const made = run(["create", vault, "--no-mirror", "--json"]);
      if (made.code !== 0) throw new Error(`making the vault on the box failed (${made.code}): ${made.err.slice(-400)}`);
      log("made the vault on the box; importing");
      // The box's importer needs the database to itself: with the box serving it refuses and says to stop it first.
      const r = run(["import", dir, "--vault", vault, "--blow-away", "--yes"]);
      rmSync(dir, { recursive: true, force: true });
      if (r.code !== 0) {
        const serving = /daemon is running/.test(r.err);
        // Nothing was imported: take the empty vault away again so the name is free for the next try.
        rmSync(vaultDir(vault), { recursive: true, force: true });
        throw new Error(serving ? "the box is serving: stop it for the import (`parachute stop`), run the move again, then start it" : `the box's import failed (${r.code}): ${r.err.slice(-400)}`);
      }
      return { notes: null };
    },
    async describe(vault, description) {
      // A box takes a description over its REST, which needs it serving; the import needs it stopped. So the
      // description goes where the box itself keeps it: `vault.yaml`, as the block the box writes, right after the
      // name. Only into a vault this move just made (it has no description yet); anything else is left alone.
      const y = join(vaultDir(vault), "vault.yaml");
      if (!existsSync(y)) return false;
      const lines = readFileSync(y, "utf8").split("\n");
      const name = lines.findIndex((l) => /^name:/.test(l));
      if (name < 0 || lines.some((l) => /^description:/.test(l))) return false;
      lines.splice(name + 1, 0, "description: |", ...description.replace(/\n+$/, "").split("\n").map((l) => `  ${l}`));
      writeFileSync(y, lines.join("\n"));
      return boxDescription(y) === description.replace(/\n+$/, "");
    },
    finish: async () => {},
    async remove(vault) {
      const r = run(["remove", vault, "--yes"]);
      if (r.code !== 0) throw new Error(`removing ${vault} from the box failed (${r.code}): ${r.err.slice(-300)}`);
    },
    whoHolds: async () => null,
    disconnect: async () => [],
    urls: () => null,
  };
}

export function openDoor(file: string, opts: { scratch: string; production?: boolean; asOperator?: boolean; liveBox?: boolean }): Door {
  const f = JSON.parse(readFileSync(file, "utf8")) as DoorFile;
  if (f.kind === "box") return boxDoor(f, opts);
  if (f.kind === "cloud" || f.kind === "personal") return httpDoor(f, opts);
  throw new Error(`${file}: kind must be "box", "cloud" or "personal"`);
}

/** Match each attached file the source lists to its bytes in the export, by name and sha256. */
export function filesFromExport(exported: Exported, source: Digest): { path: string; sha256: string; bytes: Uint8Array }[] {
  const byName = new Map<string, TarFile[]>();
  for (const x of exported.files.filter((e) => isAttachment(e.name))) {
    const base = x.name.split("/").pop()!;
    (byName.get(base) ?? byName.set(base, []).get(base)!).push(x);
  }
  const out = new Map<string, { path: string; sha256: string; bytes: Uint8Array }>();
  for (const want of source.files) {
    const hit = (byName.get(want.path.split("/").pop()!) ?? []).find((c) => sha256(c.bytes) === want.sha256);
    if (!hit) throw new Error(`the export doesn't hold the file ${want.path} with the bytes the source has (sha256 ${want.sha256.slice(0, 12)}…)`);
    out.set(want.path, { path: want.path, sha256: want.sha256, bytes: hit.bytes });
  }
  return [...out.values()];
}
