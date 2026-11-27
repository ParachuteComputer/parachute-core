// `docs` (T-476): the docs site's pages, handed to an agent as markdown. The network is faked (the site is outside
// this repo); everything else runs as the doors run it.
import { describe, expect, test } from "bun:test";
import { buildDocsTool, compareVersions, docsBriefLine, docsMinor, docsOrigin, docsOriginFromEnv, docsPageUrl, forgetLatestRelease, latestRelease, newerRelease, OFFLINE_PAGES, REFUSAL_DOCS, withRefusalDocs, withWarningDocs } from "./docs-tool.ts";
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
    await expect(tool.execute({ topic: "build/nothing-here" })).rejects.toMatchObject({ error_type: "unknown_topic", hint: 'docs {search: "<words>"} finds a page; docs {} lists them' });
  });

  test("a site that can't be reached is a refusal naming the address, not an empty page (for a page with no offline copy)", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: down, cache: new Map() });
    await expect(tool.execute({ topic: "build/components" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
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
    expect(docsOriginFromEnv("")).toBe("https://parachute.computer");
    expect(docsOriginFromEnv("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    for (const off of ["off", "OFF", "false", "0", "none"]) expect(docsOriginFromEnv(off)).toBeNull();
    // a self-hoster's copy may live under a path; a query or a non-http address isn't an origin
    expect(docsOriginFromEnv("https://preview.example/docs-site/")).toBe("https://preview.example/docs-site");
    expect(docsOriginFromEnv("https://preview.example/?x=1")).toBe("https://parachute.computer");
    expect(docsOriginFromEnv("ftp://preview.example")).toBe("https://parachute.computer");
  });
});

describe("the server instructions name the docs tool and the version", () => {
  const projection: VaultProjection = { tags: [], indexed_fields: [], query_hints: [], map: { total: 0, tags: [], paths: [] } } as unknown as VaultProjection;
  test("a line under the vault's name: the version, a newer release when there is one, the tool, and where a refusal's fix is", () => {
    const md = projectionToMarkdown({ vaultName: "home", description: null, projection, docs: { origin: "https://parachute.computer", version: "0.9.0-pre.2", newer: "0.9.1" } });
    expect(md).toStartWith('You are connected to Parachute Vault "home".\nDocs for Parachute 0.9.0-pre.2 (0.9.1 is out): `docs {search}`, `docs {topic}`; a refusal\'s `docs` is its fix page.\n');
    // the scripting guide is the docs page now, not the retired /scripting/
    expect(md).toContain("https://parachute.computer/docs/build/scripts/");
  });
  test("a self-hoster's own docs are named by their address; no newer release, no aside; no docs, no section", () => {
    const own = projectionToMarkdown({ vaultName: "home", description: null, projection, docs: { origin: "https://docs.example.org/parachute/", version: "0.9.1" } });
    expect(own).toContain("Docs for Parachute 0.9.1, from docs.example.org/parachute: `docs {search}`");
    expect(projectionToMarkdown({ vaultName: "home", description: null, projection, docs: null })).not.toContain("`docs {search}`");
    expect(projectionToMarkdown({ vaultName: "home", description: null, projection })).not.toContain("`docs {search}`");
  });
});

describe("when the site is down", () => {
  test("a page read before is served from its last copy, however old", async () => {
    let up = true;
    let t = 0;
    const f = (async () => { if (!up) throw new Error("offline"); return new Response("# Page"); }) as unknown as typeof fetch;
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: f, now: () => t, cache: new Map() });
    await tool.execute({ topic: "x" });
    up = false;
    t = 5 * 60 * 60 * 1000;
    expect(((await tool.execute({ topic: "x" })) as { markdown: string }).markdown).toBe("# Page");
    await expect(tool.execute({ topic: "never-read" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
  });

  test("a fix page never read comes from the offline copy, said as such; the list too", async () => {
    const down = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    const tool = buildDocsTool({ origin: "https://docs.example", version: "0.9.0-pre.2", fetch: down, cache: new Map() });
    const r = (await tool.execute({ topic: "fix/needs-admin" })) as { markdown: string; note: string; page: string };
    expect(r.markdown).toStartWith("# Needs admin");
    expect(r.markdown).toContain("end this AI's connection in the vault's list of who reaches it, connect it again, and tick the level");
    expect(r.note).toBe("Offline copy: https://docs.example/docs/v/0.9/fix/needs-admin/ couldn't be read (getaddrinfo ENOTFOUND).");
    const [block] = tool.resultContent!(r) as { text: string }[];
    expect(block.text).toStartWith("(Offline copy: ");
    const list = (await tool.execute({})) as { markdown: string; note: string };
    expect(list.markdown).toContain("- `fix/needs-admin`: Needs admin (or write).");
    expect(list.note).toStartWith("Offline copy: https://docs.example/llms.txt");
    // a search still finds the fix page
    expect(((await tool.execute({ search: "needs admin" })) as { markdown: string }).markdown).toStartWith("- `fix/needs-admin`");
  });

  test("a site that has no fix pages yet (404): the built-in copy, said so; an older site's list naming no docs pages: the built-in list", async () => {
    const old = site({ "/llms.txt": "# Parachute\n\n- [Vault](https://parachute.computer/vault/): the old picture\n" });
    const tool = buildDocsTool({ origin: "https://docs.example", version: "0.9.0-pre.2", fetch: old.f, cache: new Map() });
    const r = (await tool.execute({ topic: "fix/unknown-type" })) as { markdown: string; note: string };
    expect(r.markdown).toStartWith("# A type that isn't there");
    expect(r.note).toBe("The site has no page at https://docs.example/docs/v/0.9/fix/unknown-type/; this is the copy built into Parachute 0.9.0-pre.2.");
    const list = (await tool.execute({})) as { markdown: string; note: string };
    expect(list.markdown).toContain("- `fix/unknown-type`");
    expect(list.note).toBe("https://docs.example/llms.txt names no docs pages; these are the ones built into Parachute 0.9.0-pre.2.");
    await expect(tool.execute({ topic: "build/nothing" })).rejects.toMatchObject({ error_type: "unknown_topic" });
  });

  test("an HTML page answered with 200 (a host's single-page fallback) is no page, not the markdown", async () => {
    const shell = (async () => new Response("<!doctype html><title>Parachute</title>", { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: shell, cache: new Map() });
    expect(((await tool.execute({ topic: "fix/conflict" })) as { markdown: string }).markdown).toStartWith("# Changed by someone else first");
    await expect(tool.execute({ topic: "build/components" })).rejects.toMatchObject({ error_type: "unknown_topic" });
  });

    test("a redirect is followed by hand on the docs' own host (http to https), never off it, never down to http", async () => {
    const asked: string[] = [];
    const host = (routes: Record<string, string>) =>
      (async (url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        asked.push(String(url));
        const to = routes[String(url)];
        return to ? new Response(null, { status: 301, headers: { location: to } }) : new Response("# Moved here", { headers: { "content-type": "text/markdown" } });
      }) as unknown as typeof fetch;
    const up = host({ "http://docs.example/docs/build/x.md": "https://docs.example/docs/build/x.md" });
    expect(((await buildDocsTool({ origin: "http://docs.example", fetch: up, cache: new Map() }).execute({ topic: "build/x" })) as { markdown: string }).markdown).toBe("# Moved here");
    asked.length = 0;
    const off = host({ "https://docs.example/docs/build/x.md": "https://elsewhere.example/docs/x.md" });
    await expect(buildDocsTool({ origin: "https://docs.example", fetch: off, cache: new Map() }).execute({ topic: "build/x" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
    expect(asked).toEqual(["https://docs.example/docs/build/x.md"]); // nothing requested off the docs host
    const down = host({ "https://docs.example/docs/build/x.md": "http://docs.example/docs/build/x.md" });
    await expect(buildDocsTool({ origin: "https://docs.example", fetch: down, cache: new Map() }).execute({ topic: "build/x" })).rejects.toMatchObject({ error_type: "docs_unreachable" });
    // a fix page has its built-in copy instead
    const allOff = host({ "https://docs.example/docs/fix/conflict.md": "https://elsewhere.example/x.md" });
    expect(((await buildDocsTool({ origin: "https://docs.example", fetch: allOff, cache: new Map() }).execute({ topic: "fix/conflict" })) as { note: string }).note).toContain("it answered 301");
  });

  test("an explicit heading id with an underscore is a section too", async () => {
    const f = (async () => new Response("# Conflicts\n\n## Write without a precondition {#precondition_required}\n\nPass if_updated_at.\n\n## Next\n\nx\n")) as unknown as typeof fetch;
    const r = (await buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() }).execute({ topic: "fix/conflict#precondition_required" })) as { markdown: string };
    expect(r.markdown).toBe("## Write without a precondition {#precondition_required}\n\nPass if_updated_at.");
  });

  test("a 5xx is the site down, not a missing page: the offline copy, never 'no page'", async () => {
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch, cache: new Map() });
    expect(((await tool.execute({ topic: "fix/conflict" })) as { note: string }).note).toContain("(it answered 502)");
  });
});

describe("the pages for the version this vault runs", () => {
  const PAGES: Record<string, string> = {
    "/docs/v/0.9/fix/needs-admin.md": "# Needs admin\n\nFor 0.9.\n\n## Grant admin\n\nTick admin.\n\n### On Cloud\n\nSettings.\n\n## Keys\n\nKeys page.\n",
    "/docs/fix/needs-admin.md": "# Needs admin\n\nThe latest.\n",
    "/docs/build/make-a-type.md": "# Make a type\n\nLatest only.\n",
  };
  test("this version's page first; the latest when the site has none for it, said so", async () => {
    const { f, asked } = site(PAGES);
    const tool = buildDocsTool({ origin: "https://docs.example", version: "0.9.0-pre.2", fetch: f, cache: new Map() });
    const v = (await tool.execute({ topic: "fix/needs-admin" })) as { markdown: string; page: string; note?: string };
    expect(v.markdown).toContain("For 0.9.");
    expect(v.page).toBe("https://docs.example/docs/v/0.9/fix/needs-admin/");
    expect(v.note).toBeUndefined();
    const latest = (await tool.execute({ topic: "build/make-a-type" })) as { markdown: string; page: string; note: string };
    expect(latest.markdown).toContain("Latest only.");
    expect(latest.page).toBe("https://docs.example/docs/build/make-a-type/");
    expect(latest.note).toBe("The site has no 0.9 pages; this is the latest page (you run 0.9.0-pre.2).");
    expect(asked).toEqual(["/docs/v/0.9/fix/needs-admin.md", "/docs/v/0.9/build/make-a-type.md", "/docs/build/make-a-type.md"]);
    // no version given: the latest, with no note
    const plain = (await buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() }).execute({ topic: "fix/needs-admin" })) as { markdown: string; note?: string };
    expect(plain.markdown).toContain("The latest.");
    expect(plain.note).toBeUndefined();
  });

  test("a refusal's docs address works as the topic, and names its own version", async () => {
    const { f } = site(PAGES);
    const tool = buildDocsTool({ origin: "https://docs.example", version: "1.2.0", fetch: f, cache: new Map() });
    const r = (await tool.execute({ topic: "https://docs.example/docs/v/0.9/fix/needs-admin/" })) as { topic: string; markdown: string };
    expect(r.topic).toBe("fix/needs-admin");
    expect(r.markdown).toContain("For 0.9.");
  });

  test("#anchor: only that section, down to the next heading as high", async () => {
    const tool = buildDocsTool({ origin: "https://docs.example", version: "0.9.1", fetch: site(PAGES).f, cache: new Map() });
    const r = (await tool.execute({ topic: "fix/needs-admin#grant-admin" })) as { markdown: string; page: string };
    expect(r.markdown).toBe("## Grant admin\n\nTick admin.\n\n### On Cloud\n\nSettings.");
    expect(r.page).toBe("https://docs.example/docs/v/0.9/fix/needs-admin/#grant-admin");
    // an anchor the page doesn't have: the whole page, said so, at the page's own address
    const whole = (await tool.execute({ topic: "fix/needs-admin#nope" })) as { markdown: string; note: string; page: string };
    expect(whole.markdown).toStartWith("# Needs admin");
    expect(whole.note).toBe('No section "#nope" on this page; here is all of it.');
    expect(whole.page).toBe("https://docs.example/docs/v/0.9/fix/needs-admin/");
    await expect(tool.execute({ topic: "fix/needs-admin#../x" })).rejects.toMatchObject({ error_type: "invalid_topic" });
    // the site's own anchors: an error_type as a heading, and a heading with an apostrophe
    const conflict = buildDocsTool({ origin: "https://docs.example", version: "0.9.1", fetch: site({ "/docs/v/0.9/fix/conflict.md": "# It changed\n\n## conflict\n\nRe-read.\n\n## precondition_required\n\nPass if_updated_at.\n\n## A tool it can't see\n\nLevels.\n" }).f, cache: new Map() });
    expect(((await conflict.execute({ topic: "https://docs.example/docs/v/0.9/fix/conflict/#precondition_required" })) as { markdown: string }).markdown).toBe("## precondition_required\n\nPass if_updated_at.");
    expect(((await conflict.execute({ topic: "fix/conflict#a-tool-it-cant-see" })) as { markdown: string }).markdown).toBe("## A tool it can't see\n\nLevels.");
  });
});

