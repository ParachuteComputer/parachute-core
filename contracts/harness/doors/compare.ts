// The second half of door parity: compare what each door's run recorded (suites/door/_door.ts `fp`).
//
// Doors on the same release line are compared key by key. A difference passes only if an entry in
// suites/door/deliberate.json names it, with a reason and an owner. An entry that names a difference between two
// kinds of door that were both in the run, and excuses nothing, fails too: the list of deliberate differences can't
// outlive the differences.
import { existsSync, readFileSync } from "node:fs";

export interface Deliberate {
  /** A short id, used in reports. */
  id: string;
  /** Fingerprint keys it excuses: exact, or with `*` for any run of characters. */
  keys: string[];
  /** The kinds of door it is a difference between, e.g. ["box", "cloud"]. Both orders match. */
  between: string[];
  /** Why the doors differ here, in a sentence a person building an app can act on. */
  why: string;
  /** Who decides if this stays: a person or a planned release. */
  owner: string;
  /** "deliberate": meant to differ. "drift": not meant, not yet fixed; `owner` says where the fix is tracked. */
  status: "deliberate" | "drift";
}

export type Fingerprint = Map<string, string>;

/** Read one door's fingerprint. The same key recorded twice with different values is an error in the suite. */
export function readFingerprint(file: string): Fingerprint {
  const fp: Fingerprint = new Map();
  if (!existsSync(file)) return fp;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { key, value } = JSON.parse(line) as { key: string; value: unknown };
    const v = JSON.stringify(value);
    if (fp.has(key) && fp.get(key) !== v) throw new Error(`fingerprint: "${key}" was recorded twice with different values in ${file}`);
    fp.set(key, v);
  }
  return fp;
}

const kindOf = (label: string) => label.split("-")[0]!;
const releaseOf = (label: string) => label.split("-").slice(1).join("-");
const matches = (pattern: string, key: string) =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(key);

function short(v: string | undefined): string {
  if (v === undefined) return "(not recorded)";
  return v.length > 160 ? `${v.slice(0, 157)}…` : v;
}

export function compare(prints: Record<string, Fingerprint>, deliberate: Deliberate[]): { ok: boolean; summary: string; report: string } {
  const labels = Object.keys(prints);
  const out: string[] = ["# Door comparison", ""];
  let unexplained = 0;
  let pairs = 0;
  let same = 0;
  const used = new Set<string>();
  const comparedKinds = new Set<string>();
  const lonely: string[] = [];
  for (const a of labels) {
    if (!labels.some((b) => b !== a && releaseOf(b) === releaseOf(a))) lonely.push(a);
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i]!, labels[j]!];
      if (releaseOf(a) !== releaseOf(b)) continue;
      pairs++;
      comparedKinds.add([kindOf(a), kindOf(b)].sort().join("|"));
      const keys = [...new Set([...prints[a]!.keys(), ...prints[b]!.keys()])].sort();
      const rows: string[] = [];
      for (const key of keys) {
        const [va, vb] = [prints[a]!.get(key), prints[b]!.get(key)];
        if (va === vb) {
          same++;
          continue;
        }
        const excuse = deliberate.find((d) => d.keys.some((p) => matches(p, key)) && d.between.includes(kindOf(a)) && d.between.includes(kindOf(b)));
        if (excuse) used.add(excuse.id);
        else unexplained++;
        rows.push(`| \`${key}\` | ${short(va).replace(/\|/g, "\\|")} | ${short(vb).replace(/\|/g, "\\|")} | ${excuse ? `${excuse.status}: ${excuse.id}` : "**UNEXPLAINED**"} |`);
      }
      out.push(`## ${a} and ${b}`, "", `${keys.length} facts recorded, ${rows.length} differ.`, "");
      if (rows.length) out.push(`| Fact | ${a} | ${b} | Verdict |`, "|---|---|---|---|", ...rows, "");
    }
  }
  // An entry is stale when the two kinds it names were compared and it excused nothing.
  const stale = deliberate.filter((d) => !used.has(d.id) && comparedKinds.has([...d.between].sort().join("|")));
  if (stale.length) out.push("## Entries in deliberate.json that excuse nothing", "", ...stale.map((d) => `- ${d.id}: ${d.keys.join(", ")}`), "");
  if (lonely.length) out.push("## Doors with no partner on the same release", "", ...lonely.map((l) => `- ${l}: ran the contracts, compared with nothing`), "");
  const usedList = deliberate.filter((d) => used.has(d.id));
  if (usedList.length) out.push("## Differences named in deliberate.json", "", ...usedList.map((d) => `- **${d.id}** (${d.status}; ${d.between.join(" and ")}; owner: ${d.owner}): ${d.why}`), "");
  const ok = unexplained === 0 && stale.length === 0 && pairs > 0;
  const summary = `${ok ? "PASS" : "FAIL"} compare (${pairs} pair${pairs === 1 ? "" : "s"}; ${same} facts equal; ${used.size} named differences; ${unexplained} unexplained; ${stale.length} stale entries${lonely.length ? `; no partner: ${lonely.join(", ")}` : ""})`;
  out.splice(2, 0, summary, "");
  return { ok, summary, report: `${out.join("\n")}\n` };
}
