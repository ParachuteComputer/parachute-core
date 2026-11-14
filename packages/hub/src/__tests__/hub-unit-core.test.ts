// Inside @openparachute/core, a `parachute-hub.service` that starts the 0.7 hub is the takeover's paused leftover
// (stopped, disabled, its file kept). No verb may take it for the hub's own unit: starting it would put the old hub
// on a home core serves. A hub unit that starts core (what `init` writes inside core) is the hub's own, as before;
// and outside core nothing changes.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CORE_ROOT_ENV, unitStartsCore } from "../core-host.ts";
import { type HubUnitDeps, defaultHubUnitDeps, isHubUnitInstalled } from "../hub-unit.ts";

const dirs: string[] = [];
const was = process.env[CORE_ROOT_ENV];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (was === undefined) delete process.env[CORE_ROOT_ENV];
  else process.env[CORE_ROOT_ENV] = was;
});

/** A user's home with a hub unit file whose ExecStart is `exec`, and deps that read it. */
function box(exec: string): { deps: HubUnitDeps; home: string } {
  const home = mkdtempSync(join(tmpdir(), "hub-unit-core-"));
  dirs.push(home);
  const unit = join(home, ".config", "systemd", "user", "parachute-hub.service");
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, `[Unit]\nDescription=made up\n\n[Service]\nExecStart=${exec}\nRestart=on-failure\n`);
  return { home, deps: { ...defaultHubUnitDeps, platform: "linux", getuid: () => 1000, homeDir: () => home, exists: existsSync } };
}

/** Run as part of core: a made-up core root with core's entry, as core-host.ts coreRoot() checks. */
function insideCore(home: string): string {
  const root = join(home, "core");
  mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "src", "parachute-core.ts"), "");
  process.env[CORE_ROOT_ENV] = root;
  return root;
}

const OLD_HUB = "/home/op/.bun/bin/bun /home/op/.bun/install/global/node_modules/@openparachute/hub/src/cli.ts serve";

describe("the hub's unit, inside core", () => {
  test("a unit that starts the 0.7 hub is not the hub's own: no verb starts it", () => {
    const b = box(OLD_HUB);
    insideCore(b.home);
    expect(isHubUnitInstalled(b.deps)).toBe(false);
  });

  test("a unit that starts core is", () => {
    const b = box("placeholder");
    const root = insideCore(b.home);
    const withCore = box(`/usr/bin/bun ${root}/packages/cli/src/parachute-core.ts serve`);
    process.env[CORE_ROOT_ENV] = root;
    expect(isHubUnitInstalled(withCore.deps)).toBe(true);
  });

  test("outside core, any hub unit file is the hub's, as in 0.7", () => {
    delete process.env[CORE_ROOT_ENV];
    expect(isHubUnitInstalled(box(OLD_HUB).deps)).toBe(true);
  });

  test("what counts as starting core", () => {
    for (const exec of ['"/home/op/.local/share/parachute/bin/parachute-core" serve', "/x/bin/parachute-core serve --offline", "/usr/bin/bun /x/packages/cli/src/parachute-core.ts serve", "@/x/bin/parachute-core pc serve"]) {
      expect({ exec, core: unitStartsCore(`[Service]\nExecStart=${exec}\n`) }).toEqual({ exec, core: true });
    }
    expect(unitStartsCore("[Service]\n  ExecStart = /x/bin/parachute-core serve\n")).toBe(true);
    for (const exec of [OLD_HUB, "/home/op/.bun/bin/parachute serve", "/opt/parachute-core/old/hub/cli.ts serve", "/usr/bin/sleep 1000"]) {
      expect({ exec, core: unitStartsCore(`[Service]\nExecStart=${exec}\n`) }).toEqual({ exec, core: false });
    }
    expect(unitStartsCore("# parachute-core serve\n[Service]\nWorkingDirectory=/x/parachute-core\nExecStart=/x/hub serve\n")).toBe(false);
  });
});
