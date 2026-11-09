import { describe, test, expect } from "bun:test";
import { resolveEmbeddingCapability } from "./capability.ts";
import type { EmbeddingProvider, EmbedInput, EmbedResult, ProviderAvailability } from "../../core/src/embedding/provider.ts";

class FakeProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly dims = 4;
  constructor(private ok: boolean, private reason?: string, private stillLoading?: boolean) {}
  loading(): boolean {
    return this.stillLoading === true;
  }
  async embed(_input: EmbedInput): Promise<EmbedResult> {
    return { vectors: [], model: this.model, dims: this.dims };
  }
  async available(): Promise<ProviderAvailability> {
    return this.ok ? { ok: true } : { ok: false, reason: this.reason };
  }
}

describe("resolveEmbeddingCapability", () => {
  test("enabled:true with provider/model when the provider is available", async () => {
    const cap = await resolveEmbeddingCapability(new FakeProvider(true));
    expect(cap).toEqual({ enabled: true, state: "ready", provider: "fake", model: "fake-model" });
  });

  test("state loading while the provider's model is still loading", async () => {
    const cap = await resolveEmbeddingCapability(new FakeProvider(true, undefined, true));
    expect(cap).toEqual({ enabled: true, state: "loading", provider: "fake", model: "fake-model" });
  });

  test("turned on but unavailable is state failing, with the provider and why (T-418: not a quiet enabled:false)", async () => {
    const cap = await resolveEmbeddingCapability(new FakeProvider(false, "not ready"));
    expect(cap).toEqual({ enabled: false, state: "failing", provider: "fake", model: "fake-model", error: "not ready" });
  });

  test("enabled:false when no provider at all (EMBEDDINGS_ENABLED=false, M1) — no available() call needed", async () => {
    const cap = await resolveEmbeddingCapability(undefined);
    expect(cap).toEqual({ enabled: false, state: "off" });
  });
});
