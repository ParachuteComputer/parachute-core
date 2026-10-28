// An older vault never migrates or re-stamps a vault.db a newer vault wrote (PLAN §3, fix 4). The command refuses
// such a home before it opens anything (packages/cli, exit 6); this is the check inside, for any other way in.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { NewerSchemaError, SCHEMA_VERSION, initSchema } from "./schema.ts";

test("initSchema refuses a vault.db stamped newer than SCHEMA_VERSION, and writes nothing", () => {
  const db = new Database(":memory:");
  initSchema(db);
  db.run("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", [SCHEMA_VERSION + 1, new Date().toISOString()]);
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
