// Fix 7 (G5): a live subscriber hears about a delete only if it could see the note.
//
// Today every delete goes to every live subscriber of the vault as `remove{id}`, whatever the subscriber's tags
// (vault src/subscriptions.ts:315-321: "Thin ref — un-scope-matchable. Broadcast remove{id}"), so a tag-scoped
// socket learns the id of every hidden note that is deleted. PLAN §5 fix 7, §7.5 mutant "G5: the delete broadcast".
// Lane F.
//
// Spoken black-box: a WebSocket to <vault>/api/subscribe through the hub, first message {"type":"auth","token"},
// a snapshot until done:true, then upsert/remove frames (vault src/ws-subscribe.ts, src/ws-server.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { must, operator, red, runId } from "../lib.ts";
import { note, pass, subscribe, type LiveSocket } from "./_lib.ts";

const op = operator();
const R = runId("del").replace(/-/g, "");
const MINE = `${R}mine`;
const OTHER = `${R}other`;
let scoped: string;
const open: LiveSocket[] = [];

beforeAll(async () => {
  scoped = await pass({ level: "read", tags: [MINE] });
});

afterAll(() => {
  for (const ws of open) ws.close();
});

async function live(): Promise<LiveSocket> {
  const ws = await subscribe(scoped);
  open.push(ws);
  return ws;
}

/** Delete a hidden note and then a visible one; return the socket's frames once the visible remove arrived. */
async function deleteBoth(ws: LiveSocket, label: string) {
  const hidden = await note(`${R}/${label}-hidden`, "not yours", [OTHER]);
  const visible = await note(`${R}/${label}-visible`, "yours", [MINE]);
  await ws.waitFor((f) => f.type === "upsert" && f.note?.id === visible, "upsert of the visible note");
  expect((await op.del(`/notes/${hidden}`)).status).toBeLessThan(300);
  expect((await op.del(`/notes/${visible}`)).status).toBeLessThan(300);
  // Events go out in order on one socket: once the visible remove is here, any remove for the hidden one already is.
  await ws.waitFor((f) => f.type === "remove" && f.id === visible, "remove of the visible note");
  return { hidden, visible };
}

describe("delete events reach only those who could see the note (fix 7)", () => {
  test("a tag-scoped subscriber receives the delete of a note it could see (positive control)", async () => {
    const ws = await live();
    const { visible } = await deleteBoth(ws, "control");
    expect(ws.frames.some((f) => f.type === "remove" && f.id === visible)).toBe(true);
  });

  red("a tag-scoped subscriber receives no delete event for a note outside its tags", { reason: /received the delete of a hidden note/, lane: "F" }, async () => {
    const ws = await live();
    const { hidden } = await deleteBoth(ws, "hidden");
    const leaked = ws.frames.filter((f) => JSON.stringify(f).includes(hidden));
    must(leaked.length === 0, `the scoped socket received the delete of a hidden note: ${JSON.stringify(leaked)}`);
  });
});
