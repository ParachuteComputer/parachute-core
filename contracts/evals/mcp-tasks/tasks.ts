// The 31 tasks (T-318 design rev 4, evals/mcp-tasks/tasks.json), each with an oracle the harness runs itself.
// Success is decided from the vault's end state, the calls the proxy logged, or the model's final ANSWER line,
// never from the model saying it succeeded.
//
// Changes from the draft task set, so every task has one right answer on a synthetic vault:
// - t09 asks about a closed created_at range (the vault's own guide notes are created at run time).
// - t10 and t11 name the direction of the links; t13 counts each type on its own; t15 drops "journal-free".
// - t25/t26 are one mint and one mint-then-revoke (each run starts from a fresh box).
// - t31 (semantic) is skipped: the eval box has no embeddings, as the 0.8 bundle has none.
import { NOTES, RECEIPT, TRIP_PLAN_EDIT, VOICE_MEMO, type FixtureNote } from "./fixture.ts";

export interface Call {
  server: string;
  name: string;
  args: Record<string, any>;
  isError: boolean;
  result?: string;
}

export interface Note {
  id: string;
  path?: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface Ctx {
  answer: unknown; // parsed from the final `ANSWER:` line (JSON, else the raw string); undefined when missing
  text: string; // the model's final message
  calls: Call[];
  notes(): Promise<Note[]>; // every note in the vault, read by the harness with the operator pass
  vault: { call<T = any>(name: string, args: Record<string, unknown>): Promise<T> };
  fetchBytes(url: string): Promise<Uint8Array | null>;
  tokenWorks(token: string): Promise<boolean>;
  receiptPath: string;
}

export interface Task {
  id: string;
  family: string;
  prompt: (ctx: { receiptPath: string }) => string;
  check: (ctx: Ctx) => Promise<string | true>; // true, or why it failed
  skip?: string;
}

const fx = (path: string) => NOTES.find((n) => n.path === path)!;
const norm = (s: string) => s.replace(/\.md$/i, "").replace(/^\/+/, "").trim().toLowerCase();

/** Map what the model gave (paths, ids, or bare titles) to vault paths. */
async function asPaths(ctx: Ctx, v: unknown): Promise<string[] | null> {
  if (!Array.isArray(v)) return null;
  const notes = await ctx.notes();
  const out: string[] = [];
  for (const item of v) {
    const s = typeof item === "string" ? item : typeof item === "object" && item ? String((item as any).path ?? (item as any).id ?? "") : "";
    const k = norm(s);
    const hit =
      notes.find((n) => n.id.toLowerCase() === k) ??
      notes.find((n) => norm(n.path ?? "") === k) ??
      (notes.filter((n) => norm((n.path ?? "").split("/").pop()!) === k).length === 1 ? notes.find((n) => norm((n.path ?? "").split("/").pop()!) === k) : undefined);
    out.push(hit?.path ?? `?${s}`);
  }
  return out.sort();
}

function sameSet(got: string[] | null, want: string[]): string | true {
  if (!got) return "no list in ANSWER";
  const w = [...want].sort();
  return JSON.stringify(got) === JSON.stringify(w) ? true : `got ${JSON.stringify(got)}, want ${JSON.stringify(w)}`;
}

// A count may come bare or as {count: N} / {total: N}; formatting is not what the eval measures.
const num = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? Number(v)
      : v && typeof v === "object" && !Array.isArray(v) && ("count" in v || "total" in v)
        ? num((v as any).count ?? (v as any).total)
        : NaN;

function sameCounts(got: unknown, want: Record<string, number>, lenient: Record<string, number[]> = {}): string | true {
  if (!got || typeof got !== "object" || Array.isArray(got)) return "no object in ANSWER";
  const g = Object.fromEntries(Object.entries(got as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), num(v)]));
  for (const [k, v] of Object.entries(want)) {
    const ok = lenient[k] ? lenient[k]!.includes(g[k]!) : g[k] === v;
    if (!ok) return `${k}: got ${g[k]}, want ${lenient[k] ? lenient[k]!.join(" or ") : v}`;
  }
  const extra = Object.entries(g).filter(([k, v]) => !(k in want) && v !== 0);
  return extra.length ? `unexpected groups ${JSON.stringify(extra)}` : true;
}

async function noteAt(ctx: Ctx, path: string): Promise<Note | undefined> {
  return (await ctx.notes()).find((n) => norm(n.path ?? "") === norm(path));
}