describe("search", () => {
  const INDEX = JSON.stringify({
    latest: "0.9",
    pages: [
      { topic: "build/keys-and-scopes", title: "Keys and what they reach", summary: "Read, write or admin.", headings: ["Levels", "Grant admin"] },
      { topic: "build/make-a-type", title: "Make a type", summary: "A type names a kind of record.", headings: ["Fields"] },
      { topic: "fix/file-too-large", title: "A file too large", summary: "Use the upload URL.", headings: [] },
    ],
  });
  test("index.json's titles, topics, headings and lines, best first; an error_type finds its fix page first", async () => {
    const { f } = site({ "/docs/index.json": INDEX });
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() });
    const admin = (await tool.execute({ search: "how do I grant admin" })) as { markdown: string };
    expect(admin.markdown).toStartWith("- `build/keys-and-scopes`: Keys and what they reach. Read, write or admin.");
    expect(admin.markdown).toContain('Read one with docs { topic: "<name>" }.');
    const types = (await tool.execute({ search: "types" })) as { markdown: string };
    expect(types.markdown).toStartWith("- `build/make-a-type`");
    expect(((await tool.execute({ search: "inline_too_large" })) as { markdown: string }).markdown).toStartWith("- `fix/file-too-large`");
    expect(((await tool.execute({ search: "zebra" })) as { markdown: string }).markdown).toBe('No page matches "zebra". docs {} lists every page.');
  });
  test("no index.json: llms.txt's list", async () => {
    const { f, asked } = site();
    const tool = buildDocsTool({ origin: "https://docs.example", fetch: f, cache: new Map() });
    expect(((await tool.execute({ search: "applet" })) as { markdown: string }).markdown).toStartWith("- `build/make-an-applet`: Make an applet.");
    expect(asked).toEqual(["/docs/index.json", "/llms.txt"]);
  });
});

