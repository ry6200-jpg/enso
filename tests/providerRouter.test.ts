import { describe, expect, it, vi } from "vitest";
import { CostTracker } from "../src/providers/costTracker.js";
import { ClientRequestError, ProviderAvailabilityError, BothTiersFailedError } from "../src/providers/errors.js";
import { createExtractionRouter } from "../src/providers/router.js";
import type { ProviderAdapter, ProviderCallResult } from "../src/providers/types.js";

function fakeResult(provider: "openai" | "gemini", overrides: Partial<ProviderCallResult> = {}): ProviderCallResult {
  return {
    provider,
    model: provider === "openai" ? "gpt-5.6-terra" : "gemini-3.7-flash",
    taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [] },
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides
  };
}

describe("createExtractionRouter (EN-081/083)", () => {
  it("returns the primary's result on success without touching the fallback", async () => {
    const primary = vi.fn<ProviderAdapter>(async () => fakeResult("openai"));
    const fallback = vi.fn<ProviderAdapter>(async () => fakeResult("gemini"));
    const router = createExtractionRouter({
      message: { primary, fallback },
      document: { primary, fallback }
    });

    const result = await router.extract({ kind: "message", text: "hi" });

    expect(result.provider).toBe("openai");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to tier 2 on a 5xx/availability failure from tier 1", async () => {
    const primary = vi.fn<ProviderAdapter>(async () => {
      throw new ProviderAvailabilityError("503 from primary", 503);
    });
    const fallback = vi.fn<ProviderAdapter>(async () => fakeResult("gemini"));
    const router = createExtractionRouter({
      message: { primary, fallback },
      document: { primary, fallback }
    });

    const result = await router.extract({ kind: "message", text: "hi" });

    expect(result.provider).toBe("gemini");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back on a client (4xx) error — surfaces it immediately (EN-083)", async () => {
    const primary = vi.fn<ProviderAdapter>(async () => {
      throw new ClientRequestError("400 malformed request", 400);
    });
    const fallback = vi.fn<ProviderAdapter>(async () => fakeResult("gemini"));
    const router = createExtractionRouter({
      message: { primary, fallback },
      document: { primary, fallback }
    });

    await expect(router.extract({ kind: "message", text: "hi" })).rejects.toThrow(ClientRequestError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws BothTiersFailedError with both underlying errors when both tiers fail", async () => {
    const primary = vi.fn<ProviderAdapter>(async () => {
      throw new ProviderAvailabilityError("primary down", 503);
    });
    const fallback = vi.fn<ProviderAdapter>(async () => {
      throw new ProviderAvailabilityError("fallback down too", 500);
    });
    const router = createExtractionRouter({
      message: { primary, fallback },
      document: { primary, fallback }
    });

    const err = await router.extract({ kind: "message", text: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(BothTiersFailedError);
    expect((err as BothTiersFailedError).primaryError.message).toContain("primary down");
    expect((err as BothTiersFailedError).fallbackError.message).toContain("fallback down too");
  });

  it("routes 'message' and 'document' kinds to their own configured tiers", async () => {
    const messagePrimary = vi.fn<ProviderAdapter>(async () => fakeResult("openai"));
    const documentPrimary = vi.fn<ProviderAdapter>(async () => fakeResult("gemini"));
    const unusedFallback = vi.fn<ProviderAdapter>(async () => fakeResult("openai"));

    const router = createExtractionRouter({
      message: { primary: messagePrimary, fallback: unusedFallback },
      document: { primary: documentPrimary, fallback: unusedFallback }
    });

    const messageResult = await router.extract({ kind: "message", text: "hi" });
    const documentResult = await router.extract({ kind: "document", text: "big doc" });

    expect(messageResult.provider).toBe("openai");
    expect(documentResult.provider).toBe("gemini");
    expect(messagePrimary).toHaveBeenCalledTimes(1);
    expect(documentPrimary).toHaveBeenCalledTimes(1);
  });

  it("records cost only for the call that actually succeeded", async () => {
    const tracker = new CostTracker();
    const primary = vi.fn<ProviderAdapter>(async () => {
      throw new ProviderAvailabilityError("503", 503);
    });
    const fallback = vi.fn<ProviderAdapter>(async () => fakeResult("gemini", { usage: { inputTokens: 100, outputTokens: 50 } }));
    const router = createExtractionRouter(
      { message: { primary, fallback }, document: { primary, fallback } },
      tracker
    );

    await router.extract({ kind: "message", text: "hi" });

    expect(tracker.all()).toHaveLength(1);
    expect(tracker.all()[0]!.provider).toBe("gemini");
  });
});