/** The fixture note, unchanged apart from `content`, `metadata` as given. */
async function onlyChanged(ctx: Ctx, path: string, want: { content?: string; metadata?: Record<string, unknown> }): Promise<string | true> {
  const n = await noteAt(ctx, path);
  if (!n) return `${path} is gone`;
  const f = fx(path);
  const content = want.content ?? (path === TRIP_PLAN_EDIT.path ? f.content.replace(TRIP_PLAN_EDIT.find, TRIP_PLAN_EDIT.replace) : f.content);
  if ((n.content ?? "") !== content) return `content is ${JSON.stringify(n.content)}, want ${JSON.stringify(content)}`;
  const meta = { ...(f.metadata ?? {}), ...(want.metadata ?? {}) };
  for (const [k, v] of Object.entries(meta)) if (String(n.metadata?.[k]) !== String(v)) return `metadata.${k} is ${JSON.stringify(n.metadata?.[k])}, want ${JSON.stringify(v)}`;
  return true;
}

const byFixture = (pred: (n: FixtureNote) => boolean) => NOTES.filter(pred).map((n) => n.path);
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
const jwtsIn = (s: string) => [...s.matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)].map((m) => m[0]);

const openTasks = (pred: (m: Record<string, any>) => boolean) => byFixture((n) => !!n.tags?.includes("task") && n.metadata!.state === "open" && pred(n.metadata!));

