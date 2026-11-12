// An older vault never migrates or re-stamps a vault.db a newer vault wrote (PLAN §3, fix 4). The command refuses
// such a home before it opens anything (packages/cli, exit 6); this is the check inside, for any other way in.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { NewerSchemaError, READABLE_SCHEMA_VERSION, SCHEMA_VERSION, initSchema } from "./schema.ts";

test("initSchema refuses a vault.db stamped newer than READABLE_SCHEMA_VERSION, and writes nothing", () => {
  const db = new Database(":memory:");
  initSchema(db);
  db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [READABLE_SCHEMA_VERSION + 1, new Date().toISOString()]);
  const rows = () => db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
  const before = rows();
  expect(() => initSchema(db)).toThrow(NewerSchemaError);
  expect(rows()).toEqual(before);
  db.close();
});

test("initSchema still opens a vault.db at this SCHEMA_VERSION", () => {
  const db = new Database(":memory:");
  initSchema(db);
  expect(() => initSchema(db)).not.toThrow();
  db.close();
});

// T-460: the engine that writes compressed version bodies stamps 33. This one reads them, so a rollback to it must
// still open such a vault, as it is: no migration, and no older stamp written after the newer one.
test("initSchema opens a vault.db stamped newer than SCHEMA_VERSION but readable, and stamps nothing", () => {
  expect(READABLE_SCHEMA_VERSION).toBeGreaterThan(SCHEMA_VERSION);
  const db = new Database(":memory:");
  initSchema(db);
  db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [READABLE_SCHEMA_VERSION, "2999-01-01T00:00:00.000Z"]);
  const rows = () => db.query("SELECT version, applied_at FROM schema_version ORDER BY version").all();
  const before = rows();
  expect(() => initSchema(db)).not.toThrow();
  expect(() => initSchema(db)).not.toThrow();
  expect(rows()).toEqual(before);
  db.close();
});
