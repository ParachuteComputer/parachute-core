/**
 * `onnx-transformers` — the bundled zero-config self-host embedding
 * provider (semantic search MVP — two-tier self-host shape, Aaron-
 * ratified: this is the FLOOR tier; `external-api.ts`/Ollama is the
 * recommended quality upgrade).
 *
 * Runs `bge-small-en-v1.5` (q8-quantized ONNX, ~34MB — P0's eval
 * confirmed this is genuinely bundle-sized, unlike bge-m3's 1.1GB) via
 * `@huggingface/transformers`, IN-PROCESS, no subprocess.
 *
 * ## Where the model comes from (T-418)
 *
 * The bundle and the npm package ship the model's files, pinned by revision and sha256 (`release/model.json`), in
 * `packages/vault/models/<model id>/`. When they are there they are the only source: nothing is downloaded, so a
 * fresh install embeds offline (and `PARACHUTE_OFFLINE` homes, Prism's, can use it). A source checkout has no
 * `models/`; there the weights download from the Hugging Face hub on first use (a base-MODEL download, not note
 * content leaving the box) into `<PARACHUTE_HOME>/vault/models`, never into the install. Every embedding call runs
 * entirely on this machine.
 *
 * ## bun+onnxruntime verdict (P0/V2 spike)
 *
 * Confirmed WORKING under bun 1.3.13 on this repo: `onnxruntime-node`'s
 * native binary postinstall needs `bun pm trust` to run (blocked by
 * default) — `package.json`'s `trustedDependencies: ["onnxruntime-node",
 * "protobufjs"]` auto-approves it on a fresh `bun install`, no manual step
 * for an operator. `sharp`'s postinstall stays blocked (harmless — image
 * support is unused by this text-only pipeline). Verified end-to-end:
 * `pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype:
 * "q8" })` loads and produces correct 384-dim vectors under `bun run`.
 *
 * ## Lazy-fail, not crash
 *
 * The model load is NOT attempted at construction or at `available()` —
 * it's deferred to the first real `embed()` call (loading downloads/reads
 * ~34MB, too slow for a capability probe that runs on every `GET
 * /api/vault`). If the load ever throws (a genuinely broken bun/onnxruntime
 * combination on some future platform), the failure is caught, the
 * provider latches into a `broken` state for the rest of this process, and
 * every subsequent `available()`/`embed()` reports the failure honestly
 * (`onnx_unavailable`, non-retriable) instead of retrying a doomed load on
 * every note write or crashing the server.
 */

import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbedInput,
  type EmbedResult,
  type ProviderAvailability,
} from "../../core/src/embedding/provider.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isOffline } from "../offline.ts";
import { VAULT_HOME } from "../config.ts";

/** P0-verified bundle-sized default: 34MB q8 ONNX, well under the "~100MB zero-config" bar. */
const DEFAULT_MODEL_ID = "Xenova/bge-small-en-v1.5";
const DEFAULT_DIMS = 384;

/** Structural minimum of the transformers.js feature-extraction pipeline this provider calls. */
type FeatureExtractionFn = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean; truncation: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export interface OnnxTransformersProviderOpts {
  /** Hugging Face model id. Default `Xenova/bge-small-en-v1.5`. */
  modelId?: string;
  /** Expected vector dimensionality (confirmed against the first real embed() response). Default 384. */
  dims?: number;
  /**
   * Injection seam for tests — a fake `pipeline("feature-extraction", ...)`
   * loader. Production omits it and dynamically imports `@huggingface/transformers`.
   */
  pipelineLoader?: (modelId: string) => Promise<FeatureExtractionFn>;
}

/** The models the bundle and the npm package ship (`release/model.ts` puts them here); absent in a source checkout. */
export const BUNDLED_MODELS_DIR = resolve(import.meta.dir, "..", "..", "models");

/** Whether the shipped files of `modelId` (q8 weights and tokenizer) are in `dir`. */
export function hasBundledModel(modelId: string, dir: string = BUNDLED_MODELS_DIR): boolean {
  return ["config.json", "tokenizer.json", "tokenizer_config.json", join("onnx", "model_quantized.onnx")].every((f) => existsSync(join(dir, modelId, f)));
}

