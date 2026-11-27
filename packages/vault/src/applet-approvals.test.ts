// The rule that decides which applets a person's Claude may open (applet-approvals.ts): each case is a way someone who
// can write the vault (an agent, a token) might try to get code run that the person didn't approve.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { approvedCode, checkApproval, codeHash, importsComponents, soundEvent, soundOnce, type Subject } from "./applet-approvals.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key() { const sk = randomBytes(32); return { sk, pub: hex(schnorr.getPublicKey(sk)) }; }
function sign(k: { sk: Uint8Array; pub: string }, e: { kind: number; created_at: number; tags: string[][]; content: string }) {
  const id = createHash("sha256").update(JSON.stringify([0, k.pub, e.created_at, e.kind, e.tags, e.content])).digest("hex");
  return { ...e, id, pubkey: k.pub, sig: hex(schnorr.sign(Buffer.from(id, "hex"), k.sk)) };
}
const HUB = "https://hub.example";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const S = Math.floor(NOW / 1000);
const CODE = "export default function People() { return null; }";
const subject: Subject = { hub: HUB, vault: "home", record: "01REC", applet: "people" };
const want = { vault: "home", record: "01REC", applet: "people", code: codeHash("tsx", CODE) };
const hubs = new Set([HUB]);
const person = key();
const trusted = new Set([person.pub]);
function approval(k = person, o: { code?: string; approved?: boolean; n?: number; subject?: Subject; at?: number; days?: number; d?: string } = {}) {
  const sub = o.subject ?? subject;
  const at = o.at ?? NOW - 3_600_000;
  const content = { v: 1, subject: sub, n: o.n ?? S - 3600, approved: o.approved ?? true, code: o.code ?? want.code, scope: "s", at: new Date(at).toISOString(), expires: new Date(at + (o.days ?? 365) * 86_400_000).toISOString() };
  return sign(k, { kind: 30479, created_at: o.n ?? S - 3600, tags: [["d", o.d ?? `${sub.hub}|${sub.vault}|${sub.record}`]], content: JSON.stringify(content) });
}

