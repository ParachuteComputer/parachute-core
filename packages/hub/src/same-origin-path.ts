/**
 * The one rule for "may the hub send a browser here?" (T-476): a path on this hub, never another origin.
 *
 * A single-slash root-relative path, of visible ASCII only, that a browser's URL parser resolves to this origin with a
 * path that doesn't start with `//`. The parse is what decides, because it does what the browser does:
 * - a backslash is read as `/`, so `/\host` is `//host` (one in the query stays put, so an OAuth `state` holding one
 *   still resumes);
 * - tab and newlines are stripped, so `/<tab>/host` is `//host`;
 * - dot segments collapse, so `/.//host` and `/%2e//host` are `//host` for a caller that re-emits the parsed path.
 * The character check is for the header the raw value goes into: CR/LF would split it, and spaces, other control
 * characters and non-ASCII can't be carried (percent-encode them).
 *
 * Used by every redirect target taken from a request: sign-in and change-password `next` (`safeNext`), the return-to
 * gates (`isSafeHubReturnTo`), the operator's `/` redirect (`isSafeRedirectPath`) and the admin app's approve page.
 * Don't write the check again elsewhere.
 */
export function isSameOriginPath(value: string | null | undefined): value is string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c > 0x7e) return false;
  }
  const base = "http://parachute.invalid";
  try {
    const u = new URL(value, base);
    return u.origin === base && !u.pathname.startsWith("//");
  } catch {
    return false;
  }
}
