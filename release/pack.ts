// Pack a bundle tree as <name>.tar.gz, with one top folder <name>/, and write SHA256SUMS next to it (one line per
// tarball in that folder, as `sha256sum -c` reads it). Links are kept as links; the tree has none that leave it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(path).bytes());
  return h.digest("hex");
}

/** The tarball's name for a version and platform: parachute-core-<version>-<platform>. */
export function bundleName(version: string, platform: string): string {
  return `parachute-core-${version}-${platform}`;
}

export async function packTree(tree: string, name: string, outDir: string): Promise<{ tarball: string; sha256: string; sums: string }> {
  const src = resolve(tree);
  const tarball = join(resolve(outDir), `${name}.tar.gz`);
  // The top folder is <name>/ whatever the tree's own folder is called: tar's -s (bsdtar) / --transform (GNU). The
  // S flag keeps symlink targets as they are (both tars would rewrite a relative "../x" target too).
  const gnu = (await new Response(Bun.spawn(["tar", "--version"], { stdout: "pipe" }).stdout).text()).includes("GNU");
  const rename = gnu ? [`--transform=s,^\\.,${name},S`] : ["-s", `,^\\.,${name},S`];
  const owner = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0"];
  const p = Bun.spawn(["tar", "-czf", tarball, ...owner, ...rename, "-C", src, "."], { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`tar of ${src} failed (${code}): ${err.slice(-600)}`);
  const sum = await sha256(tarball);
  const sums = join(dirname(tarball), "SHA256SUMS");
  const lines = new Map<string, string>();
  if (existsSync(sums)) {
    for (const l of readFileSync(sums, "utf8").split("\n")) {
      const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/);
      if (m && existsSync(join(dirname(sums), m[2]!))) lines.set(m[2]!, m[1]!);
    }
  }
  lines.set(basename(tarball), sum);
  const names = readdirSync(dirname(sums)).filter((n) => lines.has(n)).sort();
  writeFileSync(sums, names.map((n) => `${lines.get(n)}  ${n}\n`).join(""));
  return { tarball, sha256: sum, sums };
}
