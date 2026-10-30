// The environment a takeover's check run gets (takeover.ts handOverEnv) must be the one systemd will give
// parachute-core.service. It is read from `systemctl --user show -p Environment -p EnvironmentFiles`, so it has to
// read what systemd really prints there. A fake systemctl on PATH prints that, byte for byte as systemd 258 does
// (bus-print-properties.c: shell_maybe_quote(value, 0), whose control characters come out as cescape_char's C
// escapes; systemctl-show.c: one `EnvironmentFiles=<path> (ignore_errors=…)` line per file, the path as configured).
// No real systemd is touched: the check runs in a child process whose PATH starts with the fake.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "takeover-handover-env-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `call` (handOverEnv or unitEnvironment, on "old.service") in a child process whose `systemctl` prints `show`. */
function inChild(show: string, call: string): any {
  const dir = mkdtempSync(join(root, "case-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "show.txt"), show);
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\ncase "$*" in\n  *show-environment*) printf 'PATH=/usr/bin:/bin\\n' ;;\n  *" show "*) cat '${join(dir, "show.txt")}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  const driver = join(dir, "driver.ts");
  writeFileSync(
    driver,
    `import { handOverEnv, unitEnvironment } from ${JSON.stringify(join(import.meta.dir, "takeover.ts"))};\nconsole.log(JSON.stringify(${call}));\n`,
  );
  const r = Bun.spawnSync([process.execPath, driver], {
    cwd: import.meta.dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`driver failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}
const handOver = (show: string): { env: Record<string, string>; unread: string[] } => inChild(show, `handOverEnv("old.service", {})`);

describe("handOverEnv reads systemctl show as systemd prints it", () => {
  test("Environment= values: shell quoting and the C escapes systemd uses for control characters", () => {
    // Values: PLAIN=1, SPACE="a b", DOLLAR="$HOME", QUOTE='say "hi"', BACK='a\b', TAB="a<tab>b", NL="a<newline>b",
    // ESC="a<0x1b>b". systemd quotes the last three and prints \t, \n and \033 for them.
    const show = `Environment=PLAIN=1 "SPACE=a b" "DOLLAR=\\$HOME" "QUOTE=say \\"hi\\"" "BACK=a\\\\b" "TAB=a\\tb" "NL=a\\nb" "ESC=a\\033b"\n`;
    const { env } = handOver(show);
    expect(env.PLAIN).toBe("1");
    expect(env.SPACE).toBe("a b");
    expect(env.DOLLAR).toBe("$HOME");
    expect(env.QUOTE).toBe('say "hi"');
    expect(env.BACK).toBe("a\\b");
    expect(env.TAB).toBe("a\tb");
    expect(env.NL).toBe("a\nb");
    expect(env.ESC).toBe("a\x1bb");
  });

  test("an EnvironmentFile= wildcard (systemd.exec: a filename or wildcard expression) reads every match, in order", () => {
    const d = join(root, "envd");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "10-a.conf"), "SHARED=first\nPATH=/opt/tools/bin:/usr/bin\n");
    writeFileSync(join(d, "20-b.conf"), "SHARED=second\n");
    writeFileSync(join(d, "ignored.txt"), "SHARED=never\n");
    const { env, unread } = handOver(`Environment=PLAIN=1\nEnvironmentFiles=${d}/*.conf (ignore_errors=yes)\n`);
    expect(unread).toEqual([]);
    expect(env.PATH).toBe("/opt/tools/bin:/usr/bin");
    expect(env.SHARED).toBe("second");
  });

  test("a wildcard that matches nothing is skipped, as systemd skips a '-' file that isn't there", () => {
    const { env, unread } = handOver(`Environment=PLAIN=1\nEnvironmentFiles=${join(root, "nowhere")}/*.conf (ignore_errors=yes)\n`);
    expect(unread).toEqual([]);
    expect(env.PLAIN).toBe("1");
  });

  test("core's unit gets such a value back as systemd will read it, on one line: a line break can't start a new setting", () => {
    const lines: string[] = inChild(`Environment="NL=a\\nExecStartPre=/bin/false" "TAB=a\\tb"\n`, `unitEnvironment("old.service")`);
    expect(lines).toEqual(['Environment="NL=a\\x0aExecStartPre=/bin/false"', 'Environment="TAB=a\\x09b"']);
  });
});
