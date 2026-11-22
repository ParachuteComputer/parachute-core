/**
 * The one rule for "may the hub send a browser here?" (T-476): a path on this hub, never another origin.
 *
 * A single-slash root-relative path. Refused: anything not starting with `/`; `//host` (scheme-relative); any
 * backslash, because browsers read `\` as `/` in http(s) URLs, so `/\host` is `//host`; and any control character
 * (tab, CR, LF and the rest of C0, and DEL), because browsers strip tab and newlines from URLs, so `/<tab>/host` is
 * `//host`, and CR/LF would split a Location header.
 *
 * Every redirect target that comes from a request uses this: sign-in and change-password `next` (`safeNext`), the
 * hub's `return_to` gates (`isSafeHubReturnTo`). Don't write the check again elsewhere.
 */
export function isSameOriginPath(value: string | null | undefined): value is string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}
