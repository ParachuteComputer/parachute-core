/**
 * applySeedPack, as `vault pack add <name>` uses it (a new vault is no longer seeded, T-476: the docs site and the MCP
 * `docs` tool replace the guides), and the vault coordinates in the connect-time brief. Kept from the old
 * onboarding-seed.test.ts when default seeding went.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BunStore } from "./vault-store.ts";
import {
  applySeedPack,
  GETTING_STARTED_PACK,
  ARCHIVED_TAG,
  GETTING_STARTED_PATH,
  NOTES_REQUIRED_TAGS,
  STARTER_ONTOLOGY_PACK,
  SURFACE_STARTER_PACK,
  SURFACE_STARTER_PATH,
  welcomePack,
} from "../core/src/seed-packs.ts";
import { PathConflictError } from "../core/src/notes.ts";
import {
  buildVaultProjection,
  projectionToMarkdown,
} from "../core/src/vault-projection.ts";

/** What the old default seed wrote: the welcome pack, then getting-started. */
async function seedOnboardingNotes(store: BunStore) {
  for (const pack of [welcomePack(), GETTING_STARTED_PACK]) await applySeedPack(store, pack);
}

let db: Database;
let store: BunStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `seed-packs-apply-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new Database(join(tmpDir, "test.db"));
  store = new BunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});
describe("applySeedPack — surface-starter via add-pack", () => {
  test("applies the Surface Starter guide onto a default-seeded vault", async () => {
    await seedOnboardingNotes(store);
    const result = await applySeedPack(store, SURFACE_STARTER_PACK);
    expect(result.pack).toBe("surface-starter");
    expect(result.seededNotes).toEqual([SURFACE_STARTER_PATH]);
    expect(result.skippedNotes).toEqual([]);
    // surface-starter now declares GUIDE_TAG (it's a guide).
    expect(result.tags).toEqual(["guide"]);

    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    expect(ss).not.toBeNull();
    expect(ss!.content).toContain("# Surface Starter");
    // A3: the two surface packages by name.
    expect(ss!.content).toContain("@openparachute/surface-client");
    expect(ss!.content).toContain("@openparachute/surface-render");
    expect(ss!.content).toContain("createVaultSurface");
    expect(ss!.content).toContain("NoteRenderer");

    // GAP 2: warn that a surface can't be run/developed from this MCP session.
    expect(ss!.content).toContain("not from this");
    expect(ss!.content.toLowerCase()).toContain("browser");

    // GAP 1: a real, copy-paste end-to-end snippet — every load-bearing symbol
    // present, verified against the surface-client / surface-render source.
    expect(ss!.content).toContain("clientName"); // the one required createVaultSurface option
    expect(ss!.content).toContain("getClient");
    expect(ss!.content).toContain("queryNotes");
    expect(ss!.content).toContain("handleCallback");
    expect(ss!.content).toContain("resolve="); // NoteRenderer wikilink resolver prop

    // Its [[Getting Started]] wikilink resolves against the default seed.
    const gs = await store.getNoteByPath(GETTING_STARTED_PATH);
    const outbound = await store.getLinks(ss!.id, { direction: "outbound" });
    expect(outbound.some((l) => l.targetId === gs!.id)).toBe(true);
  });

  test("idempotent: a re-apply skips and never clobbers an edited note", async () => {
    await applySeedPack(store, SURFACE_STARTER_PACK);
    const ss = await store.getNoteByPath(SURFACE_STARTER_PATH);
    const edited = "# Surface Starter\n\nWe built ours with Solid.";
    await store.updateNote(ss!.id, { content: edited });

    const rerun = await applySeedPack(store, SURFACE_STARTER_PACK);
    expect(rerun.seededNotes).toEqual([]);
    expect(rerun.skippedNotes).toEqual([SURFACE_STARTER_PATH]);

    const after = await store.getNoteByPath(SURFACE_STARTER_PATH);
    expect(after!.content).toBe(edited);
    const all = await store.queryNotes({});
    expect(all.filter((n) => n.path === SURFACE_STARTER_PATH)).toHaveLength(1);
  });
});

describe("applySeedPack — concurrent-apply skip grace (vault#527)", () => {
  /**
   * The applier's idempotency is check-then-create: `getNoteByPath` decides,
   * then `createNote` writes. Two callers applying the same pack at once can
   * BOTH see "absent" and both try to create; the loser hits the path UNIQUE
   * constraint. That race can't be scheduled deterministically from a test,
   * so we inject it — a store proxy whose `getNoteByPath` reports absent (as
   * it genuinely would for the racer that checked first) while `createNote`
   * rejects with the PathConflictError the real store raises when the winner
   * has already committed. That is exactly the state the loser observes.
   */
  function racingStore(target: BunStore, racedPaths: Set<string>) {
    return new Proxy(target, {
      get(obj, prop, recv) {
        if (prop === "createNote") {
          return async (content: string, opts: { path?: string } = {}) => {
            if (opts.path && racedPaths.has(opts.path)) {
              throw new PathConflictError(opts.path);
            }
            return (obj as BunStore).createNote(content, opts as never);
          };
        }
        return Reflect.get(obj, prop, recv);
      },
    }) as BunStore;
  }

  test("a path lost to a concurrent creator is reported skipped, not thrown", async () => {
    const raced = new Set(SURFACE_STARTER_PACK.notes.map((n) => n.path));
    const proxied = racingStore(store, raced);

    const result = await applySeedPack(proxied, SURFACE_STARTER_PACK);

    expect(result.seededNotes).toEqual([]);
    expect(result.skippedNotes).toEqual(SURFACE_STARTER_PACK.notes.map((n) => n.path));
  });

  test("losing one path does not abort the rest of the pack", async () => {
    // welcomePack is multi-note, so this proves the loop CONTINUES past a
    // lost race rather than aborting the whole pack on the first conflict.
    const pack = welcomePack();
    const [first, ...rest] = pack.notes;
    expect(rest.length).toBeGreaterThan(0);
    const proxied = racingStore(store, new Set([first!.path]));

    const result = await applySeedPack(proxied, pack);

    expect(result.skippedNotes).toContain(first!.path);
    for (const n of rest) expect(result.seededNotes).toContain(n.path);
  });

  test("a PathConflictError is the ONLY create failure swallowed — others still propagate", async () => {
    const boom = new Proxy(store, {
      get(obj, prop, recv) {
        if (prop === "createNote") {
          return async () => {
            throw new Error("disk on fire");
          };
        }
        return Reflect.get(obj, prop, recv);
      },
    }) as BunStore;

    await expect(applySeedPack(boom, SURFACE_STARTER_PACK)).rejects.toThrow(/disk on fire/);
  });
});

describe("applySeedPack — tag description preservation on re-apply (Aaron-ratified 2026-07-17)", () => {
  test("fresh apply: a brand-new tag gets the pack's description, reported as touched not preserved", async () => {
    const result = await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    expect(result.tags).toContain(ARCHIVED_TAG.name);
    expect(result.preservedTagDescriptions).toEqual([]);

    const record = await store.getTagRecord(ARCHIVED_TAG.name);
    expect(record!.description).toBe(ARCHIVED_TAG.description);
  });

  test("re-apply unmodified: description is still the pack's text — upserted, not preserved", async () => {
    await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    const rerun = await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    expect(rerun.preservedTagDescriptions).toEqual([]);

    const record = await store.getTagRecord(ARCHIVED_TAG.name);
    expect(record!.description).toBe(ARCHIVED_TAG.description);
  });

  test("re-apply after a user edit: the hand-tuned description survives and is reported preserved", async () => {
    await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    const edited = "My own house rules for archiving — nothing like the default.";
    await store.upsertTagRecord(ARCHIVED_TAG.name, { description: edited });

    const rerun = await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    expect(rerun.preservedTagDescriptions).toContain(ARCHIVED_TAG.name);
    // Still listed in `tags` — the tag itself was touched (fields/parent_names
    // upsert unconditionally); only the description write was skipped.
    expect(rerun.tags).toContain(ARCHIVED_TAG.name);

    const record = await store.getTagRecord(ARCHIVED_TAG.name);
    expect(record!.description).toBe(edited);
  });

  test("capture byte-identity anchor (NOTES_REQUIRED_TAGS) holds under either apply order", async () => {
    // welcome, then starter-ontology.
    await applySeedPack(store, welcomePack());
    expect((await store.getTagRecord("capture"))!.description).toBe(
      NOTES_REQUIRED_TAGS[0]!.description,
    );
    const afterOntology = await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    expect(afterOntology.preservedTagDescriptions).not.toContain("capture");
    expect((await store.getTagRecord("capture"))!.description).toBe(
      NOTES_REQUIRED_TAGS[0]!.description,
    );
  });

  test("capture byte-identity anchor holds in the reverse order too", async () => {
    // starter-ontology, then welcome.
    await applySeedPack(store, STARTER_ONTOLOGY_PACK);
    expect((await store.getTagRecord("capture"))!.description).toBe(
      NOTES_REQUIRED_TAGS[0]!.description,
    );
    const afterWelcome = await applySeedPack(store, welcomePack());
    expect(afterWelcome.preservedTagDescriptions).not.toContain("capture");
    expect((await store.getTagRecord("capture"))!.description).toBe(
      NOTES_REQUIRED_TAGS[0]!.description,
    );
  });
});

describe("vault coordinates in the projection (GAP 3)", () => {
  test("renders absolute REST + MCP URLs when the hub origin is known", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "research",
      description: null,
      projection,
      coordinates: { hubOrigin: "https://hub.example.com", hubOriginKnown: true },
    });

    expect(md).toContain("## This vault's coordinates");
    expect(md).toContain("Name: `research`");
    expect(md).toContain("https://hub.example.com/vault/research/api/...");
    expect(md).toContain("https://hub.example.com/vault/research/mcp");
  });

  test("renders relative templates + connected-origin note when origin is unknown", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({
      vaultName: "research",
      description: null,
      projection,
      coordinates: { hubOrigin: "http://127.0.0.1:1940", hubOriginKnown: false },
    });

    expect(md).toContain("## This vault's coordinates");
    expect(md).toContain("Name: `research`");
    // The loopback URL is NOT leaked; relative templates carry a placeholder.
    expect(md).not.toContain("127.0.0.1");
    expect(md).toContain("<hub-origin>/vault/research/api/...");
    expect(md).toContain("<hub-origin>/vault/research/mcp");
  });

  test("no coordinates block when coordinates are omitted; name still in the opening line", () => {
    const projection = buildVaultProjection(db, { includeStats: true });
    const md = projectionToMarkdown({ vaultName: "research", description: null, projection });
    // Without coordinates the dedicated block is absent; the vault NAME is still
    // stated in the pre-existing opening line (the always-known coordinate).
    expect(md).toContain('Parachute Vault "research"');
    expect(md).not.toContain("## This vault's coordinates");
  });
});
