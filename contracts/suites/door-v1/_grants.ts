// What the 1.0 grant contracts share: made-up keys, signed statements, the two new calls at a door, and a small
// record client. Like every door contract they speak HTTP only, to the door named in CONTRACT_DOOR.
//
// The spec is docs/SPEC-1.0-grants.md. The wire these calls assume is its §7: a proposal. If the build picks other
// routes or names, change them here first: most contracts speak through this file (README lists the ones that don't).
import { createHash, randomBytes } from "node:crypto";
import { door, enc, nostrAuth, rest, runId, safeFetch, token, vaultUrl, accountToken, type Level, type Reply } from "../door/_door.ts";
import { must, red } from "../lib.ts";

export { accountToken, door, enc, must, nostrAuth, red, rest, runId, safeFetch, vaultUrl };
export type { Reply };

/** The lane that makes these pass. */
export const LANE = "1.0-grants";
/**
 * Why most of these are red today: no door takes a signed statement yet. Only an absent route (a box's 405, a
 * personal door's 404) matches, so once the route exists a 400, 401, 403 or 409 from a contract's own mistake
 * shows as "red for the wrong reason" instead of hiding here.
 */
export const NO_GRANTS = /no grants at this door: POST \S+\/statements answered 40[45]/;

/** The five event kinds the spec reserves (§2.1). A signature covers the kind, so these are fixed with the spec. */
export const KIND = { grant: 37440, revoke: 7440, link: 37441, confirm: 37442, vaultRecord: 37443 } as const;

/**
 * The one spelling (§2.1): ASCII keys sorted byte by byte, no whitespace, whole numbers 0 to 2^53-1 as plain
 * digits, strings escaping only `"` and `\\`. Every statement's content is this spelling of a JSON object; a vault
 * refuses any other. An object field that is `undefined` is left out; anything the spelling can't hold throws.
 */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${Array.from(x, (v) => (v === undefined ? bad("an undefined array item") : canonical(v))).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const keys = Object.keys(x as object).filter((k) => (x as any)[k] !== undefined);
    for (const k of keys) if (!/^[\x20-\x7e]+$/.test(k)) bad(`a key that isn't printable ASCII: ${JSON.stringify(k)}`);
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // ASCII: code unit order is byte order
    return `{${keys.map((k) => `${canonical(k)}:${canonical((x as any)[k])}`).join(",")}}`;
  }
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0) ? String(x) : bad(`a number that isn't whole and 0 to 2^53-1: ${x}`);
  if (typeof x === "string") {
    if (/[\u0000-\u001f\u007f]/.test(x) || !x.isWellFormed()) bad("a string with a control character or a lone surrogate");
    return `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (typeof x === "boolean") return String(x);
  return bad(`a value the spelling can't hold: ${String(x)}`);
}
function bad(what: string): never {
  throw new Error(`canonical: ${what}`);
}

// ── Keys and events ─────────────────────────────────────────────────────────────────────────────────────────

export interface Key {
  secretKey: string;
  pubkey: string;
}
export interface Event {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A made-up key for one contract. */
export async function newKey(): Promise<Key> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const sk = randomBytes(32);
  return { secretKey: sk.toString("hex"), pubkey: Buffer.from(schnorr.getPublicKey(sk)).toString("hex") };
}

/** The made-up owner key this run's door knows as the vault owner's. */
export async function ownerKey(): Promise<Key> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const secretKey = door().ownerKey;
  if (!secretKey) throw new Error("setup: this door file carries no owner key (grants need a 0.9.1 door or later)");
  return { secretKey, pubkey: Buffer.from(schnorr.getPublicKey(Buffer.from(secretKey, "hex"))).toString("hex") };
}

const now = () => Math.floor(Date.now() / 1000);

/** Sign a Nostr event (NIP-01): the id is the hash of its fields, the signature is BIP-340 over the id. */
export async function sign(key: Key, e: { kind: number; tags: string[][]; content?: string; created_at?: number }): Promise<Event> {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const created_at = e.created_at ?? now();
  const content = e.content ?? "";
  const id = createHash("sha256").update(JSON.stringify([0, key.pubkey, created_at, e.kind, e.tags, content])).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(key.secretKey, "hex"))).toString("hex");
  return { id, pubkey: key.pubkey, created_at, kind: e.kind, tags: e.tags, content, sig };
}

