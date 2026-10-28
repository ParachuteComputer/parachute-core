// `parachute install [--prefix <dir>]` (also `parachute-core install`): install this unpacked bundle for the user
// (PLAN §2.5, lane D; the name `parachute`, Aaron 10-27).
//
//   <prefix>/.store/<version>-<id>/   a complete copy of the bundle (bin/, runtime/, lib/, …), bytes unchanged,
//                                     signatures kept; written whole before anything points at it
//   <prefix>/<version>                a link to that copy, switched in one rename
//   <prefix>/bin/parachute            links to <version>/bin/parachute and <version>/bin/parachute-core: the only
//   <prefix>/bin/parachute-core       things it puts in a bin folder
//
// The default prefix is $XDG_DATA_HOME/parachute-core (~/.local/share/parachute-core). It never touches the old
// global install (~/.bun/install/global, ~/.bun/bin/parachute{,-vault}, npm's prefix), never links `parachute-vault`
// (that name stays inside the bundle), never edits PATH or a shell's startup files, and never runs a package manager.
// Where an older `parachute` (0.7's hub) comes first on PATH, it is left as it is and the output says so: until the
// home moves over (`parachute-core takeover`, lane E), this program answers to `parachute-core`.
// Running it again copies again and switches <version> to the new copy, so an interrupted install leaves the previous
// one working. The previous copy is kept, not deleted: a `parachute serve` started from it may still be running, and
// its vault child is found through that copy's bin/. It says where the kept copies are. Other versions are left
// alone. A copy left half-done by an interrupted install (`.store/*.tmp`) is removed by the next install.
//
// It installs a bundle, not a source checkout: from the repository, build one with `bun run candidate`.
import { accessSync, constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/** The names install links into <prefix>/bin: the command and its alias. Never `parachute-vault`. */
export const LINKED = ["parachute", "parachute-core"];

function usage(): string {
  return [
    "usage: parachute install [--prefix <dir>]",
    "  copies this bundle to <prefix>/<version>/ and links <prefix>/bin/parachute and parachute-core",
    "  (default prefix: ~/.local/share/parachute-core)",
    "  `parachute install <module>` is the hub's module installer, as in 0.7",
  ].join("\n");
}

/**
 * A link this installer made in <prefix>/bin: `../<version>/bin/<its own name>`, where <prefix>/<version> is a link
 * into <prefix>/.store/ holding a bundle of this program. Anything else is another program's.
 */
function ourLink(at: string, base: string): boolean {
  if (!lstatSync(at).isSymbolicLink()) return false;
  const parts = readlinkSync(at).split("/");
  if (!(parts.length === 4 && parts[0] === ".." && /^\d/.test(parts[1]!) && parts[2] === "bin" && parts[3] === basename(at))) return false;
  const version = join(base, parts[1]!);
  if (!lstatSync(version, { throwIfNoEntry: false })?.isSymbolicLink() || !existsSync(version)) return false;
  const copy = realpathSync(version);
  const store = join(realpathSync(base), ".store");
  return dirname(copy) === store && ["VERSION", "runtime/bun", "lib/packages/cli/bin/parachute"].every((f) => existsSync(join(copy, f)));
}

/**
 * The first `parachute` on PATH, if it is not the one just linked at `ours`: an older Parachute (0.7's hub, linked by
 * `bun add -g` or `npm i -g`) or anything else by that name. It is never changed here.
 */
export function otherParachuteFirst(ours: string, path = process.env.PATH ?? ""): { at: string; hub: boolean; core: boolean } | null {
  // The wrapper that started this program put its own folder first on PATH (bin/parachute); the user's PATH is the rest.
  const wrappers = realpathSync(resolve(import.meta.dir, "..", "bin"));
  for (const entry of path.split(":")) {
    // As the shell looks: an empty entry is the current folder, and only an executable file counts.
    const d = entry || process.cwd();
    if (!existsSync(d) || realpathSync(d) === wrappers) continue;
    const at = join(resolve(d), "parachute");
    if (!existsSync(at) || !statSync(at).isFile()) continue;
    try {
      accessSync(at, fsConstants.X_OK);
    } catch {
      continue;
    }
    const real = realpathSync(at);
    if (real === realpathSync(ours)) return null;
    return { at, hub: real.includes("/@openparachute/hub/"), core: real.endsWith("/packages/cli/bin/parachute") };
  }
  return null;
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
      // Under `parachute`, `install <module>` is the hub's (primary.ts); this name installs only this program.
      console.error(`parachute-core install: installs this program and takes no module name ("${a}"); modules are installed with \`parachute install <module>\`\n${usage()}`);
      return 2;
    } else {
      console.error(`parachute install: unexpected argument "${a}"\n${usage()}`);
      return 2;
    }
  }
  if (prefix !== undefined && !prefix.trim()) {
    console.error(`parachute install: --prefix is empty\n${usage()}`);
    return 2;
  }
  const root = bundleRoot();
  if (!root) {
    console.error("parachute install: this is not an unpacked bundle (no runtime/bun next to lib/). Installed with npm or bun, it is installed already; from the repository, build a bundle with `bun run candidate`");
    return 2;
  }
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const base = resolve(prefix ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "parachute-core"));
  const dest = join(base, version);
  const bin = join(base, "bin");
  // <prefix>/bin must be this prefix's own folder: a link to another bin folder (~/.bun/bin, npm's) would put our
  // links in there, over the old `parachute`.
  if (lstatSync(bin, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.error(`parachute install: ${bin} is a link to another folder; nothing was changed. Choose another --prefix`);
    return 2;
  }
  mkdirSync(bin, { recursive: true });
  if (realpathSync(bin) !== join(realpathSync(base), "bin")) {
    console.error(`parachute install: ${bin} is not inside ${base}; nothing was changed. Choose another --prefix`);
    return 2;
  }
  // Only links this installer made are replaced: anything else by those names (an old `parachute` in a prefix such as
  // ~/.bun or /usr/local) stays, and the install stops before it copies anything.
  const foreign = LINKED.map((n) => join(bin, n)).filter((at) => lstatSync(at, { throwIfNoEntry: false }) && !ourLink(at, base));
  if (foreign.length) {
    console.error(`parachute install: ${foreign.join(", ")} ${foreign.length > 1 ? "are" : "is"} not this installer's; left as ${foreign.length > 1 ? "they are" : "it is"}, and nothing was changed. Choose another --prefix`);
    return 2;
  }

  // One install at a time per prefix (an OS lock on .store/.lock). With it held, any half-done copy (.tmp) is from
  // an interrupted install and safe to remove.
  const store = join(base, ".store");
  // The store too is this prefix's own folder: the install copies into it and clears half-done copies from it.
  if (lstatSync(store, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.error(`parachute install: ${store} is a link to another folder; nothing was changed. Choose another --prefix`);
    return 2;
  }
  mkdirSync(store, { recursive: true });
  if (realpathSync(store) !== join(realpathSync(base), ".store")) {
    console.error(`parachute install: ${store} is not inside ${base}; nothing was changed. Choose another --prefix`);
    return 2;
  }
  const lock = join(store, ".lock");
  if (!takeLock(lock)) {
    console.error(`parachute install: another install into ${base} is running; try again when it ends`);
    return 1;
  }
  // The lock goes when this process exits; the empty .lock file stays, since a flock lives on a file that stays put.
  const r = copyAndSwitch(root, base, store, version);
  if ("error" in r) {
    console.error(`parachute install: ${r.error}`);
    return 2;
  }
  const previous = r.previous;
  console.log(`parachute ${version} installed in ${dest}`);
  // <prefix>/bin/<name> → ../<version>/bin/<name>, each switched in one rename too.
  for (const name of LINKED) {
    const target = relative(bin, join(dest, "bin", name));
    const tmpLink = join(bin, `.${name}.${randomBytes(4).toString("hex")}`);
    symlinkSync(target, tmpLink);
    renameSync(tmpLink, join(bin, name));
    console.log(`linked ${join(bin, name)} → ${target}`);
  }
  const onPath = (process.env.PATH ?? "").split(":").some((d) => d && resolve(d) === bin);
  const other = otherParachuteFirst(join(bin, "parachute"));
  if (other) {
    const what = other.hub ? "an older Parachute (0.7's hub, @openparachute/hub)" : other.core ? "another copy of Parachute v0.8" : "another program";
    console.log(`\`parachute\` on your PATH is ${what}: ${other.at}. It is left as it is.`);
    if (!other.core) console.log(`Until you move over, run this version as \`parachute-core\`${onPath ? "" : ` (${join(bin, "parachute-core")})`}.`);
    // Takeover is lane E's (takeover.ts); until a build has it, the line would name a command that isn't there.
    if (other.hub && existsSync(join(import.meta.dir, "takeover.ts"))) console.log("`parachute-core takeover` moves a home the old hub and vault keep onto this version.");
    if (!onPath) console.log(`add ${bin} to your PATH (before ${dirname(other.at)}, once you have moved over, to make it \`parachute\`)`);
  } else if (!onPath) {
    console.log(`add ${bin} to your PATH to run parachute by name`);
  }
  if (previous) console.log(`the previous copy is kept at ${previous}; remove it once nothing runs from it`);
  return 0;
}