async function defaultPipelineLoader(modelId: string): Promise<FeatureExtractionFn> {
  // Dynamic import (not a top-level import) — this file lives in `src/`
  // (never `core/`), but keeping the ~34MB dependency's load off the
  // module-init path means a vault that never touches semantic search
  // never pays the import cost either.
  const { pipeline, env } = await import("@huggingface/transformers");
  // Downloads (a source checkout) go to the home, never into the install (whose default is inside node_modules).
  env.cacheDir = join(VAULT_HOME, "models");
  if (hasBundledModel(modelId)) {
    // The shipped files are the model: read from the install, never downloaded.
    env.localModelPath = `${BUNDLED_MODELS_DIR}/`;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  } else if (isOffline()) {
    // Offline: a model already in the cache loads; a missing one is not downloaded.
    env.allowRemoteModels = false;
  }
  const extractor = await pipeline("feature-extraction", modelId, { dtype: "q8" });
  return extractor as unknown as FeatureExtractionFn;
}

export class OnnxTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "onnx-transformers";
  readonly model: string;
  dims: number;

  private readonly pipelineLoader: (modelId: string) => Promise<FeatureExtractionFn>;
  private extractorPromise: Promise<FeatureExtractionFn> | null = null;
  private broken: string | null = null;
  private loaded = false;

  constructor(opts: OnnxTransformersProviderOpts = {}) {
    this.model = opts.modelId ?? DEFAULT_MODEL_ID;
    this.dims = opts.dims ?? DEFAULT_DIMS;
    this.pipelineLoader = opts.pipelineLoader ?? defaultPipelineLoader;
  }

  /**
   * Optimistic until proven otherwise — see the module doc's "lazy-fail,
   * not crash" note. A real load attempt only happens inside `embed()`.
   */
  async available(): Promise<ProviderAvailability> {
    if (this.broken) return { ok: false, reason: this.broken };
    return { ok: true };
  }

  private async getExtractor(): Promise<FeatureExtractionFn> {
    if (this.broken) {
      throw new EmbeddingError(this.broken, { code: "onnx_unavailable", retriable: false });
    }
    if (!this.extractorPromise) {
      this.extractorPromise = this.pipelineLoader(this.model).then(
        (extractor) => {
          this.loaded = true;
          return extractor;
        },
        (err) => {
          const reason = `bundled ONNX embedding model failed to load: ${err instanceof Error ? err.message : String(err)}`;
          this.broken = reason;
          throw new EmbeddingError(reason, { code: "onnx_unavailable", retriable: false });
        },
      );
    }
    return this.extractorPromise;
  }

  /** Load the model now (once; later calls share the load) and say whether it can embed. Never throws. */
  async warm(): Promise<ProviderAvailability> {
    try {
      await this.getExtractor();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: this.broken ?? (err instanceof Error ? err.message : String(err)) };
    }
  }

  /** True from the first load attempt until it has loaded or failed. */
  loading(): boolean {
    return this.extractorPromise !== null && !this.loaded && this.broken === null;
  }

  /**
   * Embeds each text through the pipeline one at a time (not a single
   * batched ONNX-session call) — this is the exact per-item invocation
   * shape the P0 eval harness verified working end-to-end; true session-
   * level batching is a future optimization, not required for the MVP's
   * correctness. `truncation: true` lets the model's own tokenizer window
   * (512 tokens for bge-small) truncate long chunks — chunking already
   * targets ~450 tokens per chunk (see `core/src/embedding/chunker.ts`),
   * so this rarely engages in practice. Returns RAW (un-normalized)
   * vectors — normalization is the store's job (one place, for every
   * provider), not each provider's.
   */
  async embed(input: EmbedInput): Promise<EmbedResult> {
    if (input.texts.length === 0) {
      return { vectors: [], model: this.model, dims: this.dims };
    }
    const extractor = await this.getExtractor();
    const vectors: Float32Array[] = [];
    for (const text of input.texts) {
      const out = await extractor(text, { pooling: "mean", normalize: false, truncation: true });
      vectors.push(out.data instanceof Float32Array ? out.data : new Float32Array(out.data));
    }
    if (vectors[0]) this.dims = vectors[0].length;
    return { vectors, model: this.model, dims: this.dims };
  }
}