/**
 * The vault's own id (§2.3): its own public key, 64 lowercase hex, which a grant's `honors` names. Today's vaults
 * have none, so this falls back to a fixed placeholder and each contract goes on to its own assertion;
 * `grant.test.ts` holds "a vault says its own id".
 */
export async function vaultId(name = door().vault): Promise<string> {
  const info = await rest("read", name).get("/vault");
  return typeof info.body?.id === "string" ? info.body.id : "0".repeat(64);
}

export type Verb = "read" | "create" | "update" | "delete" | "read:own" | "update:own" | "delete:own";
export interface GrantSpec {
  /** The grant's id (its `d`). Made up when left out. */
  id?: string;
  /** Who signs. The vault's owner unless given. */
  signer?: Key;
  /** The grantee: a key, or an applet in the signer's shell. */
  to: Key | { applet: string; author: Key };
  /** Whose name the writes carry (§5). */
  by?: "signer" | "self" | { names: string };
  /** Type → verbs. `"*"` is every record. */
  types: Record<string, Verb[]>;
  deny?: string[];
  was?: string[];
  /** On a member-signed grant: the id of the member's own grant it hangs from (§5.2). */
  under?: string;
  /** Seconds from now until it ends. A day unless given. `null` leaves the tag out. */
  endsIn?: number | null;
  vault?: string;
  created_at?: number;
  /** Extra tags beyond `d` and `expiration`, for contracts about what a vault refuses. */
  extraTags?: string[][];
  /** Extra content fields, for contracts about what a vault refuses (an unknown field is never read around). */
  extraFields?: Record<string, unknown>;
  /** Put in the content as given, for contracts about refusals; the tags still say what was meant. */
  honors?: string;
  /** Rewrite the content's text after the one spelling, for contracts about what a reader does with other text. */
  respell?: (text: string) => string;
}

const byText = (by: GrantSpec["by"]) => (by === undefined ? "signer" : typeof by === "string" ? by : `names:${by.names}`);

/**
 * The content of a grant (§2.1): the grant frame, `at: parachute`. A type's plain verbs make one row and its `:own`
 * verbs a second row with `only: {own: true}`; verbs and rows are sorted, so the content is in its one spelling.
 */
export async function grantContent(g: GrantSpec & { id: string }): Promise<Record<string, unknown>> {
  const rows: { on: { type: string }; can: string[]; only?: { own: true } }[] = [];
  for (const [type, verbs] of Object.entries(g.types)) {
    const plain = verbs.filter((v) => !v.endsWith(":own")).sort();
    const own = verbs.filter((v) => v.endsWith(":own")).map((v) => v.slice(0, -4)).sort();
    if (plain.length) rows.push({ on: { type }, can: plain });
    if (own.length) rows.push({ on: { type }, can: own, only: { own: true } });
  }
  rows.sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  const to = "applet" in g.to
    ? { kind: "applet", id: g.to.applet, author: g.to.author.pubkey, by: byText(g.by), was: g.was?.slice().sort() }
    : { kind: "key", id: g.to.pubkey, by: byText(g.by), was: g.was?.slice().sort() };
  return {
    v: 1,
    id: g.id,
    at: "parachute",
    honors: g.honors ?? (await vaultId(g.vault)),
    gives: "access",
    to,
    allow: rows,
    deny: g.deny?.length ? g.deny.slice().sort().map((tag) => ({ tag })) : undefined,
    under: g.under,
    until: g.endsIn === null ? undefined : (g.created_at ?? now()) + (g.endsIn ?? 86_400),
    purpose: "This key may use part of my vault until the date given.",
    ...(g.extraFields ?? {}),
  };
}

/** A grant's tags (§2.1): exactly `d` then `expiration`, repeating the content's `id` and `until`. */
export function grantTags(content: Record<string, unknown>, extra: string[][] = []): string[][] {
  const tags: string[][] = [["d", String(content.id)]];
  if (content.until !== undefined) tags.push(["expiration", String(content.until)]);
  return [...tags, ...extra];
}

/** A signed grant event. Not filed. */
export async function grantEvent(g: GrantSpec): Promise<Event & { grantId: string }> {
  // A member's ids start with their own grant's id and a dot (§2.2 line 6).
  const id = g.id ?? (g.under ? `${g.under}.${runId("a")}` : runId("g"));
  const signer = g.signer ?? (await ownerKey());
  const content = await grantContent({ ...g, id });
  const text = canonical(content);
  const e = await sign(signer, { kind: KIND.grant, tags: grantTags(content, g.extraTags), content: g.respell ? g.respell(text) : text, created_at: g.created_at });
  return { ...e, grantId: id };
}

