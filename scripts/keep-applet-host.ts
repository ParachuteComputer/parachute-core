// Keep a build of @openparachute/applet-host (the MCP App view, built in the app repo: ParachuteComputer/parachute
// packages/applet-host) as the one the vault serves: packages/vault/src/applet-host/applet-host.html.gz and
// applet-host.json (which version, from which commit, and the HTML's sha256, checked before it is served).
//   bun scripts/keep-applet-host.ts <dist/applet-host.html> <version> <app commit>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const [file, version, commit] = process.argv.slice(2);
if (!file || !version || !commit) {
  console.error("usage: bun scripts/keep-applet-host.ts <dist/applet-host.html> <version> <app commit>");
  process.exit(2);
}
const html = readFileSync(file, "utf8");
if (!/<script type="module">/.test(html) || /<script[^>]*\ssrc=/.test(html)) throw new Error(`${file} isn't one self-contained page`);
const dir = join(import.meta.dir, "..", "packages", "vault", "src", "applet-host");
const gz = gzipSync(Buffer.from(html, "utf8"), { level: 9 });
writeFileSync(join(dir, "applet-host.html.gz"), gz);
const meta = { package: "@openparachute/applet-host", version, source: `ParachuteComputer/parachute@${commit}`, bytes: Buffer.byteLength(html), sha256: createHash("sha256").update(html, "utf8").digest("hex") };
writeFileSync(join(dir, "applet-host.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`kept ${meta.package}@${version} (${meta.bytes} bytes, ${gz.length} gzipped, sha256 ${meta.sha256.slice(0, 12)})`);