describe("refusals and warnings point at their fix", () => {
  const ctx = { origin: "https://parachute.computer", version: "0.9.0-pre.2" };
  const refused = (error_type: string) => {
    const sc = { error_type, message: "no", hint: "h" };
    return { content: [{ type: "text", text: JSON.stringify(sc, null, 2) }], structuredContent: sc, isError: true as const };
  };
  test("every refusal gains docs, this version's fix page; the text block still equals structuredContent", () => {
    const r = withRefusalDocs(refused("insufficient_scope"), ctx);
    expect(r.structuredContent).toEqual({ error_type: "insufficient_scope", message: "no", hint: "h", docs: "https://parachute.computer/docs/v/0.9/fix/needs-admin/#what-the-refusal-says" });
    expect(JSON.parse(r.content[0]!.text as string)).toEqual(r.structuredContent);
    // one with no page of its own goes to the page that lists them all
    expect(withRefusalDocs(refused("batch_too_large"), ctx).structuredContent!.docs).toBe("https://parachute.computer/docs/v/0.9/fix/refusals/#a-call-thats-not-right");
    // one the map doesn't name goes to the page that lists them all
    expect(withRefusalDocs(refused("history_unrecoverable"), ctx).structuredContent!.docs).toBe("https://parachute.computer/docs/v/0.9/fix/refusals/");
  });
  test("a level refusal with no next step of its own gains the person's step; one with a hint keeps its own", () => {
    const bare = { content: [{ type: "text", text: "{}" }], structuredContent: { error_type: "insufficient_scope", message: "needs admin" }, isError: true as const };
    expect(withRefusalDocs(bare, ctx).structuredContent).toEqual({
      error_type: "insufficient_scope",
      message: "needs admin",
      hint: "Only the person can grant it: they end this AI's connection in the vault's list of who reaches it, connect it again, and tick admin on Parachute's approval page (it starts unticked, under \"Grant additional access\"). For a script: a key made with that level.",
      docs: "https://parachute.computer/docs/v/0.9/fix/needs-admin/#what-the-refusal-says",
    });
    expect(withRefusalDocs(refused("insufficient_scope"), ctx).structuredContent!.hint).toBe("h");
    // a tool that isn't listed may be a typo: no admin step for it
    const unknown = { ...bare, structuredContent: { error_type: "unknown_tool", message: "Unknown tool: x" } };
    expect(withRefusalDocs(unknown, ctx).structuredContent!.hint).toBeUndefined();
  });
    test("the three walls: needs admin, a type that isn't there, a file too large", () => {
    expect([REFUSAL_DOCS.unknown_tool, REFUSAL_DOCS.skill_needs_admin, REFUSAL_DOCS.tag_not_found, REFUSAL_DOCS.unknown_tag, REFUSAL_DOCS.inline_too_large, REFUSAL_DOCS.file_too_large]).toEqual(["fix/needs-admin#a-tool-it-cant-see", "fix/needs-admin#skills", "fix/unknown-type#no-type-by-that-name", "fix/unknown-type#no-type-by-that-name", "fix/file-too-large#in-a-chat-with-claude", "fix/file-too-large#the-limits"]);
    // every page the map names has an offline copy
    for (const topic of new Set(Object.values(REFUSAL_DOCS).map((t) => t.split("#")[0]!))) expect({ topic, body: typeof OFFLINE_PAGES[topic]?.body }).toEqual({ topic, body: "string" });
    expect(OFFLINE_PAGES["fix/refusals"]?.body).toBeString();
  });
  test("only the map's own keys: an error_type or code named like an object's own property gets the list page", () => {
    expect(withRefusalDocs(refused("constructor"), ctx).structuredContent!.docs).toBe("https://parachute.computer/docs/v/0.9/fix/refusals/");
    const reply = { warnings: [{ code: "__proto__" }, { code: "toString" }] };
    expect(withWarningDocs(reply, ctx)).toBe(reply);
  });
    test("left alone: a success, docs off, a refusal that already names its docs", () => {
    const ok = { content: [{ type: "text", text: "{}" }] };
    expect(withRefusalDocs(ok, ctx)).toBe(ok);
    const r = refused("conflict");
    expect(withRefusalDocs(r, { origin: null, version: "0.9.0" })).toBe(r);
    const own = { ...r, structuredContent: { ...r.structuredContent, docs: "mine" } };
    expect(withRefusalDocs(own, ctx)).toBe(own);
  });
  test("a warning with a fix page gains docs; others don't", () => {
    const reply = { records: [], warnings: [{ code: "unknown_tag", message: "m", tag: "movie" }, { code: "truncated", field: "x" }] };
    expect(withWarningDocs(reply, ctx)).toEqual({ records: [], warnings: [{ code: "unknown_tag", message: "m", tag: "movie", docs: "https://parachute.computer/docs/v/0.9/fix/unknown-type/#no-type-by-that-name" }, { code: "truncated", field: "x" }] });
    const none = { records: [] };
    expect(withWarningDocs(none, ctx)).toBe(none);
    expect(withWarningDocs(reply, { origin: null, version: "0.9.0" })).toBe(reply);
  });
});

