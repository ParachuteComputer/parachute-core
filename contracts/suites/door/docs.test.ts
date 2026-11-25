// An AI on any door knows where Parachute's docs are, for the version it is talking to, and where a refusal's fix is
// (T-476; Aaron, 11-25: an agent "using parachute to really know effectively how to find the parachute docs … thinking
// about what version number is calling it"). The brief names the `docs` tool and the version; the tool answers a fix
// page and a search; a refusal's `docs` address works as its topic.
//
// These runs have no network (the candidate's sandbox), so the pages come from the copy built into Parachute: the same
// words the site's fix pages start with. A run with the network reads the site instead; the checks hold either way.
import { describe, expect, test } from "bun:test";
import { door, fp, mcp, token } from "./_door.ts";

const is09 = door().release.startsWith("0.9");
const text = (r: any) => (r?.content ?? []).map((b: any) => b.text ?? "").join("");

describe.skipIf(!is09)("docs: where the fix is, for this version", () => {
  test("the brief names the docs tool and the version this door runs", async () => {
    const c = await mcp("read");
    try {
      const brief = c.client.getInstructions() ?? "";
      expect(brief).toContain("## Docs");
      expect(brief).toMatch(/Parachute \d+\.\d+\.\d+(-[0-9A-Za-z.]+)?( \(\S+ is out\))?\. `docs \{search\}` or `docs \{topic\}` reads \S+'s pages for this version; a refusal's `docs` names the page with its fix\./);
      fp("docs/brief-line", brief.split("\n").filter((l) => l.includes("`docs {search}`")).map((l) => l.replace(/Parachute \S+( \(\S+ is out\))?\./, "Parachute <version>.")));
    } finally {
      await c.close();
    }
  });

  test("a reader, refused a write, follows the refusal's docs to the page that says who can fix it and how", async () => {
    const c = await mcp("read");
    try {
      const r: any = await c.client.callTool({ name: "create-record", arguments: { path: "docs-contract/x", body: "x" } });
      expect(r.isError).toBe(true);
      const refusal = r.structuredContent;
      expect(refusal.error_type).toBe("unknown_tool");
      expect(refusal.docs).toMatch(/\/fix\/needs-admin\/#a-tool-it-cant-see$/);
      // the address, as given, is a topic the tool takes
      const page: any = await c.client.callTool({ name: "docs", arguments: { topic: refusal.docs } });
      expect(page.isError).toBeFalsy();
      const words = text(page);
      expect(words).toMatch(/admin/i);
      expect(words).toMatch(/read, write|read; write|level/i);
      expect(words).toContain(`(For a person: ${refusal.docs})`);
    } finally {
      await c.close();
    }
  });

  test("a search finds the fix page for each of the three walls", async () => {
    const c = await mcp("write");
    try {
      for (const [q, topic] of [["needs admin", "fix/needs-admin"], ["file too large", "fix/file-too-large"], ["tag_not_found", "fix/unknown-type"]] as const) {
        const r: any = await c.client.callTool({ name: "docs", arguments: { search: q } });
        expect({ q, isError: !!r.isError }).toEqual({ q, isError: false });
        expect({ q, found: text(r).includes(`\`${topic}\``) }).toEqual({ q, found: true });
      }
    } finally {
      await c.close();
    }
  });

  test("a type that isn't there: the refusal and the empty list's warning both point at the same page", async () => {
    const c = await mcp("write");
    try {
      const refused = await c.refused("list-types", { name: "docs-contract-no-such-type" });
      expect(refused?.error_type).toBe("tag_not_found");
      expect(refused.docs).toMatch(/\/fix\/unknown-type\/#no-type-by-that-name$/);
      const listed: any = await c.call("query-records", { type: "docs-contract-no-such-type" });
      const warning = (listed.warnings ?? []).find((w: any) => w.code === "unknown_tag");
      expect(warning?.docs).toBe(refused.docs);
    } finally {
      await c.close();
    }
  });

  test("a topic that isn't a page name is refused before anything leaves the server", async () => {
    const bearer = await token("read");
    const c = await mcp("read", { bearer });
    try {
      for (const topic of ["../etc/passwd", "//evil.example/x", "fix/needs-admin?x=1"]) {
        const r = await c.refused("docs", { topic });
        expect({ topic, type: r?.error_type }).toEqual({ topic, type: "invalid_topic" });
      }
    } finally {
      await c.close();
    }
  });
});
