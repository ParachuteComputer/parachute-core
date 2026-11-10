// Whether a push to release/0.8 publishes @openparachute/core to npm, and under which dist-tag (RELEASING.md).
//
// This is the 0.8 line's branch. 0.8.x ships from `release/0.8` (to `next` and `latest`); `main` and `next` carry 0.9,
// whose prereleases go to `beta` from main under 0.9's own plan. So this plan publishes only from RELEASE_BRANCH, and
// only versions of LINE: 0.9 code merged here by mistake refuses instead of reaching `next` or `latest`.
//
//   bun scripts/release-plan.ts [--package-json <file>] [--registry <file>]   writes version, dist_tag, should_publish to $GITHUB_OUTPUT
//
// The pattern is the hub's (parachute-hub scripts/release-plan.ts, decidePublish), cut down to this package's two
// channels:
//   X.Y.Z-pre.N   dist-tag `next`, published on the merge that brings that version to release/0.8
//   X.Y.Z         dist-tag `latest`, only after an approval on the `npm-latest` environment (release.yml), and only
//                 as a suffix-drop of an X.Y.Z-pre.N that is already on npm, with nothing changed since but the
//                 release notes and the `"version"` lines of the manifests that carry core's version and bun.lock
//   anything else (0.8.0-dev.0) is not a release and never publishes.
//
// What it guards against, as the hub learned it:
//   - double-publishing: a version already on npm is skipped (a re-run, a merge with no bump);
//   - guessing: a registry that can't be read refuses, since a wrong answer either double-publishes or drops one;
//   - publishing backwards: a version older than its dist-tag's refuses (parallel PRs merged out of order);
//   - a first publish out of a merge: npm trusted publishing can't create a package, only add versions to one that
//     exists and trusts this workflow (docs.npmjs.com/cli/v11/commands/npm-trust: "The package you're configuring
//     must already exist on the npm registry"). A package npm has never seen is skipped with that reason; the
//     first publish is Aaron's, by hand (RELEASING.md);
//   - a stable that skipped its prerelease, or carries new code past it.
import { appendFileSync, readFileSync } from "node:fs";

export type Channel = "next" | "latest";

/** The branch the 0.8 line publishes from, and the one line it may publish (RELEASING.md, "Two lines"). */
export const RELEASE_BRANCH = "release/0.8";
export const LINE = "0.8";

/** X.Y of a version. */
export function lineOf(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

export type Decision = { publish: true; reason: string } | { publish: false; reason: string } | { refuse: true; reason: string };

export interface Registry {
  /** Every version npm has (empty: the package was never published). */
  versions: string[];
  /** What each dist-tag points at. */
  distTags: Record<string, string>;
}

/** `next` for X.Y.Z-pre.N, `latest` for X.Y.Z, null for anything else. */
export function channelFor(version: string): Channel | null {
  if (/^\d+\.\d+\.\d+-pre\.\d+$/.test(version)) return "next";
  if (/^\d+\.\d+\.\d+$/.test(version)) return "latest";
  return null;
}

function parse(v: string): { nums: number[]; pre: number } {
  const [core, pre] = v.split("-");
  return { nums: core!.split(".").map((n) => Number.parseInt(n, 10)), pre: pre ? Number.parseInt(pre.split(".")[1] ?? "0", 10) : Number.POSITIVE_INFINITY };
}

/** <0, 0, >0. A release sorts above its own prereleases (0.8.0 > 0.8.0-pre.9). */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return pa.pre === pb.pre ? 0 : pa.pre < pb.pre ? -1 : 1;
}

/** The X.Y.Z-pre.N on npm a stable X.Y.Z would drop the suffix of, newest first. */
export function prereleasesOf(version: string, published: string[]): string[] {
  const core = version.split("-")[0]!;
  return published.filter((v) => v.startsWith(`${core}-pre.`) && channelFor(v) === "next").sort(compareVersions).reverse();
}

/** What a stable may change since its prerelease: the notes freely, and in these files only `"version"` lines. */
export const STABLE_NOTES = ["CHANGELOG.md", "RELEASING.md"];
export const STABLE_VERSION_ONLY = ["package.json", "packages/cli/package.json", "packages/hub/package.json", "packages/vault/package.json", "bun.lock"];

/** The manifests besides the root's that carry core's version: the hub and the vault report theirs as what runs. */
export const VERSION_MANIFESTS = ["packages/cli/package.json", "packages/hub/package.json", "packages/vault/package.json"];

/** The manifests that don't say `version`, each with what it says: published like that, a 0.8 box would report them. */
export function manifestsOffVersion(version: string, readVersion: (path: string) => string | undefined): string[] {
  return VERSION_MANIFESTS.flatMap((p) => {
    const v = readVersion(p);
    return v === version ? [] : [`${p} (${v ?? "unreadable"})`];
  });
}

/** Changed paths a stable may not carry past its prerelease (the version-only files are checked by their diff). */
export function changedPastPrerelease(paths: string[]): string[] {
  return paths.filter((p) => p && !STABLE_NOTES.includes(p) && !STABLE_VERSION_ONLY.includes(p));
}

/** Whether a `git diff -U0` changes nothing but `"version": "…"` lines (the suffix drop, in a manifest or bun.lock). */
export function versionOnlyDiff(diff: string): boolean {
  const changed = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return changed.every((l) => /^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(l));
}

