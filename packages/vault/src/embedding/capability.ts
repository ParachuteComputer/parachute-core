/**
 * Embedding capability flag (semantic search MVP — EXPERIMENTAL).
 * Mirrors `src/transcription/capability.ts` exactly: the vault landing
 * (`GET /vault/<name>/api/vault`) surfaces an `embeddings` capability so a
 * surface (or Adam's Claude) can tell, before ever calling `query-notes
 * { semantic: true }`, whether meaning-based search is actually possible
 * on this vault right now — `enabled` is true only when a provider is
 * configured AND its `available()` probe passes.
 */

import type { EmbeddingProvider } from "../../core/src/embedding/provider.ts";

export interface EmbeddingCapability {
  /** True when a provider is configured AND available. `query-notes { semantic: true }` throws `semantic_unavailable` when false. */
  enabled: boolean;
  /**
   * What the embedder is doing (T-418), so a vault whose model can't load says so instead of looking healthy:
   * "off" (semantic search not turned on), "loading" (the model is loading), "ready", or "failing" (turned on, but
   * it can't embed: `error` says why, and no note gets a vector until it is fixed).
   */
  state: "off" | "loading" | "ready" | "failing";
  /** The active provider's name (e.g. "onnx-transformers", "external-api"). Omitted when off. */
  provider?: string;
  /** The active provider's model (e.g. "bge-small-en-v1.5", "bge-m3"). Omitted when off. */
  model?: string;
  /** Why it is failing (state "failing" only). */
  error?: string;
}

/**
 * `provider` is `undefined` when `EMBEDDINGS_ENABLED=false` (the off
 * switch — see `select.ts`'s `buildEmbeddingProvider`) — resolves to
 * `{enabled: false, state: "off"}` directly, no `available()` probe to call.
 */
export async function resolveEmbeddingCapability(
  provider: EmbeddingProvider | undefined,
): Promise<EmbeddingCapability> {
  if (!provider) return { enabled: false, state: "off" };
  const avail = await provider.available();
  if (!avail.ok) {
    return { enabled: false, state: "failing", provider: provider.name, model: provider.model, error: avail.reason ?? "the embedding provider is unavailable" };
  }
  return { enabled: true, state: provider.loading?.() ? "loading" : "ready", provider: provider.name, model: provider.model };
}
