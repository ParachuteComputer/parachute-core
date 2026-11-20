// `docs` (T-476): the docs site's pages, handed to an agent as markdown. The network is faked (the site is outside
// this repo); everything else runs as the doors run it.
import { describe, expect, test } from "bun:test";
import { buildDocsTool, docsOriginFromEnv } from "./docs-tool.ts";
import { projectionToMarkdown, type VaultProjection } from "./vault-projection.ts";

const SITE: Record<string, string> = {
  "/llms.txt": "# Parachute\n\n- [Make an applet](https://parachute.computer/docs/build/make-an-applet.md)\n",
  "/docs/build/make-an-applet.md": "# Make an applet\n\nAn applet is one record.\n",
};

function site(pages = SITE) {
  const asked: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    asked.push(u.pathname);
    expect(init?.redirect).toBe("manual");
    const body = pages[u.pathname];
    return body === undefined ? new Response("not here", { status: 404 }) : new Response(body, { headers: { "content-type": "text/markdown" } });
  }) as typeof fetch;
  return { f, asked };
}

describe("docs tool", () => {
  test("no topic: the index; a topic: its page, with the address a person opens", async () => {
    const { f } = site();
    const tool = buildDocsTool({ origin: "https://docs.example/", fetch: f, cache: new Map() });
    expect(tool.requiredVerb).toBe("read");
    const index = (await tool.execute({})) as { markdown: string; index: string };
    expect(index.markdown).toContain("Make an applet");
    expect(index.index).toBe("https://docs.example/llms.txt");
    const page = (await tool.execute({ topic: "build/make-an-applet" })) as { markdown: string; page: string };
    expect(page.markdown).toStartWith("# Make an applet");
    expect(page.page).toBe("https://docs.example/docs/build/make-an-applet/");
    // what the model reads: the markdown itself, unescaped, then the address
    const [block] = tool.resultContent!(page) as { type: string; text: string }[];
    expect(block.text).toBe("# Make an applet\n\nAn applet is one record.\n\n(For a person: https://docs.example/docs/build/make-an-applet/)");
  });

  test("a topic written as a path or a .md address finds the same page", async () => {
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: site().f, cache: new Map() });
    // as written in the index (llms.txt lists parachute.computer addresses, whatever origin serves the pages)
    for (const t of ["/docs/build/make-an-applet.md", "Build/Make-An-Applet/", "docs/build/make-an-applet", "https://docs.example/docs/build/make-an-applet.md", "https://parachute.computer/docs/build/make-an-applet.md", "https://parachute.computer/docs/build/make-an-applet/"]) {
      expect(((await tool.execute({ topic: t })) as { topic: string }).topic).toBe("build/make-an-applet");
    }
  });

  test("a topic that isn't a page name never reaches the network", async () => {
    const { f, asked } = site();
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() });
    for (const t of ["../secrets", "build/../../x", "a b", "x?y=1", "//evil.example/x", "%2e%2e/x", "a/b/c/d/e", "https://evil.example/docs/build/x.md", "https://parachute.computer.evil.example/docs/x.md"]) {
      await expect(tool.execute({ topic: t })).rejects.toMatchObject({ error_type: "invalid_topic" });
    }
    expect(asked).toEqual([]);
  });

  test("an unknown page says so and points at the list", async () => {
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: site().f, cache: new Map() });
    await expect(tool.execute({ topic: "build/nothing-here" })).rejects.toMatchObject({ error_type: "unknown_topic", hint: "call docs {} for the list of pages" });
  });

  test("a site that can't be reached is a refusal naming the address, not an empty page", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: down, cache: new Map() });
    await expect(tool.execute({ topic: "build/make-an-applet" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })) as unknown as typeof fetch;
    await expect(buildDocsTool({ origin: "https://docs.example", fetch: redirect, cache: new Map() }).execute({ topic: "x" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
  });

  test("a page is read once an hour, and a huge one is cut with its address", async () => {
    const { f, asked } = site({ ...SITE, "/docs/big.md": "x".repeat(300 * 1024) });
    let t = 0;
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: f, now: () => t, cache: new Map() });
    await tool.execute({ topic: "build/make-an-applet" });
    await tool.execute({ topic: "build/make-an-applet" });
    expect(asked).toEqual(["/docs/build/make-an-applet.md"]);
    t = 61 * 60 * 1000;
    await tool.execute({ topic: "build/make-an-applet" });
    expect(asked.length).toBe(2);
    const big = (await tool.execute({ topic: "big" })) as { markdown: string };
    expect(big.markdown.length).toBeLessThan(210 * 1024);
    expect(big.markdown).toContain("whole page is at https://docs.example/docs/big.md");
  });
});

