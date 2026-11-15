// The synthetic vault every eval run starts from. Everything here is made up: people at example.org, invented
// projects (Alder, Birch), invented places. Never copy anything from a real vault into this file (the repo is public).
//
// Notes are named by path; the tasks' oracles compare paths, so ids can differ from run to run.

export interface FixtureNote {
  path: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, any>;
  created_at: string;
}

/** Types: tags with fields or parents (§8a of the 0.9 design). */
export const TYPES: { tag: string; description: string; fields?: Record<string, unknown>; parent_names?: string[] }[] = [
  {
    tag: "task",
    description: "Something to do",
    fields: {
      state: { type: "string", enum: ["open", "done"], indexed: true },
      due: { type: "date", indexed: true },
      project: { type: "string", indexed: true },
      owner: { type: "string", indexed: true },
    },
  },
  {
    tag: "person",
    description: "Someone we know",
    fields: { email: { type: "string" }, status: { type: "string", enum: ["active", "warm", "cold"], indexed: true } },
  },
  { tag: "event", description: "Something that happens on a day", fields: { date: { type: "date", indexed: true } } },
  { tag: "event/meeting", description: "An event with people", parent_names: ["event"] },
];

const day = (d: string, h = 9) => `${d}T${String(h).padStart(2, "0")}:00:00.000Z`;

const tasks: FixtureNote[] = [
  ["Tasks/Fix printer", "The printer on floor 2 jams on duplex.\n\n- ordered toner", { state: "open", due: "2026-11-05", project: "Alder", owner: "sam" }, "2026-10-21"],
  ["Tasks/Draft Alder budget", "Numbers for the spring phase.", { state: "open", due: "2026-11-20", project: "Alder", owner: "rowan" }, "2026-10-02"],
  ["Tasks/Book Alder venue", "Call the hall about March.", { state: "open", due: "2026-11-10", project: "Alder", owner: "sam" }, "2026-09-14"],
  ["Tasks/Alder kickoff deck", "Slides for the kickoff.", { state: "done", due: "2026-10-01", project: "Alder", owner: "rowan" }, "2026-09-03"],
  ["Tasks/Birch site survey", "Walk the north field.", { state: "open", due: "2026-12-01", project: "Birch", owner: "kit" }, "2026-10-05"],
  ["Tasks/Birch permits", "File the shed permit.", { state: "open", due: "2026-11-03", project: "Birch", owner: "sam" }, "2026-10-22"],
  ["Tasks/Birch fence quote", "Three quotes, pick one.", { state: "done", due: "2026-10-15", project: "Birch", owner: "kit" }, "2026-09-20"],
  ["Tasks/Water the seedlings", "Every other day while it's dry.", { state: "open", due: "2026-11-01", project: "Birch", owner: "kit" }, "2026-10-25"],
].map(([path, content, metadata, d]) => ({ path: path as string, content: content as string, tags: ["task"], metadata: metadata as any, created_at: day(d as string) }));

const people: FixtureNote[] = [
  ["People/Rowan Ash", "Runs the Alder project.", { status: "active" }],
  ["People/Sam Okafor", "Facilities; fixes printers.", { status: "active", email: "sam@example.org" }],
  ["People/Kit Moreno", "Birch lead, gardener.", { status: "warm", email: "kit@example.org" }],
  ["People/Jo Lindqvist", "Met at the seed swap.", { status: "cold", email: "jo@example.org" }],
  ["People/Pat Reyes", "Old colleague.", { status: "cold", email: "pat@example.org" }],
].map(([path, content, metadata], i) => ({ path: path as string, content: content as string, tags: ["person"], metadata: metadata as any, created_at: day(`2026-08-1${i}`) }));

const events: FixtureNote[] = [
  ...["Seed swap", "Harvest fair", "Open studio", "Tool library day", "River clean-up"].map((t, i) => ({
    path: `Events/${t}`,
    content: `${t}, a community event.`,
    tags: ["event"],
    metadata: { date: `2026-11-${String(4 + i * 3).padStart(2, "0")}` },
    created_at: day(`2026-09-${String(10 + i).padStart(2, "0")}`),
  })),
  ...["Alder standup 1", "Alder standup 2", "Birch planning", "Budget review", "Quarterly retro Q3", "Neighbours meeting", "Volunteer onboarding"].map((t, i) => ({
    path: `Meetings/${t}`,
    content: t === "Quarterly retro Q3" ? "Notes from the quarterly retro: what went well, what didn't." : `${t}. Notes to follow.`,
    tags: ["event/meeting"],
    metadata: { date: `2026-10-${String(3 + i * 3).padStart(2, "0")}` },
    created_at: day(`2026-10-${String(3 + i * 3).padStart(2, "0")}`, 15),
  })),
];