describe("versions", () => {
  test("major.minor of a version, and a page's address for it", () => {
    expect([docsMinor("0.9.0-pre.2"), docsMinor("0.8.0"), docsMinor("v1.10.3"), docsMinor("dev"), docsMinor(undefined)]).toEqual(["0.9", "0.8", "1.10", null, null]);
    expect(docsPageUrl({ origin: "https://d.example/", version: "0.9.1" }, "fix/conflict")).toBe("https://d.example/docs/v/0.9/fix/conflict/");
    expect(docsPageUrl({ origin: "https://d.example" }, "fix/conflict#why")).toBe("https://d.example/docs/fix/conflict/#why");
  });
  test("semver order, prereleases before their release", () => {
    const sorted = ["0.9.0", "0.9.0-pre.10", "0.8.1", "0.9.0-pre.2", "1.0.0", "0.9.0-pre.2.1", "0.9.0-alpha"].sort(compareVersions);
    expect(sorted).toEqual(["0.8.1", "0.9.0-alpha", "0.9.0-pre.2", "0.9.0-pre.2.1", "0.9.0-pre.10", "0.9.0", "1.0.0"]);
  });
  test("a newer release: latest when newer; beta only for someone already on a prerelease", () => {
    expect(newerRelease("0.8.0", { latest: "0.8.1", beta: "0.9.0-pre.3" })).toBe("0.8.1");
    expect(newerRelease("0.8.1", { latest: "0.8.1", beta: "0.9.0-pre.3" })).toBeNull();
    expect(newerRelease("0.9.0-pre.2", { latest: "0.8.1", beta: "0.9.0-pre.3" })).toBe("0.9.0-pre.3");
    expect(newerRelease("0.9.0-pre.2", { latest: "0.9.0", beta: "0.9.0-pre.3" })).toBe("0.9.0");
    expect(newerRelease("0.9.0-pre.3", { latest: "0.8.1", beta: "0.9.0-pre.3" })).toBeNull();
    expect(newerRelease("dev", { latest: "0.8.1" })).toBeNull();
    expect(newerRelease("0.8.0", null)).toBeNull();
  });
  test("/latest.json is read in the background, never waited on, and kept six hours", async () => {
    forgetLatestRelease();
    let t = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = (async (url: string) => {
      calls++;
      expect(url).toBe("https://latest.example/latest.json");
      await gate;
      return new Response(JSON.stringify({ core: { latest: "0.8.1", beta: "0.9.0-pre.3" }, docs: "0.9" }));
    }) as unknown as typeof fetch;
    const first = latestRelease("https://latest.example/", { fetch: f, now: () => t });
    expect(first.value).toBeNull(); // the first connect says nothing, and doesn't wait
    // one read at a time, and its promise only for the caller that started it (a Worker's waitUntil is per request)
    expect(first.refresh).toBeInstanceOf(Promise);
    expect(latestRelease("https://latest.example", { fetch: f, now: () => t })).toEqual({ value: null, refresh: null });
    release();
    await first.refresh;
    expect(latestRelease("https://latest.example", { fetch: f, now: () => t })).toEqual({ value: { latest: "0.8.1", beta: "0.9.0-pre.3" }, refresh: null });
    t = 7 * 60 * 60 * 1000;
    const again = latestRelease("https://latest.example", { fetch: f, now: () => t });
    expect(again.value).toEqual({ latest: "0.8.1", beta: "0.9.0-pre.3" }); // the old answer while the new one is read
    await again.refresh;
    expect(calls).toBe(2);
    // a site that's down or answers junk keeps what was there
    forgetLatestRelease();
    const junk = latestRelease("https://latest.example", { fetch: (async () => new Response("<html>")) as unknown as typeof fetch, now: () => t });
    await junk.refresh;
    expect(latestRelease("https://latest.example", { now: () => t }).value).toBeNull();
    // and is tried again in ten minutes, not six hours
    const good = (async () => new Response(JSON.stringify({ core: { latest: "0.9.1" } }))) as unknown as typeof fetch;
    expect(latestRelease("https://latest.example", { fetch: good, now: () => t + 5 * 60 * 1000 }).refresh).toBeNull();
    await latestRelease("https://latest.example", { fetch: good, now: () => t + 11 * 60 * 1000 }).refresh;
    expect(latestRelease("https://latest.example", { now: () => t + 11 * 60 * 1000 }).value).toEqual({ latest: "0.9.1", beta: undefined });
    forgetLatestRelease();
  });
  test("a read that never settles (a Worker request ended under it) is given up, and the next caller starts another", async () => {
    forgetLatestRelease();
    let t = 0;
    let calls = 0;
    const hang = (async () => {
      calls++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    latestRelease("https://hang.example", { fetch: hang, now: () => t });
    t = 10_000;
    expect(latestRelease("https://hang.example", { fetch: hang, now: () => t }).refresh).toBeNull();
    t = 17_000;
    expect(latestRelease("https://hang.example", { fetch: hang, now: () => t }).refresh).toBeInstanceOf(Promise);
    expect(calls).toBe(2);
    // a fetch that throws at once leaves the entry settled, so the six-hour wait applies, not a stuck read
    forgetLatestRelease();
    const boom = (() => {
      calls++;
      throw new Error("no fetch here");
    }) as unknown as typeof fetch;
    await latestRelease("https://boom.example", { fetch: boom, now: () => t }).refresh;
    expect(latestRelease("https://boom.example", { fetch: boom, now: () => t + 1000 })).toEqual({ value: null, refresh: null });
    forgetLatestRelease();
  });
  test("the brief's line for an origin that isn't a URL still reads", () => {
    expect(docsBriefLine({ origin: "parachute", version: "dev" })).toBe("Docs, from parachute: `docs {search}`, `docs {topic}`; a refusal's `docs` is its fix page.");
  });
  test("docs.base_url from the config; PARACHUTE_DOCS_URL wins; off either way", () => {
    expect(docsOrigin("", "https://docs.example.org/")).toBe("https://docs.example.org");
    expect(docsOrigin("https://env.example", "https://docs.example.org")).toBe("https://env.example");
    expect(docsOrigin("", "off")).toBeNull();
    expect(docsOrigin("off", "https://docs.example.org")).toBeNull();
    expect(docsOrigin("", undefined)).toBe("https://parachute.computer");
  });
});