/**
 * An event's size (§2.1): the bytes of the event as sent, one compact JSON object of its seven fields, non-ASCII
 * written as itself, controls too. Not NIP-01's id serialisation, which leaves out `id` and `sig` and is about 250 bytes shorter.
 */
export const eventSize = (e: Event) => {
  // NIP-01's escapes and nothing else: JSON.stringify would write other controls as six-byte `\u00XX`.
  const esc: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  const str = (x: string) => `"${x.replace(/["\\\n\r\t\b\f]/g, (c) => esc[c])}"`;
  const tags = `[${e.tags.map((t) => `[${t.map(str).join(",")}]`).join(",")}]`;
  return Buffer.byteLength(`{"id":${str(e.id)},"pubkey":${str(e.pubkey)},"created_at":${e.created_at},"kind":${e.kind},"tags":${tags},"content":${str(e.content)},"sig":${str(e.sig)}}`);
};

/** The bytes NIP-01 hashes for an event's id. */
export const hashedSize = (e: Event) => Buffer.byteLength(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));

/** A grant's address (§3): kind, grantor key, id. */
export const address = (grant: { pubkey: string; grantId: string }) => `${KIND.grant}:${grant.pubkey}:${grant.grantId}`;

/** A signed revoke (§3): no tags; the content names the address it ends and the vault it is for. */
export async function revokeEvent(
  grant: { pubkey: string; grantId: string } | { ends: string },
  opts: { signer?: Key; vault?: string; honors?: string; v?: number; extraFields?: Record<string, unknown>; tags?: unknown[][]; spaced?: boolean; respell?: (text: string) => string } = {},
): Promise<Event> {
  const signer = opts.signer ?? (await ownerKey());
  const ends = "ends" in grant ? grant.ends : address(grant);
  const content = { v: opts.v ?? 1, honors: opts.honors ?? (await vaultId(opts.vault)), ends, purpose: "I end this grant.", ...(opts.extraFields ?? {}) };
  // `spaced` and `tags` make a revoke from some later shell: a vault still acts on its three frozen fields (§3).
  const text = opts.spaced ? JSON.stringify(content, null, 1) : canonical(content);
  return sign(signer, { kind: KIND.revoke, tags: (opts.tags ?? []) as string[][], content: opts.respell ? opts.respell(text) : text });
}

/**
 * The owner's void of a linked name (§6.2): a revoke whose `ends` is `name:<prefix>:<name>`, final for the name
 * whichever service key links it next. Only an owner key may sign that form; `signer` is for contracts about who
 * else tries.
 */
export async function voidNameEvent(name: string, opts: { signer?: Key; vault?: string } = {}): Promise<Event> {
  return revokeEvent({ ends: `name:${name}` }, opts);
}

/**
 * A vault record (§2.3), kind 37443, `d` = the vault id: which key signs for the vault now, and where it lives. Signed
 * by an owner key it is an override: the owner rotates the vault's key or takes the vault back from a host.
 */
export async function vaultRecordEvent(signer: Key, record: { key: string; lives?: string }, opts: { vault?: string; created_at?: number } = {}): Promise<Event> {
  const id = await vaultId(opts.vault);
  return sign(signer, { kind: KIND.vaultRecord, tags: [["d", id]], content: canonical({ v: 1, honors: id, key: record.key, lives: record.lives }), created_at: opts.created_at });
}

/** A link statement (§6.2): the service says a name of its own is a person's key. No `person`: it takes the link back. */
export async function linkEvent(service: Key, name: string, person: Key | null, opts: { vault?: string; created_at?: number } = {}): Promise<Event> {
  const content = { v: 1, honors: await vaultId(opts.vault), name, is: person?.pubkey };
  return sign(service, { kind: KIND.link, tags: [["d", name]], content: canonical(content), created_at: opts.created_at });
}

/** A person's claim on a linked name (§6.2): "mine", or "not-mine". */
export async function claimEvent(person: Key, name: string, claim: "mine" | "not-mine" = "mine", opts: { vault?: string; created_at?: number } = {}): Promise<Event> {
  const content = { v: 1, honors: await vaultId(opts.vault), name, claim };
  return sign(person, { kind: KIND.confirm, tags: [["d", name]], content: canonical(content), created_at: opts.created_at });
}