describe("docs between sessions and from the environment", () => {
  test("a door builds its tools per request: the pages are kept across tools, not per tool", async () => {
    const { f, asked } = site();
    // the default store (an origin no other test uses)
    await buildDocsTool({ origin: "https://shared.example", fetch: f }).execute({ topic: "build/make-an-applet" });
    await buildDocsTool({ origin: "https://shared.example", fetch: f }).execute({ topic: "build/make-an-applet" });
    expect(asked).toEqual(["/docs/build/make-an-applet.md"]);
  });
  test("a body that breaks mid-read is a docs_unreachable refusal; a huge one is read only to the cut", async () => {
    let pulled = 0;
    const endless = (async () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); } }))) as unknown as typeof fetch;
    const big = (await buildDocsTool({ origin: "https://docs.example", fetch: endless, cache: new Map() }).execute({ topic: "x" })) as { markdown: string };
    expect(big.markdown).toContain("Cut at 200 KB");
    expect(pulled).toBeLessThan(10);
    const broken = (async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")); } }))) as unknown as typeof fetch;
    await expect(buildDocsTool({ origin: "https://docs.example", fetch: broken, cache: new Map() }).execute({ topic: "x" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
  });
  test("a cut never ends in half a character", async () => {
    const page = "é".repeat(150 * 1024); // two bytes each: the 200 KB cut falls inside one, at an odd byte
    const f = (async () => new Response("a" + page.slice(0, 102401))) as unknown as typeof fetch;
    const r = (await buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() }).execute({ topic: "x" })) as { markdown: string };
    expect(r.markdown).not.toContain("\uFFFD");
  });
  test("PARACHUTE_DOCS_URL: an origin, off in any of its spellings, or the default", () => {
    expect(docsOriginFromEnv(undefined)).toBe("https://parachute.computer");
    expect(docsOriginFromEnv("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    for (const off of ["off", "OFF", "false", "0", "none"]) expect(docsOriginFromEnv(off)).toBeNull();
    expect(docsOriginFromEnv("https://preview.example/docs-site")).toBe("https://parachute.computer");
  });
});

describe("the server instructions point at the docs, not at notes in the vault", () => {
  const projection: VaultProjection = { tags: [], indexed_fields: [], query_hints: [], map: { total: 0, tags: [], paths: [] } } as unknown as VaultProjection;
  test("by default they name the docs tool and parachute.computer", () => {
    const md = projectionToMarkdown({ vaultName: "home", description: null, projection });
    expect(md).toContain("## How to do things in Parachute");
    expect(md).toContain("`docs { topic }`");
    // an AI learns applets exist, and where to read how (T-476 audit: 0 mentions of "applet" before)
    expect(md).toContain("**applets**");
    expect(md).toContain('docs { topic: "build/make-an-applet" }');
    expect(md).toContain("https://parachute.computer/llms.txt");
    expect(md).not.toContain("Getting Started");
  });
  test("a door's own docs origin, or none", () => {
    expect(projectionToMarkdown({ vaultName: "home", description: null, projection, docs: "http://127.0.0.1:8080" })).toContain("http://127.0.0.1:8080/llms.txt");
    expect(projectionToMarkdown({ vaultName: "home", description: null, projection, docs: null })).not.toContain("How to do things");
  });
});
