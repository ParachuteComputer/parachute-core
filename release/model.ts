// The embedding model the bundle ships (release/model.json): its files are downloaded once per machine, checked
// against the sha256 pinned there every time they are used, and copied to lib/packages/vault/models/<id>/, where
// the vault reads them (packages/vault/src/embedding/onnx-transformers.ts). A file that doesn't match is refused.
// So a fresh install embeds with no download and no network, and what is tested is what ships (T-418).
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pin from "./model.json";

export const MODEL = pin as { id: string; base: string; license: string; revision: string; url: string; files: Record<string, string> };

const CACHE = resolve(process.env.PCORE_MODEL_CACHE ?? join(import.meta.dir, "..", "contracts", ".cache", "models"));

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(path).bytes());
  return h.digest("hex");
}

/** The pinned file `rel`, from the cache or downloaded into it; refused unless its sha256 matches. */
async function fetchFile(rel: string, want: string): Promise<string> {
  const cached = join(CACHE, MODEL.revision, rel);
  if (!existsSync(cached)) {
    mkdirSync(dirname(cached), { recursive: true });
    const res = await fetch(`${MODEL.url}${rel}`);
    if (!res.ok) throw new Error(`model: ${MODEL.id} ${rel}: HTTP ${res.status}`);
    const tmp = `${cached}.${process.pid}.tmp`;
    await Bun.write(tmp, res);
    renameSync(tmp, cached);
  }
  const got = await sha256(cached);
  if (got !== want) throw new Error(`model: ${MODEL.id} ${rel} has sha256 ${got}, pinned ${want}; refused (delete ${cached} to fetch it again)`);
  return cached;
}

/** Put the pinned model under `<lib>/packages/vault/models/<id>/`; returns that folder. */
export async function installModel(lib: string): Promise<string> {
  const dest = join(lib, "packages", "vault", "models", MODEL.id);
  for (const [rel, want] of Object.entries(MODEL.files)) {
    const from = await fetchFile(rel, want);
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(from, join(dest, rel));
    if ((await sha256(join(dest, rel))) !== want) throw new Error(`model: the copy of ${rel} doesn't match its pin`);
  }
  return dest;
}

/** The notice for THIRD-PARTY-NOTICES.txt. */
export function modelNotice(): string {
  return [
    `${MODEL.id}@${MODEL.revision.slice(0, 12)}  (${MODEL.license})  lib/packages/vault/models/${MODEL.id}`,
    "",
    `The ONNX conversion of ${MODEL.base} (https://huggingface.co/${MODEL.base}), released by its authors under the`,
    `${MODEL.license} licence; files ${Object.keys(MODEL.files).join(", ")} from https://huggingface.co/${MODEL.id} at revision ${MODEL.revision}.`,
  ].join("\n");
}
