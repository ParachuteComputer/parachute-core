// What the exit contract and the runner share: the fixture's names, and how an exported file is recorded so that two
// doors' exports of the same made-up notes can be compared byte for byte.
import { createHash } from "node:crypto";

export const FIXTURE = "exit-fixture";
// Bytes that are the same on every door and every run, so the exported file can be compared across doors.
export const FIXTURE_FILE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 1024 }, (_, i) => (i * 7 + 3) % 256)]);

/** Mask what differs per run in an exported file: ids, times, the storage path's date and random name. */
export function maskExport(text: string): string {
  return text
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}\/[\w-]+\.png/g, "<stored>.png")
    .replace(/att_[0-9A-Za-z]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<att>");
}

/** Record the fixture's exported files, masked. Used here for an HTTP export and by the runner for a box's export. */
export function recordExport(files: { name: string; bytes: Uint8Array }[], record: (key: string, value: unknown) => void): void {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  for (const f of files) {
    if (f.name === `${FIXTURE}/plan.md` || f.name === `${FIXTURE}/target.md`) record(`exit/file.${f.name}`, maskExport(text(f.bytes)));
    if (f.name === ".parachute/schemas/exitfixture.yaml") record(`exit/file.${f.name}`, maskExport(text(f.bytes)));
    if (f.name === ".parachute/vault.yaml") record("exit/file.vault.yaml.keys", text(f.bytes).split("\n").filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(":")[0]).filter((k) => k !== "description").sort()); // description depends on which suite ran first
    if (f.name.startsWith("_unpathed/") && text(f.bytes).includes("exit-fixture pathless note")) record("exit/file.pathless", { name: f.name, text: maskExport(text(f.bytes)) });
    if (f.name.startsWith(".parachute/attachments/") && f.bytes.length === FIXTURE_FILE.length) record("exit/file.attachment", { name: f.name.replace(/attachments\/[^/]+\/[^/]+(\.\w+)$/, "attachments/<att>/<stored>$1"), sha256: createHash("sha256").update(f.bytes).digest("hex") });
  }
}
