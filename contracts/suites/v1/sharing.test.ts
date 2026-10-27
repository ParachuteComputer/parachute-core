// v1: sharing is grants (who × what × how much), it only adds up, and private notes are the exceptions.
// Marked `.failing`: today's vault has no grants, so a person's pass sees the whole vault. See README.md here.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { hubCli, mintToken } from "../../harness/services.ts";
import { enc, operator, rest, runId, services } from "../lib.ts";

// Decided for v1, missing today: expected to fail. V1_SHOW=1 runs them as plain tests, to read why they fail.
const pending = process.env.V1_SHOW ? test : test.failing;

const s = services();
const op = operator();
let bo: ReturnType<typeof rest>;
let boId: string;
const R = runId("share");

/** A second person on the same hub, with an ordinary read+write pass for this vault. */
async function person(name: string) {
  await hubCli(s, ["auth", "set-password", "--username", name, "--password", `pw-${randomBytes(12).toString("hex")}`, "--allow-multi"]);
  const token = await mintToken(s, {
    scope: `vault:${s.vaultName}:read vault:${s.vaultName}:write`,
    label: `v1-${name}`,
    user: name,
  });
  const sub = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string;
  return { api: rest(s.vaultViaHub, token), id: sub };
}

const grant = (subject: string, target: { kind: string; id: string }, level: string) =>
  op.post("/grants", { subject: { kind: "identity", id: subject }, target, level });

beforeAll(async () => {
  const p = await person(`bo${randomBytes(3).toString("hex")}`);
  bo = p.api;
  boId = p.id;
});

describe("v1 sharing", () => {
  test("setup works today: a second person exists and their pass is accepted", async () => {
    expect(boId).toBeString();
    expect((await bo.get("/notes?limit=1")).status).toBe(200);
  });

  pending("a pass alone grants nothing: with no grant, a second person sees no notes", async () => {
    await op.post("/notes", { content: "mine", path: `${R}/mine` });
    const list = await bo.get(`/notes?path_prefix=${enc(R)}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  pending("grants add up: view on a type plus edit on a page gives edit where they meet", async () => {
    const tag = `${R}project`;
    const page = await op.post("/notes", { content: "Atlas", path: `${R}/Atlas` });
    const both = await op.post("/notes", { content: "plan", path: `${R}/Atlas/plan`, tags: [tag] });
    const typeOnly = await op.post("/notes", { content: "other", path: `${R}/Elsewhere/other`, tags: [tag] });
    expect((await grant(boId, { kind: "type", id: tag }, "view")).status).toBe(201);
    expect((await grant(boId, { kind: "subtree", id: page.body.id }, "edit")).status).toBe(201);

    // Edit where both reach; view (not edit) where only the type grant reaches.
    expect((await bo.patch(`/notes/${both.body.id}`, { append: " + bo", force: true })).status).toBe(200);
    expect((await bo.get(`/notes/${typeOnly.body.id}`)).status).toBe(200);
    expect((await bo.patch(`/notes/${typeOnly.body.id}`, { append: " + bo", force: true })).status).toBe(403);
  });

  pending("a private note inside a shared page stays hidden until it is granted itself", async () => {
    const page = await op.post("/notes", { content: "Team", path: `${R}/Team` });
    const secret = await op.post("/notes", { content: "salary notes", path: `${R}/Team/salaries`, private: true });
    expect((await grant(boId, { kind: "subtree", id: page.body.id }, "edit")).status).toBe(201);

    expect((await bo.get(`/notes/${page.body.id}`)).status).toBe(200);
    expect((await bo.get(`/notes/${secret.body.id}`)).status).toBe(404);
    expect((await bo.get(`/notes?path_prefix=${enc(`${R}/Team`)}`)).body.map((n: any) => n.id)).toEqual([page.body.id]);

    expect((await grant(boId, { kind: "note", id: secret.body.id }, "view")).status).toBe(201);
    expect((await bo.get(`/notes/${secret.body.id}`)).status).toBe(200);
  });

  pending("revoking a grant hides the note at once", async () => {
    const n = await op.post("/notes", { content: "for now", path: `${R}/brief` });
    const g = await grant(boId, { kind: "note", id: n.body.id }, "view");
    expect(g.status).toBe(201);
    expect((await bo.get(`/notes/${n.body.id}`)).status).toBe(200);
    expect((await op.del(`/grants/${g.body.id}`)).status).toBe(200);
    expect((await bo.get(`/notes/${n.body.id}`)).status).toBe(404);
  });
});
