// Which `parachute` the shell would run first (install.ts otherParachuteFirst): the install's notice about an older
// Parachute must name the program a person's shell actually runs.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { otherParachuteFirst } from "./install.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): { root: string; bin: (name: string, opts?: { mode?: number; dir?: boolean; hub?: boolean }) => string } {
  const root = mkdtempSync(join(tmpdir(), "install-path-"));
  dirs.push(root);
  return {
    root,
    bin(name, opts = {}) {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      if (opts.dir) mkdirSync(join(d, "parachute"));
      else if (opts.hub) {
        const real = join(root, "g", "node_modules", "@openparachute", "hub", "src");
        mkdirSync(real, { recursive: true });
        writeFileSync(join(real, "cli.ts"), "#!/bin/sh\n", { mode: 0o755 });
        symlinkSync(join(real, "cli.ts"), join(d, "parachute"));
      } else writeFileSync(join(d, "parachute"), "#!/bin/sh\n", { mode: opts.mode ?? 0o755 });
      return d;
    },
  };
}

test("the first executable `parachute` on PATH is named, and an old hub is recognised", () => {
  const s = scratch();
  const ours = join(s.bin("ours"), "parachute");
  const old = s.bin("old", { hub: true });
  expect(otherParachuteFirst(ours, `${old}:${join(s.root, "ours")}`)).toEqual({ at: join(old, "parachute"), hub: true, core: false });
  expect(otherParachuteFirst(ours, `${join(s.root, "ours")}:${old}`)).toBeNull();
});

test("a folder or a non-executable file named parachute is passed over, as the shell does", () => {
  const s = scratch();
  const ours = join(s.bin("ours"), "parachute");
  const dir = s.bin("dir", { dir: true });
  const plain = s.bin("plain", { mode: 0o644 });
  const old = s.bin("old", { hub: true });
  expect(otherParachuteFirst(ours, `${dir}:${plain}:${old}`)?.at).toBe(join(old, "parachute"));
});

test("an empty PATH entry is the current folder", () => {
  const s = scratch();
  const ours = join(s.bin("ours"), "parachute");
  const here = s.bin("here");
  chmodSync(join(here, "parachute"), 0o755);
  const cwd = process.cwd();
  process.chdir(here);
  try {
    expect(otherParachuteFirst(ours, `:${join(s.root, "ours")}`)?.at).toBe(join(here, "parachute"));
  } finally {
    process.chdir(cwd);
  }
});
