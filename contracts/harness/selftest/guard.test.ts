// Self-tests for the harness's safety promises. These are unit tests on purpose: the logic is a security check.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowOrigins, safeFetch } from "../guard.ts";

// "outside" stands in for the live hub: nothing the suite does may reach it.
let outsideHits = 0;
const outside = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (outsideHits++, new Response("live!")) });
const throwaway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/bounce") return Response.redirect(`http://127.0.0.1:${outside.port}/token`, 307);
    return new Response("ok");
  },
});
allowOrigins(`http://127.0.0.1:${throwaway.port}`);
afterAll(() => {
  outside.stop(true);
  throwaway.stop(true);
});

describe("guarded fetch", () => {
  test("a redirect to another origin is returned, not followed", async () => {
    outsideHits = 0;
    const r = await safeFetch(`http://127.0.0.1:${throwaway.port}/bounce`, { method: "POST", body: "code=secret" });
    expect(r.status).toBe(307);
    expect(outsideHits).toBe(0);
    // Following the Location by hand goes through the guard again and is refused.
    await expect(safeFetch(r.headers.get("location")!)).rejects.toThrow(/not a throwaway service/);
    expect(outsideHits).toBe(0);
  });

  test("plain fetch would have followed it (why the guard exists)", async () => {
    outsideHits = 0;
    await fetch(`http://127.0.0.1:${throwaway.port}/bounce`, { method: "POST", body: "code=secret" });
    expect(outsideHits).toBe(1);
  });

  test("the live install's ports are refused even if registered", async () => {
    allowOrigins("http://127.0.0.1:1939");
    await expect(safeFetch("http://127.0.0.1:1939/health")).rejects.toThrow(/live Parachute port/);
    await expect(safeFetch("http://127.0.0.1:1940/health")).rejects.toThrow(/live Parachute port/);
  });

  test("no contract or harness file calls fetch() directly", () => {
    const root = resolve(import.meta.dir, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("guard.ts") && !p.includes("selftest")) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              // Any call of something named fetch (fetch(, globalThis.fetch(, Bun.fetch (...) except safeFetch.
              if (/(^|[^\w])fetch\s*\(/.test(line.replace(/safeFetch/g, "")) && !line.trim().startsWith("//"))
                offenders.push(`${p}:${i + 1}`);
            });
        }
      }
    };
    walk(join(root, "suites"));
    walk(join(root, "harness"));
    expect(offenders).toEqual([]);
  });
});
