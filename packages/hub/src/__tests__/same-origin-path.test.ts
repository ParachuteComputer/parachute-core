// T-476 (security): the one rule for redirect targets taken from a request. Browsers read `\` as `/` in http(s)
// URLs and strip tab and newlines, so each of these is another origin once a browser follows it.
import { describe, expect, test } from "bun:test";
import { safeNext } from "../admin-handlers.ts";
import { isSafeHubReturnTo } from "../oauth-handlers.ts";
import { isSameOriginPath } from "../same-origin-path.ts";

const HUB = "https://hub.example";
const offsite = ["/\\evil.example", "/\\\\evil.example", "//evil.example", "/\t/evil.example", "/\r/evil.example", "/\n/evil.example", "https://evil.example", "javascript:alert(1)", ""];

describe("isSameOriginPath", () => {
  test("every refused value really is another origin, or no path at all, to a browser's URL parser", () => {
    for (const v of offsite.filter((v) => v.startsWith("/"))) expect(new URL(v, HUB).origin).not.toBe(HUB);
  });
  test("refuses them", () => {
    for (const v of offsite) expect(isSameOriginPath(v)).toBe(false);
    expect(isSameOriginPath(null)).toBe(false);
  });
  test("keeps paths on the hub, including an encoded backslash (it stays a path)", () => {
    for (const v of ["/", "/account/", "/oauth/authorize?client_id=a&state=b", "/%5Cevil.example"]) {
      expect(isSameOriginPath(v)).toBe(true);
      expect(new URL(v, HUB).origin).toBe(HUB);
    }
  });
  test("sign-in's next and the return-to gate both use it", () => {
    for (const v of offsite) {
      expect(safeNext(v)).not.toBe(v);
      expect(isSafeHubReturnTo(v)).toBe(false);
    }
    expect(safeNext("/account/")).toBe("/account/");
  });
});