// ── The door's two new calls ────────────────────────────────────────────────────────────────────────────────

const statementsUrl = (name = door().vault) => `${door().issuer}/account/vaults/${enc(name)}/statements`;

async function reply(r: Response): Promise<Reply> {
  const text = await r.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, body, headers: r.headers, text };
}

/**
 * File a statement at the door (§7.1). `as` is who carries it: the owner's account credential (the default), or a
 * key proving itself with NIP-98, or a vault credential at a level (which must be refused: §4.4).
 */
export async function file(event: Event | Record<string, unknown>, opts: { as?: "owner" | Key | Level; vault?: string } = {}): Promise<Reply> {
  const url = statementsUrl(opts.vault);
  const body = JSON.stringify({ event });
  const as = opts.as ?? "owner";
  const authorization = as === "owner" ? `Bearer ${await accountToken()}` : typeof as === "string" ? `Bearer ${await token(as, opts.vault)}` : await nostrAuth(as.secretKey, url, "POST", body);
  return reply(await safeFetch(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body }));
}

/** The statements a vault holds, as the owner sees them (or as a key sees its own). */
export async function statements(opts: { as?: "owner" | Key; vault?: string } = {}): Promise<Reply> {
  const url = statementsUrl(opts.vault);
  const as = opts.as ?? "owner";
  const authorization = as === "owner" ? `Bearer ${await accountToken()}` : await nostrAuth(as.secretKey, url, "GET");
  return reply(await safeFetch(url, { headers: { authorization } }));
}

/**
 * Sign a grant as the owner (or `signer`) and file it. Throws, in words `NO_GRANTS` matches, when the door doesn't
 * take it: that is why most of these contracts are red today, and every one of them starts here.
 */
export async function granted(g: GrantSpec, opts: { as?: "owner" | Key } = {}): Promise<Event & { grantId: string }> {
  const e = await grantEvent(g);
  const r = await file(e, { as: opts.as, vault: g.vault });
  must(r.status === 201, `no grants at this door: POST ${new URL(statementsUrl(g.vault)).pathname} answered ${r.status} ${r.text.slice(0, 120)}`);
  return e;
}

/** A grant's row in the owner's list, or undefined. */
export async function grantRow(grantId: string, opts: { vault?: string } = {}): Promise<any> {
  const list = await statements(opts);
  return (list.body?.grants ?? []).find((x: any) => x.id === grantId);
}

/** POST /account/vaults/<name>/token as a key (NIP-98), or as the signed-in owner asking for an applet (§7.2). */
export async function tokenReply(as: Key | { applet: string }, name = door().vault): Promise<Reply> {
  const url = `${door().issuer}/account/vaults/${enc(name)}/token`;
  if ("applet" in as) {
    const body = JSON.stringify({ applet: as.applet });
    return reply(await safeFetch(url, { method: "POST", headers: { authorization: `Bearer ${await accountToken()}`, "content-type": "application/json" }, body }));
  }
  return reply(await safeFetch(url, { method: "POST", headers: { authorization: await nostrAuth(as.secretKey, url, "POST") } }));
}