/** The decision for `version`, pushed to `branch` (only RELEASE_BRANCH publishes), given what npm has (or `null`: npm couldn't be read). */
export function decidePublish(version: string, registry: Registry | null, branch: string | undefined): Decision {
  const channel = channelFor(version);
  if (!channel) return { publish: false, reason: `${version} is not a release version (X.Y.Z-pre.N for next, X.Y.Z for latest)` };
  if (branch !== RELEASE_BRANCH) return { publish: false, reason: `${LINE}.x releases publish from ${RELEASE_BRANCH} only (this is ${branch ?? "no branch"})` };
  if (lineOf(version) !== LINE) {
    return { refuse: true, reason: `${version} is not a ${LINE}.x version: ${RELEASE_BRANCH} publishes ${LINE}.x only, to next and latest. A later line publishes to beta from main.` };
  }
  if (!registry) return { refuse: true, reason: "npm couldn't be read: refusing to guess, since a wrong answer either double-publishes or drops a release" };
  if (registry.versions.includes(version)) return { publish: false, reason: `${version} is already on npm` };
  if (registry.versions.length === 0) {
    return {
      publish: false,
      reason:
        `npm has never had this package, and ${version} would be its first version. npm trusted publishing can't create ` +
        "a package (the package must exist before a trusted publisher can be set), so the first publish is done once by " +
        "hand: RELEASING.md, \"One-time setup\". Merges publish from the next version on.",
    };
  }
  const current = registry.distTags[channel];
  if (current && compareVersions(version, current) < 0) {
    return { refuse: true, reason: `${version} is older than ${channel} (${current}): publishing would move ${channel} backwards. Bump past it and merge again.` };
  }
  // A prerelease of a version that already shipped stable (0.8.0-pre.4 after 0.8.0) would put next below latest.
  const latest = registry.distTags.latest;
  if (channel === "next" && latest && channelFor(latest) === "latest" && compareVersions(version, latest) < 0) {
    return { refuse: true, reason: `${version} is a prerelease of a version older than latest (${latest}): bump to the next version's -pre.1` };
  }
  if (channel === "latest" && prereleasesOf(version, registry.versions).length === 0) {
    return { refuse: true, reason: `${version} is a stable version but npm has no ${version}-pre.*: a stable drops the suffix of a prerelease that shipped on next first` };
  }
  return { publish: true, reason: `${version} is not on npm yet; it goes to ${channel}` };
}

/** Read npm's view of the package. `null` when npm can't be read: never guessed. */
export async function readRegistry(name: string, fetchImpl: typeof fetch = fetch): Promise<Registry | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
    if (res.status === 404) return { versions: [], distTags: {} };
    if (!res.ok) return null;
    const body = (await res.json()) as { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> };
    return { versions: Object.keys(body.versions ?? {}), distTags: body["dist-tags"] ?? {} };
  } catch {
    return null;
  }
}

function git(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--package-json");
  const pkg = JSON.parse(readFileSync(i > 0 ? process.argv[i + 1]! : "package.json", "utf8"));
  const version: string = pkg.version;
  // --registry <file>: npm's answer from a file instead of the network (the plan's own tests, release-plan.test.ts).
  const r = process.argv.indexOf("--registry");
  const registry = r > 0 ? (JSON.parse(readFileSync(process.argv[r + 1]!, "utf8")) as Registry) : await readRegistry(pkg.name);
  let decision = decidePublish(version, registry, process.env.GITHUB_REF_NAME);
  // A stable: nothing but the version and the notes may have changed since the newest prerelease's tag.
  if ("publish" in decision && decision.publish && channelFor(version) === "latest") {
    const pre = prereleasesOf(version, registry!.versions)[0]!;
    const diff = git(["diff", "--name-only", `v${pre}..HEAD`]);
    if (diff.code !== 0) decision = { refuse: true, reason: `can't compare with the tag v${pre} (git diff failed): fetch tags, or tag the prerelease` };
    else {
      const paths = diff.out.split("\n").map((l) => l.trim());
      const extra = changedPastPrerelease(paths);
      for (const f of STABLE_VERSION_ONLY.filter((f) => paths.includes(f))) {
        const d = git(["diff", "-U0", `v${pre}..HEAD`, "--", f]);
        if (d.code !== 0 || !versionOnlyDiff(d.out)) extra.push(`${f} (more than its "version")`);
      }
      if (extra.length) decision = { refuse: true, reason: `${version} changes more than its prerelease ${pre} did: ${extra.join(", ")}` };
    }
  }
  // Whichever channel: every manifest that carries core's version says this one.
  if ("publish" in decision && decision.publish) {
    const off = manifestsOffVersion(version, (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8")).version;
      } catch {
        return undefined;
      }
    });
    if (off.length) decision = { refuse: true, reason: `${version} isn't what these manifests say: ${off.join(", ")}. RELEASING.md: a bump changes all of them.` };
  }
  if ("refuse" in decision) {
    console.error(`::error::${pkg.name}@${version}: ${decision.reason}`);
    process.exit(1);
  }
  const out = [`version=${version}`, `dist_tag=${channelFor(version) ?? ""}`, `should_publish=${decision.publish}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out.map((l) => `${l}\n`).join(""));
  for (const l of out) console.log(l);
  console.log(`${pkg.name}@${version}: ${decision.reason}`);
}
