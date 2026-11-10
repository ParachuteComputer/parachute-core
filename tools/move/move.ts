#!/usr/bin/env bun
// parachute-move: move one vault from one door to another, and prove it arrived the same.
//
//   bun move.ts plan  <from.json> <to.json> --vault <name> [--as <new name>]
//   bun move.ts run   <from.json> <to.json> --vault <name> [--as <new name>] --out <folder>
//   bun move.ts verify <folder>                      read both doors again and compare with what the move recorded
//   bun move.ts close <folder> --keep "<why>" | --disconnect | --delete
//   bun move.ts digest <door.json> --vault <name>
//
// A door file names a door and where its credentials are kept (doors.ts). `run` does, in order: plan, digest the
// source, export, import into a NEW vault, digest the target, digest the source again, compare all three. It writes
// MOVE.json (the manifest), REKEY.md (who has to reconnect) and, under private/, the digests' lines. `close` is a
// second command on purpose: the old door is only touched after the owner has looked at the new one.
//
//   --accept-format-loss   go ahead though the plan found notes the export format can't carry exactly; the
//                          verdict then excuses exactly those notes and no others
//   --operator             the target door is entered as its operator, for an owner named in the door file
//   --production           allow a parachute.computer host
//   --live-box             allow this machine's own ~/.parachute as a box
//
// Nothing secret is taken on the command line or printed. Exit 0 only for a verified move.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareDigests, SECTIONS, type Digest } from "./digest.ts";
import { filesFromExport, openDoor, type Door } from "./doors.ts";
import { tar } from "./tar.ts";

export const MANIFEST_FORMAT = "parachute-move/1";
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const has = (name: string): boolean => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const publicDigest = (d: Digest) => ({ reader: d.reader, counts: d.counts, digests: d.digests });

interface Plan {
  ok: boolean;
  lines: string[];
  source: Digest;
  from: string;
  to: string;
  down: boolean;
  accept: string[];
  name: string;
}

async function plan(from: Door, to: Door, vault: string, as: string, acceptLoss: boolean): Promise<Plan> {
  const lines: string[] = [];
  let ok = true;
  const say = (good: boolean, line: string) => {
    lines.push(`${good ? "ok  " : "STOP"} ${line}`);
    if (!good) ok = false;
  };
  const [fr, tr] = [await from.release(), await to.release()];
  if (!(await from.hasVault(vault))) die(`${from.where} has no vault named ${vault}`);
  const taken = await to.hasVault(as);
  say(!taken, taken ? `${to.where} already has a vault named ${as}: pass --as <another name>, or close the old one first` : `the name ${as} is free at ${to.where}`);
  const source = await from.digest(vault);
  lines.push(`     ${vault} at ${from.where} (${from.kind} ${fr}): ${source.counts.notes} notes, ${source.counts.links} links, ${source.counts.attachments} files, ${source.counts.tag_schemas} types`);
  const missing = source.lines.attachments.filter((l) => /"(MISSING|HTTP\d+)"\]$/.test(l)).length;
  say(missing === 0, missing ? `${missing} file(s) are listed on notes but their bytes are gone at the source` : "every attached file's bytes are there");
  const big = to.kind === "box" ? [] : source.files.filter((f) => f.size > MAX_FILE_BYTES);
  say(big.length === 0, big.length ? `${big.length} file(s) are over 50 MiB, the most this door takes in one piece` : "every file fits the target's door");
  const down = fr === "0.9" && tr === "0.8";
  if (down && source.counts.bare_types) lines.push(`     going from 0.9 to 0.8: ${source.counts.bare_types} type(s) with no fields will come back as tags (they become types again on a 0.9 door)`);
  const risky = [...new Set(source.risks.map((r) => r.id))];
  if (risky.length) {
    const why = [...new Set(source.risks.map((r) => r.why))];
    say(acceptLoss, `${risky.length} note(s) hold something the export format doesn't carry exactly (${why.join("; ")})${acceptLoss ? ": accepted with --accept-format-loss" : ": fix them, or pass --accept-format-loss to move them as the format writes them"}`);
  } else lines.push("ok   every note is in a shape the export format carries exactly");
  lines.push(`     does not travel: earlier versions of notes${source.reader === "box-db" ? ` (${source.counts.versions} kept at the source)` : ""}; who wrote each note (${source.counts.attributed_notes} stamped); any credential`);
  return { ok, lines, source, from: fr, to: tr, down, accept: acceptLoss ? risky : [], name: as };
}