/** A vault token under a grant, or a failure that says the door gave none. */
export async function tokenAs(as: Key | { applet: string }, name = door().vault): Promise<string> {
  const r = await tokenReply(as, name);
  must(r.status === 200 && typeof r.body?.vault_token === "string", `the grantee got no token: POST /account/vaults/<v>/token answered ${r.status} ${r.text.slice(0, 120)}`);
  return r.body.vault_token as string;
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// Record words over the note door, because `/api/records` isn't on a box until 0.9.1 and `/api/notes` is gone at
// 1.0. Most record calls go through here, so this is the main place to move when it lands (`leaks.test.ts` and one
// call in `custodial.test.ts` use `/api/notes…` directly): `types` and `tags` ride together in `tags` here, `fields` is
// `metadata`, `body` is `content`.

export interface Rec {
  id: string;
  path: string;
  body: string;
  names: string[];
  fields: Record<string, unknown>;
  by: string | null;
  via: string | null;
  lastBy: string | null;
  lastVia: string | null;
  updatedAt: string;
}
const rec = (n: any): Rec => ({
  id: n?.id,
  path: n?.path,
  body: n?.content,
  names: (n?.tags ?? []).slice().sort(),
  fields: n?.metadata ?? {},
  by: n?.createdBy ?? null,
  via: n?.createdVia ?? null,
  lastBy: n?.lastUpdatedBy ?? null,
  lastVia: n?.lastUpdatedVia ?? null,
  updatedAt: n?.updatedAt,
});

/** A record client for one credential: a level (the owner's own token) or a bearer token got with `tokenAs`. */
export function records(who: Level | { bearer: string }, name = door().vault) {
  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    if (typeof who === "string") return rest(who, name).call(method, `/api${path}`, body, extra);
    return reply(
      await safeFetch(`${vaultUrl(name)}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${who.bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }
  return {
    call,
    /** Make a record. `onBehalfOf` sends the custodial header (§6.1). */
    make: (r: { types?: string[]; tags?: string[]; fields?: Record<string, unknown>; body?: string; path?: string | null; onBehalfOf?: string }) =>
      // `path: null` sends none: the vault assigns one (a form may not choose, §4.1).
      call("POST", "/notes", { content: r.body ?? "made-up", ...(r.path === null ? {} : { path: r.path ?? `${runId("grants")}/${runId("r")}` }), tags: [...(r.types ?? []), ...(r.tags ?? [])], ...(r.fields ? { metadata: r.fields } : {}) }, r.onBehalfOf ? { "parachute-on-behalf-of": r.onBehalfOf } : {}),
    get: (id: string) => call("GET", `/notes/${enc(id)}`),
    /** List by type (or tag), or by search word. */
    list: (q: { type?: string; search?: string } = {}) => call("GET", `/notes?limit=100${q.type ? `&tag=${enc(q.type)}` : ""}${q.search ? `&search=${enc(q.search)}` : ""}`),
    /** Edit the body, fields, or the names (types and tags) a record carries. Reads the record first for its version. */
    edit: async (id: string, change: { body?: string; fields?: Record<string, unknown>; add?: string[]; remove?: string[]; path?: string }, seenAt?: string) => {
      const patch: Record<string, unknown> = { if_updated_at: seenAt };
      if (change.body !== undefined) patch.content = change.body;
      if (change.fields) patch.metadata = change.fields;
      if (change.path) patch.path = change.path;
      if (change.add || change.remove) patch.tags = { add: change.add ?? [], remove: change.remove ?? [] };
      return call("PATCH", `/notes/${enc(id)}`, seenAt ? patch : { ...patch, if_updated_at: undefined, force: true });
    },
    remove: (id: string) => call("DELETE", `/notes/${enc(id)}`),
    /** The names in stamps that have a link, among records this credential can see (§7.1). */
    stamps: async (): Promise<{ status: number; stamps: { name: string; key: string; state: string }[] }> => {
      const r = await call("GET", "/stamps");
      return { status: r.status, stamps: r.body?.stamps ?? [] };
    },
    /** Records written by a person: by their key, or for a name with a confirmed link to it (§7.1). */
    byPerson: (pubkey: string) => call("GET", `/notes?limit=100&by_person=${enc(pubkey)}`),
    types: () => call("GET", "/tags"),
    info: () => call("GET", "/vault"),
  };
}
export { rec };

/** Declare a made-up type as the owner, so a grant has something real to name. */
export async function declareType(label: string, fields: Record<string, unknown> = { note: { type: "string" } }): Promise<string> {
  const name = runId(label);
  const r = await rest("admin").put(`/tags/${enc(name)}`, { fields });
  if (r.status !== 200) throw new Error(`setup: declaring type ${name} gave ${r.status} ${r.text.slice(0, 200)}`);
  return name;
}

/** Declare a subtype of a made-up type: named `parent/child` and declared under it, which is both of today's meanings. */
export async function declareSubtype(parent: string, label: string): Promise<string> {
  const name = `${parent}/${runId(label)}`;
  const r = await rest("admin").put(`/tags/${enc(name)}`, { parent_names: [parent], fields: {} });
  if (r.status !== 200) throw new Error(`setup: declaring subtype ${name} gave ${r.status} ${r.text.slice(0, 200)}`);
  return name;
}

/**
 * The ids in a list reply, whatever its envelope. A list is a 200; anything else throws, so `toEqual([])` can't pass
 * on a refusal. A contract that expects a refusal asserts the status itself.
 */
export const ids = (r: Reply): string[] => {
  if (r.status !== 200) throw new Error(`expected a list (200), got ${r.status} ${r.text.slice(0, 120)}`);
  return (Array.isArray(r.body) ? r.body : (r.body?.notes ?? r.body?.records ?? [])).map((n: any) => n.id).sort();
};