const reading: FixtureNote[] = [
  ["Reading/The Overstory", false],
  ["Reading/Braiding Sweetgrass", false],
  ["Reading/The Soil Will Save Us", true],
  ["Reading/Gathering Moss", false],
  ["Reading/Teaming with Microbes", true],
  ["Reading/A Pattern Language", false],
  ["Reading/The Dawn of Everything", false],
].map(([path, archived], i) => ({
  path: path as string,
  content: `Book notes for ${(path as string).slice(8)}.`,
  tags: archived ? ["reading", "archived"] : ["reading"],
  created_at: day(`2026-07-${String(2 + i).padStart(2, "0")}`),
}));

const misc: FixtureNote[] = [
  { path: "Projects/Alder", content: "# Alder\n\nThe community garden project. Owner: [[People/Rowan Ash]].", tags: ["pinned"], created_at: day("2026-06-01") },
  { path: "Projects/Birch", content: "# Birch\n\nThe north field orchard.", created_at: day("2026-06-02") },
  { path: "Alder/Kickoff notes", content: "Kickoff for [[Projects/Alder]]. Decisions below.", created_at: day("2026-09-05") },
  { path: "Alder/Volunteer list", content: "Who signed up for [[Projects/Alder]].", created_at: day("2026-09-06") },
  { path: "Alder/Kickoff follow-ups", content: "Follow-ups from [[Alder/Kickoff notes]].", created_at: day("2026-09-08") },
  { path: "Alder/Volunteer rota", content: "Shifts, built from [[Alder/Volunteer list]].", created_at: day("2026-09-09") },
  { path: "Alder/Far away", content: "Three hops out: see [[Alder/Volunteer rota]].", created_at: day("2026-09-10") },
  {
    path: "Weekly review",
    content: "# Weekly review\n\nLooked at [[Projects/Birch]], [[Tasks/Fix printer]] and [[Reading/Gathering Moss]].",
    tags: ["pinned"],
    created_at: day("2026-10-26"),
  },
  { path: "Field notes/Heronsbill", content: "Found heronsbill (Erodium) along the river path, pink flowers.", created_at: day("2026-09-25") },
  { path: "Field notes/Clover", content: "White clover is taking over the lawn.", created_at: day("2026-09-26") },
  { path: "Team/Retro format", content: "How we run the quarterly retro: 30 minutes, three columns.", tags: ["pinned"], created_at: day("2026-08-20") },
  { path: "Team/Retro actions", content: "Actions from the quarterly retro, owners named.", created_at: day("2026-10-12") },
  { path: "Daily 2026-10-28", content: "# 2026-10-28\n\n- morning: seed order\n", created_at: day("2026-10-28", 7) },
  { path: "Trip plan", content: "# Trip plan\n\nDepart Thursday on the 7:40 ferry. Bring the tide tables.", created_at: day("2026-10-15") },
  { path: "Inbox rules", content: "# Inbox rules\n\nInvoices go to the Expenses folder. Newsletters I recieve go to Reading.\nEverything else waits for Friday.", created_at: day("2026-08-01") },
  { path: "Scratch/old idea", content: "A rain gauge made from a jam jar.", created_at: day("2026-07-30") },
  { path: "Scratch/keep this", content: "Swap day on the first Saturday.", created_at: day("2026-07-31") },
  { path: "Expenses October", content: "# Expenses October\n\n- toner\n- seeds", created_at: day("2026-10-20") },
  { path: "Call notes 10-27", content: "Call with the hall about the venue. Voice memo attached.", created_at: day("2026-10-27") },
  { path: "Garden/Staking", content: "Tie the vines to canes once they reach knee height; pinch out side shoots.", created_at: day("2026-07-10") },
  { path: "Garden/Blight", content: "Brown spots on the lower leaves of the vine fruit: remove them and water at the base.", created_at: day("2026-07-11") },
  { path: "Garden/Greenhouse", content: "Sow the San Marzano and Gardener's Delight seeds in March, under glass.", created_at: day("2026-07-12") },
];

export const NOTES: FixtureNote[] = [...tasks, ...people, ...events, ...reading, ...misc];

/** The edit that gives "Trip plan" a previous version (t28). */
export const TRIP_PLAN_EDIT = { path: "Trip plan", find: "Thursday", replace: "Friday" };

/** The voice memo attached to "Call notes 10-27" (t24): made-up bytes. */
export const VOICE_MEMO = { note: "Call notes 10-27", filename: "memo-1027.m4a", bytes: new TextEncoder().encode("fake-m4a:hall-venue-call-0001") };

/** The file the model attaches in t23 (written into the run's own folder). */
export const RECEIPT = { filename: "receipt.pdf", bytes: new TextEncoder().encode("%PDF-1.4\n% made-up receipt: toner 42.00\n%%EOF\n") };
