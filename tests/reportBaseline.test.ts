import { describe, expect, it } from "vitest";
import { computeBaseline, MIN_PRIOR_WINDOWS_FOR_BASELINE } from "../src/report/markers/baseline.js";

describe("computeBaseline (report page, Stage A, Section 2.4: personal baselines, idiographic only)", () => {
  it("shows no baseline (never a fabricated trend) below MIN_PRIOR_WINDOWS_FOR_BASELINE", () => {
    expect(MIN_PRIOR_WINDOWS_FOR_BASELINE).toBeGreaterThanOrEqual(2);
    const result = computeBaseline(10, [5]); // only 1 prior window
    expect(result.baseline).toBeNull();
    expect(result.priorWindowCount).toBe(1);
  });

  it("shows no baseline at all with zero prior windows — the current corpus's actual state today", () => {
    const result = computeBaseline(10, []);
    expect(result.baseline).toBeNull();
    expect(result.priorWindowCount).toBe(0);
    expect(result.currentValue).toBe(10);
  });

  it("computes a real baseline once enough prior windows exist", () => {
    const result = computeBaseline(10, [4, 6, 5]);
    expect(result.priorWindowCount).toBe(3);
    expect(result.baseline).not.toBeNull();
    expect(result.baseline!.mean).toBeCloseTo(5);
  });

  it("deviation is expressed in standard deviations from the person's OWN prior windows, never a population norm", () => {
    const result = computeBaseline(10, [5, 5, 5, 5]); // stdev 0 among priors
    expect(result.baseline!.stdev).toBe(0);
    expect(result.baseline!.deviationInStdevs).toBeNull(); // undefined, not a divide-by-zero fabrication
  });

  it("a real, nonzero deviation is computed correctly", () => {
    const result = computeBaseline(10, [4, 6]); // mean 5, stdev 1
    expect(result.baseline!.mean).toBeCloseTo(5);
    expect(result.baseline!.stdev).toBeCloseTo(1);
    expect(result.baseline!.deviationInStdevs).toBeCloseTo(5);
  });
});
