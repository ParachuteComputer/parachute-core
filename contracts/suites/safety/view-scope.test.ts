// Fix 5 (G1): a tag-scoped pass reads through `/view` only what it may read through the API.
//
// Today `/view/<idOrPath>` asks only "is this a valid credential?" (vault src/routing.ts:217-226,
// isViewAuthenticated) and then renders any note (src/routes.ts:4620-4643, handleViewNote), ignoring the pass's
// tags. PLAN §5 fix 5, §7.5 mutant "G1: /view unscoped". Lane F turns it green, then moves it to today/.
import { beforeAll, describe, expect, test } from "bun:test";
import { must, red, rest, runId, services } from "../lib.ts";
import { note, pass, view } from "./_lib.ts";

const R = runId("view").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
const SECRET = `zq${R}secretword`;
let scoped: string;
let inScope: string;
let outOfScope: string;

beforeAll(async () => {
  inScope = await note(`${R}/visible`, `a visible note ${R}`, [MINE]);
  outOfScope = await note(`${R}/hidden`, `a hidden note ${SECRET}`, [OTHER]);
  scoped = await pass({ level: "read", tags: [MINE] });
});

describe("/view honours a pass's tags (fix 5)", () => {
  test("setup works today: the scoped pass can't read the hidden note through the API", async () => {
    const api = rest(services().vaultViaHub, scoped);
    expect((await api.get(`/notes/${outOfScope}`)).status).toBe(404);
    expect((await api.get(`/notes/${inScope}`)).status).toBe(200);
  });

  test("a tag-scoped pass reads an in-scope note through /view (positive control)", async () => {
    const r = await view(scoped, inScope);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`a visible note ${R}`);
  });

  test("with no pass, /view shows neither note (neither is published)", async () => {
    expect((await view(null, inScope)).status).toBe(404);
    expect((await view(null, outOfScope)).status).toBe(404);
  });

  red("a tag-scoped pass can't read a note outside its tags through /view, by id or by path", { reason: /\/view rendered a note outside the pass's tags/, lane: "F" }, async () => {
    for (const ref of [outOfScope, `${R}/hidden`]) {
      const r = await view(scoped, ref);
      must(!r.text.includes(SECRET), `/view rendered a note outside the pass's tags (${ref.includes("/") ? "by path" : "by id"}, status ${r.status})`);
      expect(r.status).toBe(404);
    }
  });
});
