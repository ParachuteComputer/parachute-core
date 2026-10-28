// Ad hoc signing of a bundle tree on macOS, the way Prism ships it (PLAN §3 "Signing"): every Mach-O file is
// re-signed with the hardened runtime, and only runtime/bun gets entitlements (entitlements/bun.plist: allow-jit).
// Prism re-signs the same files with its Developer ID (prism release/sign-bundle.sh), so a tree that runs signed
// this way is the one to test. An ad hoc signature has no identity; it proves the bytes run under the hardened
// runtime, not who made them.
import { lstatSync, openSync, readdirSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A Mach-O file codesign can sign: an executable, a dylib or a bundle (a Node addon), thin or fat. Not an object
 * file (.o) or other Mach-O types, and not a Java class file, which shares the fat magic 0xcafebabe (there the next
 * word is a class-file version, 45 or more; in a fat Mach-O it is the number of architectures).
 */
export function isSignableMachO(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(16);
    if (readSync(fd, b, 0, 16, 0) < 16) return false;
    const be = b.readUInt32BE(0);
    if (be === 0xcafebabe || be === 0xbebafeca) {
      const n = be === 0xcafebabe ? b.readUInt32BE(4) : b.readUInt32LE(4);
      return n > 0 && n < 20;
    }
    const le = b.readUInt32LE(0);
    const thin = le === 0xfeedface || le === 0xfeedfacf ? "le" : be === 0xfeedface || be === 0xfeedfacf ? "be" : null;
    if (!thin) return false;
    const filetype = thin === "le" ? b.readUInt32LE(12) : b.readUInt32BE(12);
    return [0x2, 0x6, 0x8].includes(filetype); // MH_EXECUTE, MH_DYLIB, MH_BUNDLE
  } finally {
    closeSync(fd);
  }
}

/** Every signable Mach-O file in the tree (relative paths, sorted), never following links. */
export function machOFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const at = join(dir, n);
      const st = lstatSync(at);
      if (st.isDirectory()) walk(at);
      else if (st.isFile() && st.size >= 16 && isSignableMachO(at)) out.push(relative(root, at));
    }
  };
  walk(root);
  return out.sort();
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${(out + err).slice(-800)}`);
  return out + err;
}

/** Sign every Mach-O in `root` ad hoc with the hardened runtime; runtime/bun with entitlements/bun.plist. */
export async function signTree(root: string): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("signing needs macOS (codesign)");
  const files = machOFiles(root);
  if (!files.includes("runtime/bun")) throw new Error(`${root}: no Mach-O runtime/bun to sign`);
  for (const f of files) {
    const ent = f === "runtime/bun" ? ["--entitlements", join(root, "entitlements", "bun.plist")] : [];
    await run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--timestamp=none", ...ent, join(root, f)]);
    await run(["codesign", "--verify", "--strict", join(root, f)]);
  }
  return files;
}
