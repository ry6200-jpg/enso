import { describe, expect, it, vi } from "vitest";
import type { ReportResult } from "../src/report/computeReport.js";

const mockGenerate = vi.fn();
vi.mock("../src/report/reportProseAdapter.js", () => ({
  generateReportProseViaOpenAi: (...args: unknown[]) => mockGenerate(...args)
}));

const { generateReportProse } = await import("../src/report/generateReportProse.js");

function baseReport(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    windowDays: 7,
    corpus: { totalMessages: 0, firstMessageAt: null, lastMessageAt: null },
    network: { perWindow: [], dormancy: [], tieComposition: [], alterDensity: null },
    temporal: { sessions: [], interSessionGapsMinutes: [], burstiness: null, hourOfDayCounts: new Array(24).fill(0), messageLength: { meanWords: 0, medianWords: 0, stdevWords: 0, minWords: 0, maxWords: 0 }, lexicalDiversityByWindow: [] },
    wordClasses: [],
    baselines: [],
    windows: [],
    ...overrides
  };
}

describe("generateReportProse (EN-120): validates the model's own output against real candidates, never trusts it blindly", () => {
  it("makes ZERO API calls when no topics are eligible — cost discipline, not just correctness", async () => {
    mockGenerate.mockClear();
    const result = await generateReportProse(baseReport(), [], "fake-key");
    expect(result).toEqual({ passages: [], noTopicsEligible: true });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("drops a passage that cites zero valid topic ids — never displays prose with nothing real behind it", async () => {
    mockGenerate.mockClear();
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "e1", name: "Elena", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null }
    });
    mockGenerate.mockResolvedValue({ passages: [{ text: "A passage citing nothing real.", topicIds: ["not-a-real-topic-id"] }], provider: "openai", model: "gpt-5.6-terra" });
    const result = await generateReportProse(report, [{ id: "e1", name: "Elena", sourceEventIds: ["m1"] }], "fake-key");
    expect(result.passages).toEqual([]);
  });

  it("drops a passage with empty/whitespace-only text even if it cites a real topic id", async () => {
    mockGenerate.mockClear();
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "e1", name: "Elena", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null },
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-01T00:00:00.000Z", text: "hi" }] }]
    });
    mockGenerate.mockResolvedValue({ passages: [{ text: "   ", topicIds: ["dormancy:e1"] }], provider: "openai", model: "gpt-5.6-terra" });
    const result = await generateReportProse(report, [{ id: "e1", name: "Elena", sourceEventIds: ["m1"] }], "fake-key");
    expect(result.passages).toEqual([]);
  });

  it("keeps a valid passage, resolving its topicIds to the real candidate objects (drill-down material)", async () => {
    mockGenerate.mockClear();
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "e1", name: "Elena", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null },
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-01T00:00:00.000Z", text: "Elena and I grabbed coffee" }] }]
    });
    mockGenerate.mockResolvedValue({ passages: [{ text: "A real passage about Elena.", topicIds: ["dormancy:e1"] }], provider: "openai", model: "gpt-5.6-terra" });
    const result = await generateReportProse(report, [{ id: "e1", name: "Elena", sourceEventIds: ["m1"] }], "fake-key");
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]!.text).toBe("A real passage about Elena.");
    expect(result.passages[0]!.topics).toHaveLength(1);
    expect(result.passages[0]!.topics[0]!.id).toBe("dormancy:e1");
  });

  it("a passage citing a mix of one real and one fake topic id keeps only the real one, still displays", async () => {
    mockGenerate.mockClear();
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "e1", name: "Elena", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null },
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-01T00:00:00.000Z", text: "Elena and I grabbed coffee" }] }]
    });
    mockGenerate.mockResolvedValue({ passages: [{ text: "Mixed grounding.", topicIds: ["dormancy:e1", "made-up"] }], provider: "openai", model: "gpt-5.6-terra" });
    const result = await generateReportProse(report, [{ id: "e1", name: "Elena", sourceEventIds: ["m1"] }], "fake-key");
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]!.topics).toHaveLength(1);
  });
});
