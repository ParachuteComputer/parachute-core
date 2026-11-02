/**
 * A note's display title, derived from its content (no database access, so
 * the portable-md export can use it in any runtime). `notes.ts` re-exports
 * these for its existing callers.
 */

/** Max code points in a computed `displayTitle` (title axis, ratified 2026-07-17). */
export const DISPLAY_TITLE_MAX_LEN = 120;

/**
 * Bounded line-count a leading frontmatter block's closing fence is
 * searched within (see `computeDisplayTitle`). Frontmatter blocks are a
 * handful of lines in practice; capping the scan keeps a pathological
 * "content starts with `---` but never closes it" note O(1)-ish rather
 * than a full-content scan on every derivation.
 */
const FRONTMATTER_SCAN_LINES = 100;

/**
 * Shared by `computeDisplayTitle` and `computeLede`: given `content` already
 * split into `lines`, return the index of the first line that counts as the
 * start of the DOCUMENT body — after a leading closed frontmatter block, if
 * `content` opens with one (see `computeDisplayTitle`'s frontmatter-skip
 * doc for the full rationale). `0` when there's no leading frontmatter.
 */
export function skipLeadingFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const scanLimit = Math.min(lines.length, FRONTMATTER_SCAN_LINES);
  for (let i = 1; i < scanLimit; i++) {
    if (lines[i]?.trim() === "---") return i + 1;
  }
  return 0;
}

/**
 * Derive a note's display title: the first non-empty line of `content`,
 * with a leading markdown heading marker (`#` through `######`) and its
 * following whitespace stripped, truncated to `DISPLAY_TITLE_MAX_LEN` code
 * points. `null` when content has no non-empty line (empty or
 * whitespace/heading-marker-only note).
 *
 * The ratified title model (2026-07-17): a note's title IS its first line
 * — derived from content, NEVER stored as its own column. This function is
 * the one place that derivation happens; callers (`toNoteIndex` below) call
 * it fresh at read time. Timestamp-path formatting — what a surface shows
 * in place of a `null` title — is deliberately NOT this function's job; it
 * reports the honest content-derived value (or its absence) and leaves
 * rendering to the caller.
 *
 * Frontmatter skip: normal ingestion strips a YAML frontmatter block into
 * `metadata` before create, so `content` never carries one — but a direct
 * MCP/REST create can paste raw frontmatter-bearing text
 * (`---\ntitle: X\n---\n# Real Title`), and the first line of that
 * DOCUMENT is not the first line of its delimiter. When `content` opens
 * with a `---` line, derivation starts after the matching CLOSING `---`
 * (searched within the first `FRONTMATTER_SCAN_LINES` lines). An
 * unterminated opening `---` falls back to the pre-existing behavior —
 * scanning from line 0 — so a note whose real first line is literally
 * `---` isn't mangled.
 */
export function computeDisplayTitle(content: string | null | undefined): string | null {
  if (!content) return null;
  const lines = content.split("\n");
  const startIndex = skipLeadingFrontmatter(lines);
  for (let i = startIndex; i < lines.length; i++) {
    const stripped = lines[i]!.replace(/^#{1,6}\s*/, "").trim();
    if (stripped === "") continue;
    // Iterate by Unicode code points so we don't split surrogate pairs mid-character.
    const codePoints = Array.from(stripped);
    return codePoints.length > DISPLAY_TITLE_MAX_LEN
      ? codePoints.slice(0, DISPLAY_TITLE_MAX_LEN).join("")
      : stripped;
  }
  return null;
}