function rekey(from: Door, to: Door, vault: string, as: string, who: Awaited<ReturnType<Door["whoHolds"]>>, description: string): string {
  const urls = to.urls(as);
  const old = from.urls(vault);
  const out = [`# After the move: who has to reconnect`, "", `The vault **${vault}** moved from ${from.where} to ${to.where}${as !== vault ? ` as **${as}**` : ""}.`, ""];
  out.push("No credential moves with a vault: each one names the door that signed it. What you hold yourself still works:", "");
  out.push("- **Your own key.** On a 0.9 door you sign in with your Nostr key. The same key signs in at the new door if it is listed there as the owner's.", "");
  out.push("## New addresses", "");
  if (urls) out.push(`- Vault (REST): \`${urls.vault}/api\``, `- MCP: \`${urls.mcp}\``, "");
  else out.push("- The box serves the vault at `<your box's address>/vault/" + as + "` (REST under `/api`, MCP at `/mcp`).", "");
  out.push("## Reconnect", "");
  if (who) {
    if (who.apps.length) out.push("Connected apps at the old door. Add each one again with the new MCP address and approve it:", "", ...who.apps.map((a) => `- [ ] ${a}`), "");
    else out.push("No connected apps were listed at the old door.", "");
    if (who.keys.length) {
      out.push("Named app keys at the old door. Make each again at the new door and give the app its new key:", "", ...who.keys.map((k) => `- [ ] \`${k.name}\` (${k.can})${to.kind !== "box" ? `: \`POST /account/keys {"name":"${k.name}","vault":"${as}","can":"${k.can}"}\`` : `: \`parachute keys new ${k.name}\``}`), "");
    }
  } else {
    out.push(from.kind === "box" ? "The old door is a box: list what holds a key with `parachute keys list` (0.9) or `parachute auth tokens` on it. Each app needs a new key from the new door." : "The old door's connected apps were not listed (an operator can't see them). The owner reconnects each app at the new address.", "");
  }
  out.push("## Also check", "");
  out.push("- [ ] Links you shared that name the old host (a published note, a file's address) point at the old door.");
  out.push("- [ ] Automations that live on a door, not in the vault, did not move: a box's triggers and webhooks, its git mirror, cloud's nightly snapshots.");
  out.push("- [ ] An app that stored a file's id (not its path) must look the file up again: files keep their paths and bytes, their ids are new.");
  out.push(description ? "" : "- [ ] The vault's description was not set by the move: set it once the new door serves the vault.");
  out.push("", "## The old door", "");
  out.push(`It still holds the vault${old ? ` at \`${old.vault}\`` : ""}, with its history. Nothing there was changed. When the new door looks right:`, "");
  out.push("```", "bun move.ts close <this folder> --disconnect      stop every connected app and named key at the old door; keep the vault", "bun move.ts close <this folder> --delete          remove it (its history and backups go with it)", 'bun move.ts close <this folder> --keep "<why>"    leave it as it is, and say why', "```", "");
  return out.join("\n");
}

async function run(): Promise<void> {
  const [fromFile, toFile] = argv.splice(0, 2);
  const vault = flag("--vault");
  const outDir = flag("--out");
  const as = flag("--as") ?? vault;
  const opts = { production: has("--production"), liveBox: has("--live-box") };
  const operator = has("--operator");
  const acceptLoss = has("--accept-format-loss");
  if (!fromFile || !toFile || !vault || !as || (cmd === "run" && !outDir)) die("usage: move.ts plan|run <from.json> <to.json> --vault <name> [--as <new name>] [--out <folder>]", 2);
  const scratch = join(process.env.TMPDIR ?? tmpdir(), `parachute-move-${process.pid}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const from = openDoor(fromFile!, { scratch, ...opts });
    const to = openDoor(toFile!, { scratch, ...opts, asOperator: operator });
    const t0 = Date.now();
    console.log(`== plan: ${vault} from ${from.where} to ${to.where}${as !== vault ? ` as ${as}` : ""}`);
    const p = await plan(from, to, vault!, as!, acceptLoss);
    for (const l of p.lines) console.log(l);
    if (!p.ok) die("PLAN: not moved. Nothing was changed.", 1);
    if (cmd === "plan") {
      console.log("PLAN: ready. Nothing was changed.");
      return;
    }
    const out = resolve(outDir!);
    const priv = join(out, "private");
    mkdirSync(priv, { recursive: true, mode: 0o700 });
    chmodSync(priv, 0o700);
    const log = (line: string) => console.log(`     ${line}`);

    console.log("== export");
    const exported = await from.export(vault!);
    const packed = tar(exported.files);
    const files = filesFromExport(exported, p.source);
    log(`${exported.files.length} files by ${exported.how}; ${files.length} attached file(s) match the source's bytes`);
    const description = (await from.description(vault!)) ?? "";

    console.log("== import");
    await to.importNew(as!, exported, files, log);

    // The export carries the description, but no door's import applies it: it is set again here, before the
    // target is read, so the digest holds it too.
    const described = description ? await to.describe(as!, description) : false;

    console.log("== verify");
    const target = await to.digest(as!);
    const again = await from.digest(vault!);
    const still = compareDigests(p.source, again, { names: ["source before", "source after"] });
    const atHandOver = operator && !!description;
    const moved = compareDigests(p.source, target, { acceptNotes: p.accept, dropBareTypes: p.down, descriptionAtHandOver: atHandOver, names: ["source", "target"] });
    for (const l of moved.lines) console.log(l);
    if (!still.ok || still.verdict !== "DIGEST EQUAL") console.log("the source changed while it was being moved:\n" + still.lines.join("\n"));
    const verified = moved.ok && still.verdict === "DIGEST EQUAL";
    if (verified) await to.finish(as!, `move ${vault}`, description || undefined);

    const who = await from.whoHolds(vault!).catch(() => null);
    const manifest = {
      format: MANIFEST_FORMAT,
      export_format: "portable-md 1",
      vault,
      moved_as: as,
      source: { door: from.kind, where: from.where, release: p.from },
      target: { door: to.kind, where: to.where, release: p.to, entered_as: operator ? "operator" : "owner" },
      exported: { by: exported.how, files: exported.files.length, tar_sha256: sha256(packed), tar_bytes: packed.length },
      attached_files: files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: f.sha256 })),
      digests: { source: publicDigest(p.source), source_after: publicDigest(again), target: publicDigest(target) },
      policy: {
        history: "does not travel; the old door keeps it until it is closed",
        written_by: `does not travel (${p.source.counts.attributed_notes} note(s) carried a stamp at the source)`,
        credentials: "none travel; see REKEY.md",
        description: description ? (described ? "set again at the target, and in the digest" : atHandOver ? "set by the door when the vault was handed to its owner" : "not set by the move") : "none at the source",
        ...(p.down ? { release: `0.9 to 0.8: ${p.source.counts.bare_types} type(s) with no fields become tags` } : {}),
      },
      accepted_before_the_move: p.accept.length ? { notes: p.accept.length, why: [...new Set(p.source.risks.map((r) => r.why))] } : null,
      verdict: verified ? moved.verdict : still.verdict !== "DIGEST EQUAL" ? "SOURCE CHANGED DURING THE MOVE" : moved.verdict,
      verified,
      seconds: Math.round((Date.now() - t0) / 1000),
      closed: null as null | Record<string, unknown>,
      doors: { from: resolve(fromFile!), to: resolve(toFile!) },
    };
    writeFileSync(join(out, "MOVE.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(out, "REKEY.md"), rekey(from, to, vault!, as!, who, described || atHandOver ? description : ""));
    // The lines hold ids, paths and tag names: the owner's data, kept beside the manifest and never printed.
    for (const [name, d] of [["source", p.source], ["source-after", again], ["target", target]] as const) {
      writeFileSync(join(priv, `${name}.digest.json`), JSON.stringify(d), { mode: 0o600 });
    }
    writeFileSync(join(out, "VERIFY.txt"), `${[...p.lines, ...moved.lines, ...(still.verdict === "DIGEST EQUAL" ? ["source unchanged during the move"] : still.lines)].join("\n")}\n`);
    if (!verified) {
      console.log(`RESULT: NOT VERIFIED (${manifest.verdict}). The new vault ${as} at ${to.where} is left as it is for you to look at; the old one was not touched.`);
      process.exit(1);
    }
    console.log(`RESULT: MOVED AND VERIFIED: ${vault} is at ${to.where}${as !== vault ? ` as ${as}` : ""} (${manifest.verdict}, ${manifest.seconds} s). The old door still holds it: see REKEY.md, then close it.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function close(): Promise<void> {
  const dir = resolve(argv.shift() ?? die("usage: move.ts close <folder> --keep \"<why>\" | --disconnect | --delete", 2));
  const keep = flag("--keep");
  const disconnect = has("--disconnect");
  const del = has("--delete");
  const opts = { production: has("--production"), liveBox: has("--live-box") };
  if ([keep !== undefined, disconnect, del].filter(Boolean).length !== 1) die("say one of --keep \"<why>\", --disconnect, --delete", 2);
  const file = join(dir, "MOVE.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (m.format !== MANIFEST_FORMAT || !m.verified) die("that move was not verified: there is nothing to close", 1);
  if (m.closed) die(`already closed: ${JSON.stringify(m.closed)}`, 1);
  const scratch = join(process.env.TMPDIR ?? tmpdir(), `parachute-move-${process.pid}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const from = openDoor(m.doors.from, { scratch, ...opts });
    const before = JSON.parse(readFileSync(join(dir, "private", "source.digest.json"), "utf8")) as Digest;
    const now = await from.digest(m.vault);
    const same = compareDigests(before, now, { names: ["at the move", "now"] });
    const at = new Date().toISOString();
    if (keep !== undefined) {
      m.closed = { how: "kept", why: keep, at, changed_since_the_move: same.verdict !== "DIGEST EQUAL" };
      console.log(`kept: ${m.vault} stays at ${from.where}. ${same.verdict === "DIGEST EQUAL" ? "Nothing was written there since the move." : "It has been written to since the move: the two copies now differ."}`);
    } else if (same.verdict !== "DIGEST EQUAL") {
      for (const l of same.lines) console.log(l);
      die(`refused: ${m.vault} at ${from.where} was written to after the move. Those changes are not at the new door. Move again, or close with --keep.`, 1);
    } else if (disconnect) {
      const stopped = await from.disconnect(m.vault);
      m.closed = { how: "disconnected", stopped, at };
      console.log(`disconnected ${stopped.length} holder(s) at ${from.where}${stopped.length ? `: ${stopped.join(", ")}` : ""}. The vault and its history stay; only the owner can write there now.`);
    } else {
      await from.remove(m.vault);
      m.closed = { how: "deleted", at, note: "its history and the door's backups of it went with it" };
      console.log(`deleted: ${m.vault} is gone from ${from.where}.`);
    }
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Read both doors again, any time after a move: are the two copies still what the move recorded? */
async function verify(): Promise<void> {
  const dir = resolve(argv.shift() ?? die("usage: move.ts verify <folder>", 2));
  const opts = { production: has("--production"), liveBox: has("--live-box") };
  const m = JSON.parse(readFileSync(join(dir, "MOVE.json"), "utf8"));
  if (m.format !== MANIFEST_FORMAT) die("not a move folder", 1);
  const scratch = join(process.env.TMPDIR ?? tmpdir(), `parachute-move-${process.pid}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const recorded = JSON.parse(readFileSync(join(dir, "private", "source.digest.json"), "utf8")) as Digest;
    const accept = m.accepted_before_the_move ? [...new Set(recorded.risks.map((r) => r.id))] : [];
    const down = m.source.release === "0.9" && m.target.release === "0.8";
    let ok = true;
    if (m.closed?.how !== "deleted") {
      const src = await openDoor(m.doors.from, { scratch, ...opts }).digest(m.vault);
      const c = compareDigests(recorded, src, { names: ["source at the move", "source now"] });
      console.log(c.verdict === "DIGEST EQUAL" ? `the old door (${m.source.where}) still holds what was moved` : c.lines.join("\n"));
    }
    // An operator's hold on a vault ends when it is handed over; after that only its owner reads it.
    const target = await openDoor(m.doors.to, { scratch, ...opts }).digest(m.moved_as);
    const c = compareDigests(recorded, target, { acceptNotes: accept, dropBareTypes: down, names: ["source at the move", "target now"] });
    for (const l of c.lines) console.log(l);
    ok = c.ok;
    console.log(ok ? `VERIFY: the new door (${m.target.where}) holds what was moved (${c.verdict})` : `VERIFY: the new door (${m.target.where}) no longer matches what was moved`);
    if (!ok) process.exit(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function digest(): Promise<void> {
  const file = argv.shift();
  const vault = flag("--vault");
  if (!file || !vault) die("usage: move.ts digest <door.json> --vault <name>", 2);
  const scratch = join(process.env.TMPDIR ?? tmpdir(), `parachute-move-${process.pid}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const d = await openDoor(file!, { scratch, production: has("--production"), liveBox: has("--live-box") }).digest(vault!);
    for (const s of SECTIONS) console.log(`${s.padEnd(15)} ${String(d.counts[s]).padStart(6)}  ${d.digests[s].slice(0, 16)}`);
    console.log(`all ${d.digests.all}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (cmd === "plan" || cmd === "run") await run();
    else if (cmd === "close") await close();
    else if (cmd === "verify") await verify();
    else if (cmd === "digest") await digest();
    else die("usage: move.ts plan|run|verify|close|digest … (see the top of this file)", 2);
  } catch (err) {
    die(`move: ${(err as Error).message}`, 1);
  }
}
void existsSync;
