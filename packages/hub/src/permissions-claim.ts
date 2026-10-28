/**
 * The `permissions` claim on a minted pass: which keys may ride on it, and how
 * a tag-scoped minter's own limit carries over to what it mints.
 *
 * Fix 14 (fail closed): the vault enforces exactly two keys — `scoped_tags`
 * (which notes the pass sees) and `principal_pubkey` (write attribution),
 * vault `src/auth.ts`. Any other key would be signed into the pass and then
 * ignored, so a pass its operator believes limited (the old CLI help
 * suggested `{"vault":{"default":{"write_tags":[...]}}}`) would be
 * whole-vault. Both mint doors refuse such keys instead.
 *
 * Fix 13 (attenuation): a minter limited to some tags may mint only passes
 * limited to those tags or tags under them (`health` → `health/food`). The
 * check is by name; a child declared through a tag schema is refused, which
 * errs closed.
 */

export const ENFORCED_PERMISSION_KEYS: readonly string[] = ["scoped_tags", "principal_pubkey"];

/** Keys in a requested `permissions` object that no vault enforces. */
export function unknownPermissionKeys(permissions: Record<string, unknown>): string[] {
  return Object.keys(permissions).filter((k) => !ENFORCED_PERMISSION_KEYS.includes(k));
}

/**
 * Why a minting pass's own `permissions` claim makes it unusable as a minter,
 * or null when it's fine (absent, or an object with only enforced keys).
 */
export function bearerPermissionsProblem(permissions: unknown): string | null {
  if (permissions === undefined || permissions === null) return null;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return "has a malformed permissions claim";
  const unknown = unknownPermissionKeys(permissions as Record<string, unknown>);
  return unknown.length > 0 ? `carries permission key(s) no vault enforces: ${unknown.join(", ")}` : null;
}

/**
 * Why a pass carrying `minterPermissions` may not mint a pass asking for
 * `askedPermissions`, or null when it may. An unscoped minter (no
 * `scoped_tags`, or null) may ask for any tags, or none.
 */
export function scopedTagsWiderThanMinter(
  minterPermissions: unknown,
  askedPermissions: Record<string, unknown> | undefined,
): string | null {
  const held =
    minterPermissions && typeof minterPermissions === "object" && !Array.isArray(minterPermissions)
      ? (minterPermissions as Record<string, unknown>).scoped_tags
      : undefined;
  if (held === undefined || held === null) return null;
  if (!Array.isArray(held) || held.length === 0 || !held.every((t) => typeof t === "string" && t.length > 0)) {
    return "the minting pass's permissions.scoped_tags is malformed";
  }
  const heldTags = held as string[];
  const asked = askedPermissions?.scoped_tags;
  if (!Array.isArray(asked) || asked.length === 0) {
    return `a pass limited to tags [${heldTags.join(", ")}] can only mint passes limited to those tags: set permissions.scoped_tags`;
  }
  const outside = asked.filter(
    (t) => typeof t !== "string" || !heldTags.some((h) => t === h || t.startsWith(`${h}/`)),
  );
  if (outside.length > 0) {
    return `permissions.scoped_tags asks for ${outside.map((t) => JSON.stringify(t)).join(", ")}, outside the minting pass's tags [${heldTags.join(", ")}]`;
  }
  return null;
}
