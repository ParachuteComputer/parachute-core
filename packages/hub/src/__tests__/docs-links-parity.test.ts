/**
 * The account door's `docs` on a refusal is a copy of the vault door's (../docs-links.ts says why). Both build the same
 * links here and must answer the same bytes. A test-only reach into the vault's source: tests run in the monorepo.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as hub from "../docs-links.ts";

const VAULT_COPY = join(import.meta.dir, "../../../vault/core/src/docs-tool.ts");
const vault: typeof hub | null = existsSync(VAULT_COPY) ? await import(VAULT_COPY) : null;

const refused = (error_type: string, extra: Record<string, unknown> = {}) => {
  const sc = { error_type, message: "no", ...extra };
  return { content: [{ type: "text", text: JSON.stringify(sc, null, 2) }], structuredContent: sc, isError: true as const };
};
const ctx = { origin: "https://docs.example/x/", version: "0.9.0-pre.2" };

const cases: Array<[string, (m: typeof hub) => unknown]> = [
  ["the map", (m) => m.REFUSAL_DOCS],
  ["an unknown tool", (m) => m.withRefusalDocs(refused("unknown_tool", { tool: "manage-keys" }), ctx)],
  ["a type with no page of its own", (m) => m.withRefusalDocs(refused("no_vault"), ctx)],
  ["a type named like an object's own property", (m) => m.withRefusalDocs(refused("constructor"), ctx)],
  ["a level refusal with no hint", (m) => m.withRefusalDocs({ content: [{ type: "text", text: "{}" }], structuredContent: { error_type: "insufficient_scope", message: "m" }, isError: true }, ctx)],
  ["the person's steps", (m) => m.PERSON_STEPS],
  ["docs off", (m) => m.withRefusalDocs(refused("unknown_tool"), { origin: null, version: "0.9.0" })],
  ["not a refusal", (m) => m.withRefusalDocs({ content: [{ type: "text", text: "{}" }] }, ctx)],
  ["a version that isn't one", (m) => m.docsPageUrl({ origin: "https://d.example", version: "dev" }, "fix/conflict")],
  ["the origin: env, config, off, junk", (m) => [m.docsOrigin(undefined, undefined), m.docsOrigin("https://a.example/", "https://b.example"), m.docsOrigin(undefined, "https://b.example/docs/"), m.docsOrigin(undefined, "off"), m.docsOrigin("OFF", "https://b.example")]],
];

describe.skipIf(!vault)("account door docs links = vault door docs links", () => {
  for (const [name, build] of cases) test(name, () => expect(build(hub)).toEqual(build(vault!)));
  test("docs.base_url: the hub reads the vault's config.yaml as the vault does", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "docs-links-"));
    const saved = process.env.PARACHUTE_HOME;
    process.env.PARACHUTE_HOME = home;
    try {
      const cfg = await import(join(import.meta.dir, "../../../vault/src/config.ts"));
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(home, "vault"), { recursive: true });
      for (const yaml of [
        'port: 1940\ndocs:\n  base_url: "https://docs.example.org/p"  # ours\n',
        "port: 1940\ndocs:\n  base_url: off\n",
        "port: 1940\ndocs:\n\ndiscovery: enabled\n",
        "port: 1940\n",
        "port: 1940\ndocs: off\n",
        "port: 1940\ndocs:\n# ours\n  base_url: https://docs.example.org\n",
      ]) {
        writeFileSync(join(home, "vault", "config.yaml"), yaml);
        expect({ yaml, hub: hub.configuredDocsBase(join(home, "vault", "config.yaml")) }).toEqual({ yaml, hub: cfg.readGlobalConfig().docs?.base_url });
      }
    } finally {
      if (saved === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = saved;
    }
  });
  test("a refusal gains docs, and its text block still equals structuredContent", () => {
    const r = hub.withRefusalDocs(refused("unknown_tool"), ctx);
    expect((r.structuredContent as Record<string, unknown>).docs).toBe("https://docs.example/x/docs/v/0.9/fix/needs-admin/#a-tool-it-cant-see");
    expect(JSON.parse(r.content[0]!.text as string)).toEqual(r.structuredContent);
  });
});
