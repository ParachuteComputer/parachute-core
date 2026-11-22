// T-476 (security): the one rule for redirect targets taken from a request. Browsers read `\` as `/` in http(s)
// URLs and strip tab and newlines, so each of these is another origin once a browser follows it.
import { describe, expect, test } from "bun:test";
import { safeNext } from "../admin-handlers.ts";
import { isSafeRedirectPath } from "../hub-settings.ts";
import { isSafeHubReturnTo } from "../oauth-handlers.ts";
import { isSameOriginPath } from "../same-origin-path.ts";

const HUB = "https://hub.example";
const offsite = ["/\\evil.example", "/\\\\evil.example", "//evil.example", "/\t/evil.example", "/\r/evil.example", "/\n/evil.example", " //evil.example", "https://evil.example", "javascript:alert(1)", ""];
// Same origin as a raw header, but `//evil.example` once a caller parses the value and re-emits its path.
const reEmitted = ["/.//evil.example/x", "/%2e//evil.example/x"];

describe("isSameOriginPath", () => {
  test("every refused value really is another origin, or no path at all, to a browser's URL parser", () => {
    for (const v of offsite.filter((v) => v.startsWith("/"))) expect(new URL(v, HUB).origin).not.toBe(HUB);
  });
  test("refuses them", () => {
    for (const v of offsite) expect(isSameOriginPath(v)).toBe(false);
    expect(isSameOriginPath(null)).toBe(false);
  });
  test("refuses dot segments that collapse to //host when parsed", () => {
    for (const v of reEmitted) {
      expect(new URL(v, HUB).pathname.startsWith("//")).toBe(true);
      expect(isSameOriginPath(v)).toBe(false);
      expect(isSafeHubReturnTo(v)).toBe(false);
    }
  });
  test("refuses what a Location header can't carry: non-ASCII, spaces", () => {
    for (const v of ["/admin\u2028x", "/\uFF0Fevil", "/ad min", "/admin\u0085"]) expect(isSameOriginPath(v)).toBe(false);
  });
  test("a backslash in the query stays allowed (an OAuth state may hold one)", () => {
    expect(isSameOriginPath("/oauth/authorize?state=a\\b")).toBe(true);
  });
  test("refuses CR/LF even in the query: the raw value goes into a Location header", () => {
    expect(isSameOriginPath("/account/?x=1\r\nSet-Cookie:a=b")).toBe(false);
  });
  test("keeps paths on the hub, including an encoded backslash (it stays a path)", () => {
    for (const v of ["/", "/account/", "/oauth/authorize?client_id=a&state=b", "/%5Cevil.example"]) {
      expect(isSameOriginPath(v)).toBe(true);
      expect(new URL(v, HUB).origin).toBe(HUB);
    }
  });
  test("sign-in's next, the return-to gate and the operator's / redirect all use it", () => {
    for (const v of offsite) {
      expect(safeNext(v)).not.toBe(v);
      expect(isSafeHubReturnTo(v)).toBe(false);
      expect(isSafeRedirectPath(v)).toBe(false);
    }
    expect(safeNext("/account/")).toBe("/account/");
  });
});
