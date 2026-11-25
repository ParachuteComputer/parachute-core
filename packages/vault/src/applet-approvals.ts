/**
 * Which of a vault's applets the person approved, by the hash of their code (T-476, Parachute applets inside Claude).
 *
 * The Parachute app runs an applet's code only when the person approved that exact code: on a device that holds their
 * key, Allow signs a Nostr event (kind 30479) and writes it to `Parachute/Approvals/<host>/<vault>/<record id>`, tagged
 * `parachute-approval`, under `fields.approval` (the app's docs/design/APP-RECORD.md "Running needs a signed approval",
 * src/applet/approvals.ts). The MCP App surface (mcp-app.ts) offers an applet to Claude by the same rule, read here on
 * the server: the approval's signature holds, its signer is one of the keys the hub linked to the person (never a key
 * named in the vault: anyone who can write the vault can write an event), it names this vault, this record and this
 * applet, it isn't dated ahead of the clock or past its year, it is the newest one for the applet (a taking back wins
 * a tie), it approves, and its code hash is the hash of the code as it is now (`<kind>:<sha256>`, the app's code.ts
 * `codeHash`). New code, an edited hash, another key, another applet's approval: none counts.
 *
 * Not checked here, and why: the hash of the applet's asks (`scope`), which the app computes from what its device reads
 * into the record (src/applet/approvals.ts `asksHash`). In Claude an applet can ask for nothing but records: the view
 * (@openparachute/applet-host) runs it in the app's sealed frame with the app's own vault module, held to the
 * manifest's folders at every call, and the key's own reach bounds that. A device-side floor (the highest approval
 * number it has seen) has no place on a stateless door either: deleting the newest approval to bring back an older one
 * for the same code is the gap the app's design names for a new device.
 *
 * An applet that imports components (`component:<id>`) is never offered: its hash covers code from other records that
 * this door doesn't resolve.
 */
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

export const APPROVAL_KIND = 30479;
export const APPROVAL_TAG = "parachute-approval";
export const APPROVAL_FOLDER = "Parachute/Approvals/";
/** How far ahead of the server's clock an approval's number or time may be (the app's SKEW_S). */
const SKEW_S = 600;
const APPROVAL_DAYS = 365;
const HEX64 = /^[0-9a-f]{64}$/;

export type CodeKind = "html" | "tsx" | "jsx";
export type Subject = { hub: string; vault: string; record: string; applet: string };
export type SignedEvent = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export type ApprovalContent = { v: 1; subject: Subject; n: number; approved: boolean; code: string; scope: string; at: string; expires: string; device?: string; vaults?: unknown };

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A record's code kind, from its extension; null for anything an applet can't be. */
export function codeKindOf(extension: unknown): CodeKind | null {
  const e = String(extension ?? "md").replace(/^\./, "").toLowerCase();
  return e === "html" || e === "tsx" || e === "jsx" ? e : null;
}

/** The app's code hash (code.ts `codeHash`): HTML bare hex, TSX/JSX `<kind>:<hex>`. */
export const codeHash = (kind: CodeKind, source: string): string => (kind === "html" ? "" : `${kind}:`) + sha256Hex(source);

/** Whether a module imports a component (`from "component:<id>"`, `import "component:<id>"`, `import("component:…")`). */
export const importsComponents = (source: string): boolean => /\b(?:from|import)\s*\(?\s*["']component:/.test(source);

/** `d` as the app writes it: hub|vault|record. */
export const dOf = (s: Subject) => `${s.hub}|${s.vault}|${s.record}`;

const MAX_CONTENT = 64_000;
/** The shape and bounds of an event, before any hashing. */
function wellFormed(e: unknown): e is SignedEvent {
  const ev = e as SignedEvent;
  if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || !HEX64.test(ev.id) || !HEX64.test(String(ev.pubkey)) || typeof ev.sig !== "string" || !/^[0-9a-f]{128}$/.test(ev.sig)) return false;
  if (!Number.isSafeInteger(ev.created_at) || !Number.isSafeInteger(ev.kind) || typeof ev.content !== "string" || ev.content.length > MAX_CONTENT) return false;
  return Array.isArray(ev.tags) && ev.tags.length <= 50 && ev.tags.every((t) => Array.isArray(t) && t.length <= 10 && t.every((x) => typeof x === "string" && x.length <= 1024));
}
function schnorrOk(sig: string, id: string, pubkey: string): boolean {
  try { return schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(pubkey, "hex")); } catch { return false; }
}

/** A Nostr event whose id is its hash and whose signature holds for its pubkey. */
export function soundEvent(e: unknown): e is SignedEvent {
  if (!wellFormed(e)) return false;
  if (sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])) !== e.id) return false;
  return schnorrOk(e.sig, e.id, e.pubkey);
}

