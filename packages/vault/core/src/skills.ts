/**
 * Skills in a vault (T-476; Aaron, 11-24). A skill is a record of type `skill`: its body is instructions an AI follows
 * when a task matches its `description`. Every AI connected to the vault may read and follow it, so a skill planted by
 * anyone who can write would be a prompt injection that stays. The rule: only an admin key, or a pack the person
 * installs (the box's `add-pack`, which writes below the door), may add or change one.
 *
 * Pure: no door imports, so a box and the cloud door hold the same rule. The write check runs in the engine's one
 * pre-write gate (`enforceStrictWrite`, mcp.ts) on every create and update at both doors, MCP and REST. The tag ops that
 * could turn records into skills or back (rename, merge, delete a type) already need admin at both doors.
 *
 * A record whose path lies under another skill record's path is a file of that skill (`Skills/brand/voice`, a `voice.md`
 * beside `Skills/brand`'s SKILL.md), so a skill's files are skill records too and the one type check covers them.
 */
import type { Database } from "bun:sqlite";
import { getTagDescendants, loadTagHierarchy, stripTagHash } from "./tag-hierarchy.js";

/** The type that makes a record a skill. Made like any type, on the first write that names it; its one field that
 *  matters is `description` (a skill without one isn't listed), and `name` may override the name taken from the path. */
export const SKILL_TYPE = "skill";

/** Does this tag list make a record a skill? Any case and a leading `#` count, so `#Skill` can't slip past the rule. */
export function hasSkillType(tags: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(tags) && tags.some((t) => typeof t === "string" && stripTagHash(t).toLowerCase() === SKILL_TYPE);
}

const WHY = "a skill is instructions every AI connected to this vault may follow";

/** Refused: a write that adds, changes or removes a skill without admin. Both doors map `code` to a 403-class refusal. */
export class SkillWriteError extends Error {
  readonly code = "SKILL_NEEDS_ADMIN";
  readonly error_type = "skill_needs_admin";
  readonly hint =
    "Ask the vault's owner to add or change it with an admin key, or install it as part of a pack. Reading and using skills needs no admin.";
  constructor(what: string) {
    super(`Only an admin key can ${what}: ${WHY}.`);
    this.name = "SkillWriteError";
  }
}

/**
 * The types whose records `query-records { type: "skill" }` returns: `skill` and every type declared under it, however
 * far down (lower-cased; a parent named in any case, with or without a row of its own). Setting a parent needs admin,
 * but an admin-made subtype's records reach an AI that lists skills, so the write rule counts them as skills too.
 */
export function skillTypeNames(db: Database): Set<string> {
  const names = new Set<string>([SKILL_TYPE]);
  const h = loadTagHierarchy(db);
  const roots = new Set<string>([SKILL_TYPE]);
  for (const n of [...h.allTags, ...h.childrenOf.keys()]) if (n.toLowerCase() === SKILL_TYPE) roots.add(n);
  for (const root of roots) for (const d of getTagDescendants(h, root)) names.add(d.toLowerCase());
  return names;
}

/** Do these tags make a record a skill? `skillTypes` (skillTypeNames) counts subtypes; without it only `skill`. */
export function isSkillTags(tags: readonly unknown[] | null | undefined, skillTypes?: ReadonlySet<string>): boolean {
  if (hasSkillType(tags)) return true;
  return skillTypes !== undefined && Array.isArray(tags) && tags.some((t) => typeof t === "string" && skillTypes.has(stripTagHash(t).toLowerCase()));
}

/**
 * The write check, given the record before (`wasTags`, or `wasSkill`) and the tags it will have. Throws when a caller that may not
 * write skills (`maySkills` not true) would make, change or unmake one. `skillTypes` (skillTypeNames) counts a
 * subtype of `skill` as a skill too; without it only `skill` itself does.
 */
export function refuseSkillWrite(
  shape: { tags?: readonly unknown[] | null; wasSkill?: boolean; wasTags?: readonly unknown[] | null },
  maySkills: boolean | undefined,
  skillTypes?: ReadonlySet<string>,
): void {
  if (maySkills === true) return;
  const isSkill = isSkillTags(shape.tags ?? [], skillTypes);
  const wasSkill = shape.wasSkill === true || isSkillTags(shape.wasTags, skillTypes);
  if (wasSkill && isSkill) throw new SkillWriteError("change a skill");
  if (wasSkill) throw new SkillWriteError("take the skill type off a record");
  if (isSkill) throw new SkillWriteError("make a record a skill");
}
