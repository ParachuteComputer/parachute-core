// The publish decision (release-plan.ts): what a merge to main may send to npm, and what it must refuse.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { NEXT_SERVES, SERVED_FROM, VERSION_MANIFESTS, changedPastPrerelease, channelFor, compareVersions, decidePublish, manifestsOffVersion, readRegistry, versionOnlyDiff, type Registry } from "./release-plan.ts";

const npm = (versions: string[], distTags: Record<string, string> = {}): Registry => ({ versions, distTags });
const published = npm(["0.8.0-pre.1"], { next: "0.8.0-pre.1", latest: "0.8.0-pre.1" });

const S = SERVED_FROM;

describe("release plan", () => {
  test("channels: X.Y.Z-pre.N of the line next serves is next, of a later line beta; X.Y.Z is latest; anything else is not a release", () => {
    expect(NEXT_SERVES).toBe("0.8");
    expect(channelFor("0.8.0-pre.1")).toBe("next");
    expect(channelFor("0.8.1-pre.1")).toBe("next");
    // 0.9 is tried on beta first: the one-liner and every 0.8 box install `next` (ROADMAP "Channel first", L6-04).
    expect(channelFor("0.9.0-pre.1")).toBe("beta");
    expect(channelFor("1.0.0-pre.1")).toBe("beta");
    // The PR that moves next to 0.9 moves NEXT_SERVES with it.
    expect(channelFor("0.9.0-pre.4", "0.9")).toBe("next");
    expect(channelFor("0.9.0", "0.8")).toBe("latest");
    expect(channelFor("0.8.0")).toBe("latest");
    for (const v of ["0.8.0-dev.0", "0.8.0-rc.1", "0.8.0-pre", "v0.8.0", "0.8"]) expect({ v, c: channelFor(v) }).toEqual({ v, c: null });
  });

  test("versions sort with a release above its prereleases, and numbers as numbers", () => {
    expect(compareVersions("0.8.0", "0.8.0-pre.9")).toBe(1);
    expect(compareVersions("0.8.0-pre.10", "0.8.0-pre.9")).toBe(1);
    expect(compareVersions("0.8.1-pre.1", "0.8.0")).toBe(1);
    expect(compareVersions("0.8.0-pre.2", "0.8.0-pre.2")).toBe(0);
  });

  test("a manifest that doesn't carry the version is named, so the release can refuse it", () => {
    const at = (over: Record<string, string | undefined>) => (p: string) => (p in over ? over[p] : "0.8.0-pre.4");
    expect(manifestsOffVersion("0.8.0-pre.4", at({}))).toEqual([]);
    expect(manifestsOffVersion("0.8.0-pre.4", at({ "packages/hub/package.json": "0.8.0-pre.3" }))).toEqual(["packages/hub/package.json (0.8.0-pre.3)"]);
    expect(manifestsOffVersion("0.8.0-pre.4", at({ "packages/vault/package.json": undefined }))).toEqual(["packages/vault/package.json (unreadable)"]);
  });

  test("this tree's manifests all carry the root's version", () => {
    const root = join(import.meta.dir, "..");
    const version = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8")).version as string;
    expect(VERSION_MANIFESTS.map((p) => [p, version(p)])).toEqual(VERSION_MANIFESTS.map((p) => [p, version("package.json")]));
  });

  test("a new prerelease of the served line on release/0.8 publishes to next", () => {
    expect(decidePublish("0.8.0-pre.2", published, S)).toEqual({ publish: true, reason: expect.stringContaining("next") });
  });

  test("0.9's prerelease (PR #21) publishes to beta and leaves next, which every 0.8 box follows, alone", () => {
    const today = npm(["0.8.0-pre.1", "0.8.0-pre.2", "0.8.0-pre.3"], { latest: "0.8.0-pre.1", next: "0.8.0-pre.3" });
    expect(decidePublish("0.9.0-pre.1", today, "main")).toEqual({ publish: true, reason: expect.stringContaining("goes to beta") });
    // beta never moves backwards either, and a 0.8 prerelease still goes to next beside it
    const tried = npm([...today.versions, "0.9.0-pre.2"], { ...today.distTags, beta: "0.9.0-pre.2" });
    expect(decidePublish("0.9.0-pre.1", tried, "main")).toMatchObject({ refuse: true, reason: expect.stringContaining("older than beta") });
    expect(decidePublish("0.8.0-pre.4", tried, S)).toEqual({ publish: true, reason: expect.stringContaining("goes to next") });
  });

  test("a stable of a line next doesn't serve yet refuses: moving next is its own decision", () => {
    const tried = npm(["0.8.0-pre.3", "0.8.0", "0.9.0-pre.2"], { latest: "0.8.0", next: "0.8.0-pre.3", beta: "0.9.0-pre.2" });
    expect(decidePublish("0.9.0", tried, "main")).toMatchObject({ refuse: true, reason: expect.stringContaining("SERVED_FROM") });
    expect(decidePublish("0.9.0", tried, S)).toMatchObject({ refuse: true, reason: expect.stringContaining("NEXT_SERVES") });
    // its prerelease shipped on beta counts as the one it drops the suffix of, once next serves 0.9 from main again
    expect(decidePublish("0.9.0", tried, "main", "0.9", "main")).toEqual({ publish: true, reason: expect.stringContaining("latest") });
  });

  test("no 0.9 commit reaches next or latest: main publishes beta only, the served line ships from release/0.8", () => {
    const tried = npm(["0.8.0-pre.3", "0.9.0-pre.1"], { latest: "0.8.0-pre.1", next: "0.8.0-pre.3", beta: "0.9.0-pre.1" });
    expect(SERVED_FROM).toBe("release/0.8");
    // a served-line version on main (0.9 code) refuses loudly; the same version from release/0.8 publishes to next
    expect(decidePublish("0.8.0-pre.4", tried, "main")).toMatchObject({ refuse: true, reason: expect.stringContaining("release/0.8") });
    expect(decidePublish("0.8.0", tried, "main")).toMatchObject({ refuse: true });
    expect(decidePublish("0.8.0-pre.4", tried, S)).toEqual({ publish: true, reason: expect.stringContaining("goes to next") });
    // beta never goes out from release/0.8 or next
    expect(decidePublish("0.9.0-pre.2", tried, S)).toMatchObject({ publish: false });
    expect(decidePublish("0.9.0-pre.2", tried, "next")).toMatchObject({ publish: false });
    expect(decidePublish("0.9.0-pre.2", tried, "main")).toEqual({ publish: true, reason: expect.stringContaining("goes to beta") });
  });

  test("a dev version never publishes, and nothing publishes off its branch", () => {
    expect(decidePublish("0.8.0-dev.0", published, S)).toMatchObject({ publish: false });
    expect(decidePublish("0.8.0-pre.2", published, "uni/some-branch")).toMatchObject({ publish: false });
    expect(decidePublish("0.8.0-pre.2", published, undefined)).toMatchObject({ publish: false });
  });

  test("a version npm already has is skipped", () => {
    expect(decidePublish("0.8.0-pre.1", published, S)).toMatchObject({ publish: false, reason: expect.stringContaining("already on npm") });
  });

  test("a package npm never had is skipped: the first publish is by hand", () => {
    expect(decidePublish("0.8.0-pre.1", npm([]), S)).toMatchObject({ publish: false, reason: expect.stringContaining("first publish") });
  });

  test("npm that can't be read refuses", () => {
    expect(decidePublish("0.8.0-pre.2", null, S)).toMatchObject({ refuse: true });
  });

  test("a dist-tag never moves backwards", () => {
    const later = npm(["0.8.0-pre.1", "0.8.0-pre.3"], { next: "0.8.0-pre.3" });
    expect(decidePublish("0.8.0-pre.2", later, S)).toMatchObject({ refuse: true, reason: expect.stringContaining("backwards") });
  });

  test("a prerelease never goes out after its version shipped stable", () => {
    const shipped = npm(["0.8.0-pre.3", "0.8.0"], { next: "0.8.0-pre.3", latest: "0.8.0" });
    expect(decidePublish("0.8.0-pre.4", shipped, S)).toMatchObject({ refuse: true, reason: expect.stringContaining("older than latest") });
    expect(decidePublish("0.8.1-pre.1", shipped, S)).toMatchObject({ publish: true });
    // latest pointing at a prerelease (npm's first publish may do that) doesn't block the next prerelease
    expect(decidePublish("0.8.0-pre.2", published, S)).toMatchObject({ publish: true });
  });

  test("a stable needs its prerelease on npm first", () => {
    expect(decidePublish("0.8.0", published, S)).toEqual({ publish: true, reason: expect.stringContaining("latest") });
    expect(decidePublish("0.8.1", published, S)).toMatchObject({ refuse: true, reason: expect.stringContaining("0.8.1-pre.") });
  });

  test("a stable may change only the version and the notes since its prerelease", () => {
    expect(changedPastPrerelease(["package.json", "bun.lock", "CHANGELOG.md", ""])).toEqual([]);
    // Dropping the suffix touches every manifest that carries core's version (RELEASING.md).
    expect(changedPastPrerelease(["packages/cli/package.json", "packages/hub/package.json", "packages/vault/package.json"])).toEqual([]);
    expect(changedPastPrerelease(["package.json", "packages/cli/src/serve.ts"])).toEqual(["packages/cli/src/serve.ts"]);
    const drop = 'diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -10 +10 @@\n-      "version": "0.8.0-pre.3",\n+      "version": "0.8.0",\n';
    expect(versionOnlyDiff(drop)).toBe(true);
    const dep = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -3 +3 @@\n-  "version": "0.8.0-pre.3",\n+  "version": "0.8.0",\n@@ -20 +20,1 @@\n+    "left-pad": "1.3.0",\n';
    expect(versionOnlyDiff(dep)).toBe(false);
  });

  test("the registry: 404 is a package never published, other errors are unreadable", async () => {
    const answer = (status: number, body?: unknown) => (async () => new Response(body ? JSON.stringify(body) : null, { status })) as unknown as typeof fetch;
    expect(await readRegistry("@openparachute/core", answer(404))).toEqual({ versions: [], distTags: {} });
    expect(await readRegistry("@openparachute/core", answer(503))).toBeNull();
    expect(await readRegistry("@openparachute/core", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
    expect(await readRegistry("@openparachute/core", answer(200, { versions: { "0.8.0-pre.1": {} }, "dist-tags": { next: "0.8.0-pre.1" } }))).toEqual(npm(["0.8.0-pre.1"], { next: "0.8.0-pre.1" }));
  });
});

describe("release plan, run on a repository: a stable's diff since its prerelease's tag", () => {
  const script = join(import.meta.dir, "release-plan.ts");
  function repo(): { dir: string; git: (...a: string[]) => void; write: (f: string, s: string) => void; plan: () => { code: number; out: string } } {
    const dir = mkdtempSync(join(tmpdir(), "release-plan-"));
    const git = (...a: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    const write = (f: string, text: string) => {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    };
    const plan = () => {
      writeFileSync(join(dir, ".registry.json"), JSON.stringify(npm(["0.8.0-pre.3"], { next: "0.8.0-pre.3", latest: "0.8.0-pre.3" })));
      const p = Bun.spawnSync([process.execPath, script, "--registry", ".registry.json"], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: SERVED_FROM, GITHUB_OUTPUT: "" }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
    };
    git("init", "-q");
    write("package.json", JSON.stringify({ name: "@openparachute/core", version: "0.8.0-pre.3" }, null, 2) + "\n");
    for (const f of VERSION_MANIFESTS) write(f, JSON.stringify({ version: "0.8.0-pre.3" }, null, 2) + "\n");
    write("bun.lock", '{\n  "workspaces": {\n    "packages/cli": {\n      "version": "0.8.0-pre.3",\n    },\n  },\n}\n');
    write("serve.ts", "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "pre.3");
    git("tag", "v0.8.0-pre.3");
    return { dir, git, write, plan };
  }
  const drop = (r: ReturnType<typeof repo>) => {
    for (const f of ["package.json", ...VERSION_MANIFESTS, "bun.lock"]) r.write(f, readFileSync(join(r.dir, f), "utf8").replace("0.8.0-pre.3", "0.8.0"));
  };

  test("dropping the suffix (the manifests and bun.lock) and adding notes publishes", () => {
    const r = repo();
    drop(r);
    r.write("CHANGELOG.md", "0.8.0\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "0.8.0");
    const p = r.plan();
    expect({ code: p.code, publish: p.out.includes("should_publish=true") }).toEqual({ code: 0, publish: true });
  });

  test("a bump that misses a manifest refuses, naming it", () => {
    const r = repo();
    drop(r);
    r.write("packages/hub/package.json", JSON.stringify({ version: "0.8.0-pre.3" }, null, 2) + "\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "0.8.0, hub missed");
    const p = r.plan();
    expect({ code: p.code, names: p.out.includes("packages/hub/package.json (0.8.0-pre.3)") }).toEqual({ code: 1, names: true });
  });

  test("a code change, or a dependency added beside the version, refuses", () => {
    for (const extra of [(r: ReturnType<typeof repo>) => r.write("serve.ts", "export const x = 1;\n"), (r: ReturnType<typeof repo>) => r.write("package.json", readFileSync(join(r.dir, "package.json"), "utf8").replace('"version"', '"dependencies": { "left-pad": "1.3.0" },\n  "version"'))]) {
      const r = repo();
      drop(r);
      extra(r);
      r.git("add", "-A");
      r.git("commit", "-qm", "0.8.0 and more");
      const p = r.plan();
      expect({ code: p.code, says: /changes more than its prerelease/.test(p.out) }).toEqual({ code: 1, says: true });
    }
  });
});
