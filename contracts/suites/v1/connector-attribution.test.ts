// v1: when a consumer app writes for a person, the vault records both: the person as who, the app as how.
// Today the vault records the person's hub id and `via: "mcp"`, but not which app (vault src/auth.ts:708).
import { beforeAll, describe, expect, test } from "bun:test";
import { mcp, operator, runId } from "../lib.ts";
import { connect, MCP_URL, type Connected } from "../oauth.ts";

// Decided for v1, missing today: expected to fail. V1_SHOW=1 runs them as plain tests, to read why they fail.
const pending = process.env.V1_SHOW ? test : test.failing;

let app: Connected;
let sub: string;
let noteId: string;

beforeAll(async () => {
  app = await connect({ appName: `Attribution app ${runId("app")}` });
  sub = JSON.parse(Buffer.from(app.access.split(".")[1]!, "base64url").toString()).sub;
  const c = await mcp(MCP_URL, app.access);
  try {
    const made = await c.call("create-note", { content: "written by the app", path: `${runId("attr")}/n` });
    noteId = made.id ?? made.note?.id;
  } finally {
    await c.close();
  }
});

describe("v1 consumer connector attribution", () => {
  test("setup works today: the app connected and wrote a note", async () => {
    expect((await operator().get(`/notes/${noteId}`)).status).toBe(200);
  });

  pending("the note names the person who acted and the app they acted through", async () => {
    const n = (await operator().get(`/notes/${noteId}`)).body;
    expect(n.createdBy).toBe(sub);
    expect(n.createdVia).toBe(`app:${app.clientId}`);
  });
});
