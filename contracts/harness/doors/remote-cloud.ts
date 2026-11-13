// A door file for a deployed cloud-style door that signs people up with a dev link (a staging Parachute Cloud):
//
//   DOOR_REMOTE_HOSTS=<issuer host>,<vault host> bun harness/doors/remote-cloud.ts \
//     --issuer <origin> --vault-origin <origin> --release 0.9.1 --out <dir>
//
// It signs up one made-up account (`door-contracts+<random>@example.com`, through the dev link the door echoes on a
// staging deploy), links a made-up owner key to it (0.9.1), and writes <dir>/door.json for `bun run doors -- --remote`
// with the session in <dir>/session.json and the key in <dir>/owner.key (all mode 600; never printed). A
// `parachute.computer` host is refused: the contracts make and delete vaults.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowOrigins, safeFetch } from "../guard.ts";
import { linkOwnerKeyOnCloud, makeOwnerKey, signUp } from "./workers.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const issuer = (arg("--issuer") ?? "").replace(/\/$/, "");
const vaultOrigin = (arg("--vault-origin") ?? "").replace(/\/$/, "");
const release = arg("--release") ?? "0.9.1";
const out = resolve(arg("--out") ?? "");
if (!issuer || !vaultOrigin || !arg("--out")) throw new Error("usage: --issuer <origin> --vault-origin <origin> [--release 0.9.1] --out <dir>");
const named = (process.env.DOOR_REMOTE_HOSTS ?? "").split(",").map((h) => h.trim());
for (const url of [issuer, vaultOrigin]) {
  const host = new URL(url).hostname;
  if (/(^|\.)parachute\.computer$/.test(host)) throw new Error(`refused: ${host} is Parachute Cloud`);
  if (!named.includes(host)) throw new Error(`refused: name ${host} in DOOR_REMOTE_HOSTS`);
}
allowOrigins(issuer, vaultOrigin);

const me = await signUp(issuer);
const tok = await safeFetch(`${issuer}/account/token`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: issuer, cookie: me.cookie },
  body: JSON.stringify({ __csrf: me.csrf }),
});
const bearer = ((await tok.json().catch(() => ({}))) as { token?: string }).token;
if (!tok.ok || !bearer) throw new Error(`POST /account/token gave ${tok.status}`);
const owner = await makeOwnerKey();
if (release.startsWith("0.9")) await linkOwnerKeyOnCloud(issuer, bearer, owner.secretKey);

mkdirSync(out, { recursive: true, mode: 0o700 });
// `mode` applies only to a new file: chmod too, so a reused folder's older, wider file is narrowed.
const secret = (name: string, text: string) => {
  writeFileSync(join(out, name), text, { mode: 0o600 });
  chmodSync(join(out, name), 0o600);
};
secret("session.json", JSON.stringify({ cookie: me.cookie, csrf: me.csrf }));
secret("owner.key", `${owner.secretKey}\n`);
const door = {
  kind: "cloud",
  label: `cloud-${release}`,
  release,
  issuer,
  vaultOrigin,
  signIn: { how: "cookie", cookieFile: join(out, "session.json") },
  ...(release.startsWith("0.9") ? { ownerKeyFile: join(out, "owner.key") } : {}),
};
secret("door.json", `${JSON.stringify(door, null, 2)}\n`);
console.log(`door file: ${join(out, "door.json")} (account ${me.email.replace(/\+.*@/, "+…@")}, ${release})`);
