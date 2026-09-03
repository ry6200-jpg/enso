import { describe, expect, it } from "vitest";
import { majorityVote, runFabricationCheck, type FabricationJudgeAdapter } from "../src/persona/fabricationCheck.js";

function mockAdapter(spans: string[], labelsBySpan: Record<string, string[]>): FabricationJudgeAdapter {
  const calls: Record<string, number> = {};
  return {
    async decompose() {
      return spans;
    },
    async classify(_input, span) {
      const i = (calls[span] ?? 0);
      calls[span] = i + 1;
      const label = labelsBySpan[span]![i % labelsBySpan[span]!.length] as any;
      return { label, rationale: `mock rationale for ${span} (${label})`, offendingSpan: label === "ADDED" || label === "SOFT_ADDED" ? span : null };
    }
  };
}

describe("majorityVote", () => {
  it("picks the label with the most votes", () => {
    const results = [
      { label: "ENTAILED" as const, rationale: "a", offendingSpan: null },
      { label: "ENTAILED" as const, rationale: "b", offendingSpan: null },
      { label: "ADDED" as const, rationale: "c", offendingSpan: "x" }
    ];
    const { label, votes } = majorityVote(results);
    expect(label).toBe("ENTAILED");
    expect(votes).toEqual({ ENTAILED: 2, USER_STATED: 0, ADDED: 1, SOFT_ADDED: 0 });
  });

  it("breaks ties toward the more severe label (ADDED beats ENTAILED on a tie)", () => {
    const results = [
      { label: "ENTAILED" as const, rationale: "a", offendingSpan: null },
      { label: "ADDED" as const, rationale: "b", offendingSpan: "x" }
    ];
    expect(majorityVote(results).label).toBe("ADDED");
  });

  it("breaks a three-way-adjacent tie toward the most severe present label (SOFT_ADDED beats USER_STATED)", () => {
    const results = [
      { label: "USER_STATED" as const, rationale: "a", offendingSpan: null },
      { label: "SOFT_ADDED" as const, rationale: "b", offendingSpan: "x" }
    ];
    expect(majorityVote(results).label).toBe("SOFT_ADDED");
  });
});

describe("runFabricationCheck", () => {
  const input = { contextFacts: ["Lives in Denver."], userTurn: "hi", reply: "Denver must be nice this time of year, and that beard suits you." };

  it("aggregates N classify runs per extracted detail into a majority-vote label, and fails only when a detail's majority is ADDED", async () => {
    const adapter = mockAdapter(
      ["Denver mentioned"],
      { "Denver mentioned": ["ENTAILED", "ENTAILED", "ENTAILED"] }
    );
    const result = await runFabricationCheck(adapter, "judge-model", "model-under-test", input, { n: 3, concurrency: 3 });
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.label).toBe("ENTAILED");
    expect(result.fails).toBe(false);
  });

  it("fails the case when any detail's majority vote is ADDED", async () => {
    const adapter = mockAdapter(
      ["Denver mentioned", "beard detail"],
      { "Denver mentioned": ["ENTAILED"], "beard detail": ["ADDED", "ADDED", "SOFT_ADDED"] }
    );
    const result = await runFabricationCheck(adapter, "judge-model", "model-under-test", input, { n: 3, concurrency: 3 });
    expect(result.fails).toBe(true);
    const beardDetail = result.details.find((d) => d.span === "beard detail")!;
    expect(beardDetail.label).toBe("ADDED");
    expect(beardDetail.offendingSpan).toBe("beard detail");
  });

  it("SOFT_ADDED is recorded on the result but never sets fails on its own", async () => {
    const adapter = mockAdapter(["beard detail"], { "beard detail": ["SOFT_ADDED", "SOFT_ADDED", "SOFT_ADDED"] });
    const result = await runFabricationCheck(adapter, "judge-model", "model-under-test", input, { n: 3, concurrency: 3 });
    expect(result.details[0]!.label).toBe("SOFT_ADDED");
    expect(result.fails).toBe(false);
  });

  it("throws if the judge model equals the model under evaluation -- structural enforcement, never left to caller discipline", async () => {
    const adapter = mockAdapter([], {});
    await expect(runFabricationCheck(adapter, "gpt-5.6-luna", "gpt-5.6-luna", input, { n: 1 })).rejects.toThrow(/must not equal/);
  });

  it("an empty detail list (no specifics extracted) never fails the case", async () => {
    const adapter = mockAdapter([], {});
    const result = await runFabricationCheck(adapter, "judge-model", "model-under-test", input, { n: 3 });
    expect(result.details).toHaveLength(0);
    expect(result.fails).toBe(false);
  });
});