describe("an applet runs in Claude only on the person's approval of this exact code", () => {
  test("the person's own approval of this code counts", () => {
    expect(approvedCode([approval()], want, hubs, trusted, NOW)).toMatchObject({ ok: true });
  });
  test("new code under an old approval: no", () => {
    expect(approvedCode([approval()], { ...want, code: codeHash("tsx", `${CODE}\n// planted`) }, hubs, trusted, NOW)).toEqual({ ok: false, why: "other" });
  });
  test("an approval signed by a key the hub didn't link to the person: no", () => {
    expect(approvedCode([approval(key())], want, hubs, trusted, NOW)).toEqual({ ok: false, why: "none" });
  });
  test("the person's approval with its code hash edited to match planted code: the signature breaks", () => {
    const ev = approval();
    const planted = codeHash("tsx", "export default () => fetch('/steal')");
    const edited = { ...ev, content: ev.content.replace(want.code, planted) };
    expect(checkApproval(edited, want, hubs, trusted, NOW)).toEqual({ ok: false, why: "its signature doesn't hold" });
    expect(approvedCode([edited], { ...want, code: planted }, hubs, trusted, NOW)).toEqual({ ok: false, why: "none" });
  });
  test("another applet's approval moved onto this one: no", () => {
    const other = approval(person, { subject: { ...subject, record: "01OTHER", applet: "notes" } });
    expect(approvedCode([other], want, hubs, trusted, NOW).ok).toBe(false);
    expect(approvedCode([approval(person, { d: `${HUB}|home|01OTHER` })], want, hubs, trusted, NOW).ok).toBe(false);
  });
  test("an approval for another vault or another hub: no", () => {
    expect(approvedCode([approval(person, { subject: { ...subject, vault: "work" } })], want, hubs, trusted, NOW).ok).toBe(false);
    expect(approvedCode([approval(person, { subject: { ...subject, hub: "https://elsewhere.example" } })], want, hubs, trusted, NOW).ok).toBe(false);
  });
  test("a newer taking back wins; at the same number too", () => {
    expect(approvedCode([approval(), approval(person, { approved: false, n: S - 60 })], want, hubs, trusted, NOW)).toEqual({ ok: false, why: "withdrawn" });
    expect(approvedCode([approval(person, { n: S - 60 }), approval(person, { approved: false, n: S - 60 })], want, hubs, trusted, NOW)).toEqual({ ok: false, why: "withdrawn" });
    expect(approvedCode([approval(person, { approved: false, n: S - 7200 }), approval()], want, hubs, trusted, NOW)).toMatchObject({ ok: true });
  });
  test("dated ahead of the clock, or past its year: no", () => {
    expect(approvedCode([approval(person, { n: S + 3600 })], want, hubs, trusted, NOW).ok).toBe(false);
    expect(approvedCode([approval(person, { at: NOW - 400 * 86_400_000 })], want, hubs, trusted, NOW).ok).toBe(false);
    expect(approvedCode([approval(person, { days: 3650 })], want, hubs, trusted, NOW).ok).toBe(false);
  });
  test("garbage is passed over, never read as an approval", () => {
    expect(approvedCode([null, "x", { kind: 30479 }, { ...approval(), sig: "00".repeat(64) }, approval()], want, hubs, trusted, NOW)).toMatchObject({ ok: true });
  });
  test("an applet that imports components isn't offered (its hash covers code in other records)", () => {
    expect(importsComponents(`import Events from "component:events";`)).toBe(true);
    // read without parsing: an import named only in a comment is refused too, the safe side
    expect(importsComponents(`// import X from "component:x"`)).toBe(true);
    expect(importsComponents(`import { vault } from "parachute";`)).toBe(false);
  });
  test("the code hash is the app's: html bare, tsx and jsx by kind", () => {
    const h = createHash("sha256").update(CODE).digest("hex");
    expect([codeHash("html", CODE), codeHash("tsx", CODE), codeHash("jsx", CODE)]).toEqual([h, `tsx:${h}`, `jsx:${h}`]);
  });
  test("a vault's approvals cost one signature check each, not one per applet", () => {
    // what an approval names is read before its signature is checked: 20 applets, 20 approvals, 20 checks (not 400)
    let checks = 0;
    const counted = (e: Parameters<typeof soundEvent>[0]) => { checks++; return soundEvent(e); };
    const apps = Array.from({ length: 20 }, (_, i) => ({ ...want, record: `01R${i}`, applet: `a${i}` }));
    const events = apps.map((w) => approval(person, { subject: { ...subject, record: w.record, applet: w.applet } }));
    for (const w of apps) expect(approvedCode(events, w, hubs, trusted, NOW, counted).ok).toBe(true);
    expect(checks).toBe(20);
    // and one event read twice (tools/list, then resources/read in one request) is checked once
    let verifies = 0;
    const once = soundOnce((sig, id, pub) => { verifies++; return schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(pub, "hex")); });
    for (let i = 0; i < 3; i++) approvedCode(events, apps[0]!, hubs, trusted, NOW, once);
    expect(verifies).toBe(1);
  });
  test("a copy of a genuine approval, its content changed, never rides on the original's checked signature", () => {
    const genuine = approval();
    const evil = { ...want, record: "01EVIL", applet: "evil", code: codeHash("tsx", "export default () => fetch('/steal')") };
    const forged = { ...genuine, tags: [["d", `${HUB}|home|01EVIL`]], content: genuine.content.replace(want.code, evil.code).replace('"01REC"', '"01EVIL"').replace('"people"', '"evil"') };
    const once = soundOnce();
    // the genuine one first (People sorts before the planted applet), so its signature is remembered
    expect(approvedCode([genuine, forged], want, hubs, trusted, NOW, once).ok).toBe(true);
    expect(approvedCode([genuine, forged], evil, hubs, trusted, NOW, once)).toEqual({ ok: false, why: "none" });
    // and the other order: a forged copy checked first doesn't spoil the genuine one
    const again = soundOnce();
    expect(approvedCode([forged, genuine], evil, hubs, trusted, NOW, again)).toEqual({ ok: false, why: "none" });
    expect(approvedCode([forged, genuine], want, hubs, trusted, NOW, again).ok).toBe(true);
  });
});
