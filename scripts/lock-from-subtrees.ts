// Build the root bun.lock from the moved packages' own lockfiles, so the one workspace resolves its dependencies to
// the versions vault and hub already locked in their repos (a fresh `bun install` moved 78 of the vault's and 29 of
// the hub's to newer versions). Where the two locked one name differently, a hoisted tree keeps one: the rule below
// picks it, and scripts/check-dependency-tree.ts lists each such departure with its reason (and fails on any other).
// Run it again after a `git subtree pull`:
//
//   mv bun.lock /tmp/fresh.lock; bun install --lockfile-only; mv bun.lock /tmp/fresh.lock   (fresh workspace entries)
//   bun scripts/lock-from-subtrees.ts /tmp/fresh.lock packages/vault/bun.lock packages/hub/bun.lock > bun.lock
//   bun install && bun scripts/check-dependency-tree.ts . packages/vault/bun.lock packages/hub/bun.lock
//
// `fresh` supplies the workspace entries (they must match each package.json as it is now).
const read = async (f: string) => Bun.JSONC.parse(await Bun.file(f).text()) as any;
const [freshF, vaultF, hubF] = process.argv.slice(2);
const fresh = await read(freshF!), vault = await read(vaultF!), hub = await read(hubF!);
// The workspace entries are the fresh lock's: they must match each package.json as it is now (the vault's own
// lock still names it "parachute-vault", and a mismatch makes bun re-resolve the whole workspace).
const workspaces = fresh.workspaces;
const packages: Record<string, any> = {};
const conflicts: string[] = [];
for (const [src, lock] of [["vault", vault], ["hub", hub]] as const) {
  for (const [k, v] of Object.entries<any>(lock.packages)) {
    let entry = v;
    if (String(v[0]).includes("@workspace:")) {
      const [name, path] = String(v[0]).split("@workspace:");
      entry = [`${name}@workspace:${src === "hub" ? `packages/hub/${path}` : `packages/vault/${path}`}`];
    }
    if (packages[k] && JSON.stringify(packages[k]) !== JSON.stringify(entry)) {
      // One version per name at the top: the hub's for the TOTP chain (otpauth pins @noble/hashes exactly, and the
      // hub's @noble/curves pins it too), the vault's for the rest (types only). Bun nests what a range needs.
      const hubWins = ["otpauth", "@noble/hashes", "@emnapi/runtime"].includes(k);
      conflicts.push(`${k}: vault ${packages[k][0]} / hub ${entry[0]} → ${hubWins ? "hub" : "vault"}`);
      if (hubWins) packages[k] = entry;
      continue;
    }
    packages[k] = entry;
  }
}
for (const [k, v] of Object.entries<any>(fresh.packages)) if (String(v[0]).includes("@workspace:")) packages[k] = v;
console.error(`conflicts:\n  ${conflicts.join("\n  ")}`);
console.log(JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces, packages }, null, 2));