function contentOf(ev: SignedEvent): ApprovalContent | null {
  try {
    const c = JSON.parse(ev.content) as ApprovalContent;
    if (!c || c.v !== 1 || typeof c.approved !== "boolean" || !Number.isSafeInteger(c.n) || c.n <= 0) return null;
    const s = c.subject;
    if (!s || typeof s.hub !== "string" || typeof s.vault !== "string" || typeof s.record !== "string" || typeof s.applet !== "string") return null;
    if (typeof c.code !== "string" || typeof c.scope !== "string" || isNaN(Date.parse(c.at)) || isNaN(Date.parse(c.expires))) return null;
    return c;
  } catch {
    return null;
  }
}

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };

/** One approval that counts for this applet (signature, signer, subject, dates), or why it doesn't. */
export function checkApproval(
  ev: unknown,
  want: { vault: string; record: string; applet: string },
  hubs: ReadonlySet<string>,
  trusted: ReadonlySet<string>,
  now: number,
  sound?: (e: SignedEvent) => boolean,
): { ok: true; content: ApprovalContent; by: string } | { ok: false; why: string } {
  const e = ev as SignedEvent;
  if (!e || typeof e !== "object" || e.kind !== APPROVAL_KIND) return { ok: false, why: "not an approval" };
  if (!trusted.has(String(e.pubkey))) return { ok: false, why: "not signed by a key of the person's" };
  // the cheap checks first (what it names), the signature last: a vault's approvals are read once per applet
  if (typeof e.content !== "string" || e.content.length > MAX_CONTENT || !Array.isArray(e.tags)) return { ok: false, why: "it can't be read" };
  const c = contentOf(e);
  if (!c) return { ok: false, why: "it can't be read" };
  const hub = originOf(c.subject.hub);
  if (!hub || !hubs.has(hub)) return { ok: false, why: "it is for another hub" };
  if (c.subject.vault !== want.vault || c.subject.record !== want.record || c.subject.applet !== want.applet) return { ok: false, why: "it is for another applet" };
  if (e.tags.find((t) => Array.isArray(t) && t[0] === "d")?.[1] !== dOf(c.subject)) return { ok: false, why: "it is for another applet" };
  if (!(sound ? sound(e) : soundEvent(e))) return { ok: false, why: "its signature doesn't hold" };
  const nowS = Math.floor(now / 1000);
  if (c.n > nowS + SKEW_S || e.created_at > nowS + SKEW_S) return { ok: false, why: "it is dated in the future" };
  const exp = Date.parse(c.expires), at = Date.parse(c.at);
  if (exp <= now || exp - at > (APPROVAL_DAYS + 1) * 86_400_000) return { ok: false, why: "its year has run out" };
  return { ok: true, content: c, by: e.pubkey };
}

/** `soundEvent`, the costly half done once per signature: every event's id is recomputed from its fields each time
 *  (cheap), and only the schnorr check of that recomputed id, signature and key is remembered. A copy of a genuine
 *  event with its content or tags changed has another id, so it never rides on the original's check (the app's
 *  approvals.ts `sound` reads afresh for the same reason). */
export function soundOnce(verify: (sig: string, id: string, pubkey: string) => boolean = schnorrOk): (e: SignedEvent) => boolean {
  const seen = new Map<string, boolean>();
  return (e) => {
    if (!wellFormed(e)) return false;
    if (sha256Hex(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])) !== e.id) return false;
    const k = `${e.id}:${e.sig}:${e.pubkey}`;
    let v = seen.get(k);
    if (v === undefined) { v = verify(e.sig, e.id, e.pubkey); seen.set(k, v); }
    return v;
  };
}

/** Whether the newest approval that counts approves this code: its content when it does, else why not. */
export function approvedCode(
  events: readonly unknown[],
  want: { vault: string; record: string; applet: string; code: string },
  hubs: ReadonlySet<string>,
  trusted: ReadonlySet<string>,
  now: number,
  sound: (e: SignedEvent) => boolean = soundEvent,
): { ok: true; content: ApprovalContent } | { ok: false; why: "none" | "withdrawn" | "other" } {
  let newest: ApprovalContent | null = null;
  for (const ev of events) {
    const r = checkApproval(ev, want, hubs, trusted, now, sound);
    if (!r.ok) continue;
    // two with one number (two devices in one second): the taking back wins
    if (!newest || r.content.n > newest.n || (r.content.n === newest.n && !r.content.approved)) newest = r.content;
  }
  if (!newest) return { ok: false, why: "none" };
  if (!newest.approved) return { ok: false, why: "withdrawn" };
  if (newest.code !== want.code) return { ok: false, why: "other" };
  return { ok: true, content: newest };
}
