// A type only tags.kind records (T-318 §8a) gets a schema sidecar on export (`kind: type`). The mirror's prune
// keep-list must name it too, or every mirror run writes the sidecar and then prunes it.
import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeVaultConfig } from "./config.ts";
import { clearVaultStoreCache, getVaultStore } from "./vault-store.ts";
import { buildMirrorDeps } from "./mirror-deps.ts";

const ORIG = process.env.PARACHUTE_HOME;
afterEach(() => {
  clearVaultStoreCache();
  if (ORIG === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG;
});

describe("mirror keeps a bare type's sidecar", () => {
  test("export writes it, prune keeps it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-bare-type-"));
    process.env.PARACHUTE_HOME = home;
    try {
      fs.mkdirSync(path.join(home, "vault", "data", "bt"), { recursive: true });
      writeVaultConfig({ name: "bt", api_keys: [], created_at: new Date().toISOString() });
      const store = getVaultStore("bt");
      await store.upsertTagRecord("project", { kind: "type" });
      await store.createNote("Alder", { path: "p/alder", tags: ["project"] });
      const outDir = path.join(home, "mirror");
      fs.mkdirSync(outDir, { recursive: true });
      const deps = buildMirrorDeps("bt");
      await deps.runExport({ outDir } as any);
      const sidecar = path.join(outDir, ".parachute", "schemas", "project.yaml");
      expect(fs.readFileSync(sidecar, "utf8")).toContain("kind: type");
      await deps.runPrune({ outDir } as any);
      expect(fs.existsSync(sidecar)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