export const TASKS: Task[] = [
  {
    id: "t01",
    family: "find-text",
    prompt: () => "Find the note that mentions the word 'heronsbill' and tell me its id.",
    async check(ctx) {
      const n = await noteAt(ctx, "Field notes/Heronsbill");
      return typeof ctx.answer === "string" && ctx.answer.trim() === n?.id ? true : `answer ${JSON.stringify(ctx.answer)}, want ${n?.id}`;
    },
  },
  {
    id: "t02",
    family: "find-text",
    prompt: () => "Which notes mention 'quarterly retro'? Give the count.",
    check: async (ctx) => (num(ctx.answer) === 3 ? true : `answer ${JSON.stringify(ctx.answer)}, want 3`),
  },
  {
    id: "t03",
    family: "find-tag",
    prompt: () => "List the notes tagged 'pinned'.",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => !!n.tags?.includes("pinned"))),
  },
  {
    id: "t04",
    family: "find-tag",
    prompt: () => "How many notes are tagged 'reading'?",
    check: async (ctx) => (num(ctx.answer) === 7 ? true : `answer ${JSON.stringify(ctx.answer)}, want 7`),
  },
  {
    id: "t05",
    family: "find-type",
    prompt: () => "List the open tasks (type task) for project Alder.",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), openTasks((m) => m.project === "Alder")),
  },
  {
    id: "t06",
    family: "find-type",
    prompt: () => "How many notes are of type 'event' or any subtype of it?",
    check: async (ctx) => (num(ctx.answer) === 12 ? true : `answer ${JSON.stringify(ctx.answer)}, want 12`),
  },
  {
    id: "t07",
    family: "metadata-op",
    prompt: () => "Which tasks (open or done) are due before 2026-11-15?",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => !!n.tags?.includes("task") && n.metadata!.due < "2026-11-15")),
  },
  {
    id: "t08",
    family: "metadata-op",
    prompt: () => "Find the people whose status is 'active' or 'warm'.",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => !!n.tags?.includes("person") && ["active", "warm"].includes(n.metadata!.status))),
  },
  {
    id: "t09",
    family: "metadata-op",
    prompt: () => "Which notes were created between 2026-10-20 and 2026-10-26, both days included?",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => n.created_at.slice(0, 10) >= "2026-10-20" && n.created_at.slice(0, 10) <= "2026-10-26")),
  },
  {
    id: "t10",
    family: "near",
    prompt: () => "Which notes link to 'Projects/Alder', directly or through one note in between (inbound links, up to two hops)? Don't include Projects/Alder itself.",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), ["Alder/Kickoff notes", "Alder/Volunteer list", "Alder/Kickoff follow-ups", "Alder/Volunteer rota"]),
  },
  {
    id: "t11",
    family: "near",
    prompt: () => "Which notes does 'Weekly review' link to?",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), ["Projects/Birch", "Tasks/Fix printer", "Reading/Gathering Moss"]),
  },
  {
    id: "t12",
    family: "aggregate",
    prompt: () => "Count the open tasks per owner.",
    check: async (ctx) => sameCounts(ctx.answer, { sam: 3, rowan: 1, kit: 2 }),
  },
  {
    id: "t13",
    family: "aggregate",
    prompt: () => "How many notes are there of each of the types task, person, event and event/meeting?",
    check: async (ctx) => sameCounts(ctx.answer, { task: 8, person: 5, event: 5, "event/meeting": 7 }, { event: [5, 12] }),
  },
  {
    id: "t14",
    family: "append",
    prompt: () => "Add the line '- called the printer' to the end of the task 'Fix printer'.",
    async check(ctx) {
      const n = await noteAt(ctx, "Tasks/Fix printer");
      const f = fx("Tasks/Fix printer").content;
      const c = n?.content ?? "";
      if (!c.startsWith(f)) return `original content changed: ${JSON.stringify(c)}`;
      return c.trimEnd().endsWith("- called the printer") && c.split("- called the printer").length === 2 ? true : `content ${JSON.stringify(c)}`;
    },
  },
  {
    id: "t15",
    family: "append",
    prompt: () => "Log 'standup done' at the end of the note 'Daily 2026-10-28'.",
    async check(ctx) {
      const c = (await noteAt(ctx, "Daily 2026-10-28"))?.content ?? "";
      const f = fx("Daily 2026-10-28").content;
      if (!c.startsWith(f.trimEnd())) return `original content changed: ${JSON.stringify(c)}`;
      return /standup done\W*$/.test(c.trimEnd()) ? true : `content ${JSON.stringify(c)}`;
    },
  },
  {
    id: "t16",
    family: "content-edit",
    prompt: () => "In 'Trip plan', change 'Friday' to 'Saturday'.",
    check: (ctx) => onlyChanged(ctx, "Trip plan", { content: fx("Trip plan").content.replace("Thursday", "Saturday") }),
  },
  {
    id: "t17",
    family: "content-edit",
    prompt: () => "Fix the typo 'recieve' in 'Inbox rules'.",
    check: (ctx) => onlyChanged(ctx, "Inbox rules", { content: fx("Inbox rules").content.replace("recieve", "receive") }),
  },
  {
    id: "t18",
    family: "upsert",
    prompt: () => "Make sure there is a person note 'People/Rowan Ash' with the email rowan@example.org. Don't make a duplicate.",
    async check(ctx) {
      const all = (await ctx.notes()).filter((n) => /rowan ash/i.test(n.path ?? ""));
      if (all.length !== 1) return `${all.length} Rowan Ash notes: ${all.map((n) => n.path).join(", ")}`;
      const n = all[0]!;
      if (n.metadata?.email !== "rowan@example.org") return `email is ${JSON.stringify(n.metadata?.email)}`;
      return n.tags?.includes("person") && n.metadata?.status === "active" ? true : `lost tag or status: ${JSON.stringify({ tags: n.tags, status: n.metadata?.status })}`;
    },
  },
  {
    id: "t19",
    family: "upsert",
    prompt: () => "Record today's reading count, 12, as the metadata field `count` on the note 'Stats/Reading' (create the note if it's missing).",
    async check(ctx) {
      const all = (await ctx.notes()).filter((n) => /stats\/reading/i.test(n.path ?? ""));
      if (all.length !== 1) return `${all.length} Stats/Reading notes`;
      return num(all[0]!.metadata?.count) === 12 ? true : `count is ${JSON.stringify(all[0]!.metadata?.count)}`;
    },
  },
  {
    id: "t20",
    family: "create",
    prompt: () => "Create a task 'Order seeds', due 2026-11-02, for project Alder.",
    async check(ctx) {
      const hits = (await ctx.notes()).filter((n) => /order seeds/i.test(`${n.path ?? ""}\n${n.content ?? ""}`) && n.tags?.includes("task"));
      if (hits.length !== 1) return `${hits.length} task notes for 'Order seeds'`;
      const m = hits[0]!.metadata ?? {};
      return String(m.due ?? "").startsWith("2026-11-02") && m.project === "Alder" ? true : `metadata ${JSON.stringify(m)}`;
    },
  },
  {
    id: "t21",
    family: "update-meta",
    prompt: () => "Mark the task 'Fix printer' done.",
    check: (ctx) => onlyChanged(ctx, "Tasks/Fix printer", { metadata: { state: "done" } }),
  },
  {
    id: "t22",
    family: "delete",
    prompt: () => "Delete the note 'Scratch/old idea'.",
    async check(ctx) {
      const paths = (await ctx.notes()).map((n) => n.path);
      if (paths.includes("Scratch/old idea")) return "still there";
      const missing = NOTES.map((n) => n.path).filter((p) => p !== "Scratch/old idea" && !paths.includes(p));
      return missing.length ? `also gone: ${missing.join(", ")}` : true;
    },
  },
  {
    id: "t23",
    family: "attach",
    prompt: ({ receiptPath }) => `Attach the file ${receiptPath} to the note 'Expenses October'.`,
    async check(ctx) {
      const r = await ctx.vault.call("query-notes", { id: "Expenses October", include_attachments: true });
      const note = Array.isArray(r) ? r[0] : (r.notes?.[0] ?? r);
      const atts: any[] = note?.attachments ?? [];
      const att = atts.find((a) => /receipt/i.test(a.metadata?.original_name ?? a.filename ?? "") || /\.pdf$/i.test(a.path ?? ""));
      if (!att) return `no receipt attachment (${atts.length} attachments)`;
      const t = await ctx.vault.call("request-attachment-download", { attachment_id: att.id });
      const bytes = await ctx.fetchBytes(t.url);
      return bytes && Buffer.from(bytes).equals(Buffer.from(RECEIPT.bytes)) ? true : "attachment bytes differ";
    },
  },
  {
    id: "t24",
    family: "attach",
    prompt: () => "Give me a download link for the voice memo attached to 'Call notes 10-27'. Put the link in the ANSWER line.",
    async check(ctx) {
      const url = (typeof ctx.answer === "string" ? ctx.answer : ctx.text).match(/https?:\/\/[^\s"'<>)\]]+/)?.[0];
      if (!url) return "no URL";
      const bytes = await ctx.fetchBytes(url);
      return bytes && Buffer.from(bytes).equals(Buffer.from(VOICE_MEMO.bytes)) ? true : "the URL doesn't give the memo's bytes";
    },
  },
  {
    id: "t25",
    family: "key",
    prompt: () => "Mint a read-only key for this vault that expires in one hour.",
    async check(ctx) {
      const tokens = ctx.calls.filter((c) => !c.isError).flatMap((c) => jwtsIn(c.result ?? ""));
      if (!tokens.length) return "no key minted";
      const t = tokens[tokens.length - 1]!;
      const p = jwtPayload(t);
      const scopes = String(p.scope ?? "").split(" ");
      if (scopes.some((s) => /:(write|admin)$/.test(s))) return `scope ${p.scope}`;
      if (!scopes.some((s) => /:read$/.test(s))) return `no read scope: ${p.scope}`;
      if (!(p.exp - p.iat <= 3660)) return `lives ${p.exp - p.iat}s`;
      return (await ctx.tokenWorks(t)) ? true : "the key doesn't work";
    },
  },
  {
    id: "t26",
    family: "key",
    prompt: () => "Mint a read-only key for this vault labelled 'eval-temp', then revoke it.",
    async check(ctx) {
      const tokens = ctx.calls.filter((c) => !c.isError).flatMap((c) => jwtsIn(c.result ?? ""));
      if (!tokens.length) return "no key minted";
      // The vault caches the hub's revocation list for 60 s, so the oracle reads the hub's own record instead.
      const list = await ctx.vault.call("manage-token", { action: "list" });
      for (const t of tokens) {
        const row = (list.tokens ?? []).find((r: any) => r.jti === jwtPayload(t).jti);
        if (!row?.revoked_at) return "a key minted in this run is not revoked";
      }
      return true;
    },
  },
  {
    id: "t27",
    family: "rare-cursor",
    prompt: () => "Page through every note of type 'event' (subtypes included) using a cursor, 5 notes per page, and give the total count.",
    async check(ctx) {
      if (num(ctx.answer) !== 12) return `answer ${JSON.stringify(ctx.answer)}, want 12`;
      return ctx.calls.some((c) => c.name === "query-notes" && "cursor" in (c.args ?? {}) && !c.isError) ? true : "never used cursor";
    },
  },
  {
    id: "t28",
    family: "rare-versions",
    prompt: () => "What did 'Trip plan' say before its last edit? Quote the old sentence about departing.",
    check: async (ctx) => (/thursday/i.test(`${typeof ctx.answer === "string" ? ctx.answer : ""}\n${ctx.text}`) ? true : "no 'Thursday' in the answer"),
  },
  {
    id: "t29",
    family: "rare-exclude",
    prompt: () => "List the notes tagged 'reading' that are not tagged 'archived'.",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => !!n.tags?.includes("reading") && !n.tags.includes("archived"))),
  },
  {
    id: "t30",
    family: "rare-date-filter",
    prompt: () => "Which notes were created in September 2026?",
    check: async (ctx) => sameSet(await asPaths(ctx, ctx.answer), byFixture((n) => n.created_at.startsWith("2026-09"))),
  },
  {
    id: "t31",
    family: "rare-semantic",
    prompt: () => "Find notes about 'growing tomatoes' even if they don't use those words.",
    check: async () => "skipped",
    skip: "the eval box has no embeddings (the 0.8 bundle ships none); kept so the set matches the design",
  },
];
