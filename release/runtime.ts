// The bundle's runtime/bun: the exact Bun in bun.json. The zip is downloaded once per machine and checked against
// the sha256 pinned there every time it is unpacked. A zip that doesn't match is refused, never used.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pin from "./bun.json";

export const BUN_VERSION: string = pin.version;

/** `process.platform-process.arch` as the bundle names it: darwin-arm64, linux-x64, … */
export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

const CACHE = resolve(process.env.PCORE_BUN_CACHE ?? join(import.meta.dir, "..", "contracts", ".cache", "bun"));

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(path).bytes());
  return h.digest("hex");
}

async function sh(cmd: string[], cwd?: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err.slice(-600)}`);
}

/**
 * Write the pinned Bun for `platform` to `dest`, extracted afresh from a zip whose sha256 was just checked: only the
 * zip is cached, never an unpacked `bun`, so a changed file in the cache can't reach a bundle.
 */
export async function installPinnedBun(dest: string, platform = hostPlatform()): Promise<{ version: string; zip: string; sha256: string }> {
  const asset = (pin.assets as Record<string, { zip: string; sha256: string }>)[platform];
  if (!asset) throw new Error(`release/bun.json pins no Bun for ${platform} (has ${Object.keys(pin.assets).join(", ")})`);
  const dir = join(CACHE, pin.version, platform);
  const zip = join(dir, asset.zip);
  if (!existsSync(zip) || (await sha256(zip)) !== asset.sha256) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch(`${pin.url}${asset.zip}`);
    if (!res.ok) throw new Error(`download ${pin.url}${asset.zip}: HTTP ${res.status}`);
    const tmp = `${zip}.${process.pid}.${Date.now()}.part`; // two builds sharing the cache never share a temp file
    await Bun.write(tmp, await res.arrayBuffer());
    const got = await sha256(tmp);
    if (got !== asset.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${asset.zip}: sha256 ${got}, but release/bun.json pins ${asset.sha256}`);
    }
    renameSync(tmp, zip);
  }
  // Checked again right before it is unpacked: the hash above may be from a download a moment ago, or not.
  const got = await sha256(zip);
  if (got !== asset.sha256) throw new Error(`${zip}: sha256 ${got}, but release/bun.json pins ${asset.sha256}`);
  const out = mkdtempSync(join(dir, "x-"));
  try {
    await sh(["unzip", "-q", zip, "-d", out]);
    copyFileSync(join(out, asset.zip.replace(/\.zip$/, ""), "bun"), dest);
    chmodSync(dest, 0o755);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return { version: pin.version, zip: asset.zip, sha256: asset.sha256 };
}
