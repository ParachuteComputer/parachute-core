// `parachute-core install [--prefix <dir>]`: install this unpacked bundle for the user (PLAN §2.5, lane D).
//
//   <prefix>/.store/<version>-<id>/   a complete copy of the bundle (bin/, runtime/, lib/, …), bytes unchanged,
//                                     signatures kept; written whole before anything points at it
//   <prefix>/<version>                a link to that copy, switched in one rename
//   <prefix>/bin/parachute-core       a link to <version>/bin/parachute-core: the only thing it puts in a bin folder
//
// The default prefix is $XDG_DATA_HOME/parachute-core (~/.local/share/parachute-core). It never touches the old
// global install (~/.bun/install/global, ~/.bun/bin/parachute{,-vault}, npm's prefix), never links `parachute` or
// `parachute-vault` anywhere (those names stay inside the bundle), and never runs a package manager. Running it again
// copies again and switches <version> to the new copy, so an interrupted install leaves the previous one working.
// The previous copy is kept, not deleted: a `parachute-core serve` started from it may still be running, and its
// vault child is found through that copy's bin/. It says where the kept copies are. Other versions are left alone.
// A copy left half-done by an interrupted install (`.store/*.tmp`) is removed by the next install.
//
// It installs a bundle, not a source checkout: from the repository, build one with `bun run candidate`.
import { cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/** The bundle this program runs from: lib/packages/cli/src → the folder holding bin/, runtime/ and lib/. */
export function bundleRoot(): string | null {
  const root = resolve(import.meta.dir, "..", "..", "..", "..");
  const is = ["bin/parachute-core", "runtime/bun", "lib/package.json", "VERSION", "package.json"].every((f) => existsSync(join(root, f)));
  return is ? realpathSync(root) : null;
}

/**
 * Hold an exclusive flock(2) on `path` for the rest of this process, or return false if another process holds it.
 * The kernel drops the lock when its holder exits, however it exits, so there is never a stale lock to recover.
 */
function takeLock(path: string): boolean {
  const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const fd = openSync(path, "a"); // kept open: closing it would drop the lock
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  return lib.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}

/**
 * Copy the bundle into the store and switch <base>/<version> to the copy with one rename of a link. Installing the
 * bundle onto itself (the installed copy's own install) copies nothing. Runs under the prefix lock.
 */
function copyAndSwitch(root: string, base: string, store: string, version: string): { previous: string | null } | { error: string } {
  const dest = join(base, version);
  if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) return { error: `${dest} is not a link this installer made; move it away first` };
  const current = existsSync(dest) ? realpathSync(dest) : null;
  if (current === root) return { previous: null };
  for (const n of readdirSync(store)) if (/^\d[^/]*-[0-9a-f]{8}\.tmp$/.test(n)) rmSync(join(store, n), { recursive: true, force: true });
  const gen = join(store, `${version}-${randomBytes(4).toString("hex")}`);
  const tmp = `${gen}.tmp`;
  cpSync(root, tmp, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
  renameSync(tmp, gen);
  const tmpLink = join(base, `.${version}.${randomBytes(4).toString("hex")}.link`);
  symlinkSync(relative(base, gen), tmpLink);
  renameSync(tmpLink, dest);
  return { previous: current };
}

function usage(): string {
  return "usage: parachute-core install [--prefix <dir>]\n  copies this bundle to <prefix>/<version>/ and links <prefix>/bin/parachute-core (default prefix: ~/.local/share/parachute-core)";
}

/** Run the install; returns the exit code. */
export function install(argv: string[]): number {
  let prefix: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--prefix" && argv[i + 1]) prefix = argv[++i];
    else if (a.startsWith("--prefix=")) prefix = a.slice("--prefix=".length);
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      return 0;
    } else if (!a.startsWith("-")) {
      // The hub's `install <module>` is not part of parachute-core; the hub still runs it by its old name.
      console.error(`parachute-core install: installs this program and takes no module name ("${a}"); modules are installed with \`parachute install <module>\`\n${usage()}`);
      return 2;
    } else {
      console.error(`parachute-core install: unexpected argument "${a}"\n${usage()}`);
      return 2;
    }
  }
  if (prefix !== undefined && !prefix.trim()) {
    console.error(`parachute-core install: --prefix is empty\n${usage()}`);
    return 2;
  }
  const root = bundleRoot();
  if (!root) {
    console.error("parachute-core install: this is not an unpacked bundle (no runtime/bun next to lib/); build one with `bun run candidate`");
    return 2;
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const base = resolve(prefix ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "parachute-core"));
  const dest = join(base, version);
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });

  // One install at a time per prefix (an OS lock on .store/.lock). With it held, any half-done copy (.tmp) is from
  // an interrupted install and safe to remove.
  const store = join(base, ".store");
  mkdirSync(store, { recursive: true });
  const lock = join(store, ".lock");
  if (!takeLock(lock)) {
    console.error(`parachute-core install: another install into ${base} is running; try again when it ends`);
    return 1;
  }
  // The lock goes when this process exits; the empty .lock file stays, since a flock lives on a file that stays put.
  const r = copyAndSwitch(root, base, store, version);
  if ("error" in r) {
    console.error(`parachute-core install: ${r.error}`);
    return 2;
  }
  const previous = r.previous;
  // <prefix>/bin/parachute-core → ../<version>/bin/parachute-core, switched in one rename too.
  const target = relative(bin, join(dest, "bin", "parachute-core"));
  const tmpLink = join(bin, `.parachute-core.${randomBytes(4).toString("hex")}`);
  symlinkSync(target, tmpLink);
  renameSync(tmpLink, join(bin, "parachute-core"));

  console.log(`parachute-core ${version} installed in ${dest}`);
  console.log(`linked ${join(bin, "parachute-core")} → ${target}`);
  const onPath = (process.env.PATH ?? "").split(":").some((d) => d && resolve(d) === bin);
  if (!onPath) console.log(`add ${bin} to your PATH to run parachute-core by name`);
  if (previous) console.log(`the previous copy is kept at ${previous}; remove it once nothing runs from it`);
  return 0;
}
