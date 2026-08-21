import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/providers/costTracker.js";
import { estimateCostUsd } from "../src/providers/pricing.js";
import type { ProviderCallResult } from "../src/providers/types.js";

describe("pricing (EN-086)", () => {
  it("computes cost from the pinned per-model rates", () => {
    // gpt-5.6-terra: $2/M input, $12/M output (verified live 2026-08-21)
    const cost = estimateCostUsd("gpt-5.6-terra", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(2 + 12, 5);
  });

  it("throws for a model with no pricing entry rather than silently costing $0", () => {
    expect(() => estimateCostUsd("some-unknown-model", 1000, 1000)).toThrow(/No pricing entry/);
  });
});

describe("CostTracker (EN-086)", () => {
  it("records a call and computes its cost from usage", () => {
    const tracker = new CostTracker();
    const result: ProviderCallResult = {
      provider: "openai",
      model: "gpt-5.6-terra",
      taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
      usage: { inputTokens: 500_000, outputTokens: 0 }
    };
    const entry = tracker.record(result);
    expect(entry.costUsd).toBeCloseTo(1.0, 5); // 0.5M input tokens * $2/M
  });

  it("sums total spend across multiple recorded calls", () => {
    const tracker = new CostTracker();
    tracker.record({
      provider: "openai",
      model: "gpt-5.6-luna",
      taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
      usage: { inputTokens: 1_000_000, outputTokens: 0 }
    });
    tracker.record({
      provider: "gemini",
      model: "gemini-3.7-flash",
      taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
      usage: { inputTokens: 0, outputTokens: 1_000_000 }
    });

    expect(tracker.totalUsd()).toBeCloseTo(0.2 + 3.75, 5);
    expect(tracker.all()).toHaveLength(2);
  });
});
