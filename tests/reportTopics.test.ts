import { describe, expect, it } from "vitest";
import { selectReportTopics, type ReportTopicEntityInput } from "../src/report/reportTopics.js";
import type { ReportResult } from "../src/report/computeReport.js";
import { ALL_WORD_CLASSES } from "../src/report/wordClasses.js";
import type { BaselineResult } from "../src/report/markers/baseline.js";

function noBaseline(currentValue: number, priorWindowCount = 0): BaselineResult {
  return { currentValue, priorWindowCount, baseline: null };
}

function withBaseline(currentValue: number, deviationInStdevs: number | null, priorWindowCount = 3): BaselineResult {
  return { currentValue, priorWindowCount, baseline: { mean: 0, stdev: 1, deviationInStdevs } };
}

function wordClassRatesAllQuiet(): { wordClass: (typeof ALL_WORD_CLASSES)[number]; baseline: BaselineResult }[] {
  return ALL_WORD_CLASSES.map((wordClass) => ({ wordClass, baseline: noBaseline(0) }));
}

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

describe("selectReportTopics (EN-120): confidence gating happens in code, never in the prompt", () => {
  it("produces no topic for a window below MIN_PRIOR_WINDOWS_FOR_BASELINE, even with a large current value", () => {
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "hello" }] }],
      baselines: [{ windowIndex: 0, activeTieCount: noBaseline(9), mentionConcentrationHhi: noBaseline(0.9), lexicalDiversityTypeTokenRatio: noBaseline(0.9), wordClassRates: wordClassRatesAllQuiet() }]
    });
    expect(selectReportTopics(report, [])).toEqual([]);
  });

  it("produces no topic when a baseline exists but the deviation is below the 1-stdev bar — 'nothing different from usual' is the honest read", () => {
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "hello" }] }],
      baselines: [{ windowIndex: 0, activeTieCount: withBaseline(5, 0.4), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates: wordClassRatesAllQuiet() }]
    });
    expect(selectReportTopics(report, [])).toEqual([]);
  });

  it("produces a networkActivityShift topic with the correct qualitative direction when the deviation clears the bar — carries source messages, never a number", () => {
    const message = { id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "saw a bunch of people this week" };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [message] }],
      baselines: [{ windowIndex: 0, activeTieCount: withBaseline(9, 2.1), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates: wordClassRatesAllQuiet() }]
    });
    const topics = selectReportTopics(report, []);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ kind: "networkActivityShift", direction: "up", entityName: null, sourceMessages: [message] });
    // No key on the candidate ever carries a raw metric value — structural, not just a convention.
    expect(Object.keys(topics[0]!).sort()).toEqual(["direction", "entityName", "hasSupportingWordClassSignal", "id", "kind", "sourceMessages"]);
  });

  it("qualitative direction is 'down' for a negative deviation", () => {
    const message = { id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "quiet week" };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [message] }],
      baselines: [{ windowIndex: 0, activeTieCount: withBaseline(1, -1.8), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates: wordClassRatesAllQuiet() }]
    });
    expect(selectReportTopics(report, [])[0]!.direction).toBe("down");
  });

  it("a dormant entity with resolvable source messages produces a dormancy topic, quoting the real messages", () => {
    const message = { id: "m1", recordedAt: "2026-01-01T00:00:00.000Z", text: "Elena and I grabbed coffee" };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [message] }],
      network: { perWindow: [], dormancy: [{ entityId: "elena-1", name: "Elena", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null }
    });
    const entities: ReportTopicEntityInput[] = [{ id: "elena-1", name: "Elena", sourceEventIds: ["m1"] }];
    const topics = selectReportTopics(report, entities);
    expect(topics).toEqual([{ id: "dormancy:elena-1", kind: "dormancy", direction: null, entityName: "Elena", sourceMessages: [message], hasSupportingWordClassSignal: false }]);
  });

  it("a dormant entity with NO resolvable source messages produces no topic — never a passage with nothing real to quote", () => {
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "ghost-1", name: "Ghost", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 30, dormant: true }], tieComposition: [], alterDensity: null }
    });
    expect(selectReportTopics(report, [{ id: "ghost-1", name: "Ghost", sourceEventIds: [] }])).toEqual([]);
  });

  it("a non-dormant entity produces no dormancy topic", () => {
    const report = baseReport({
      network: { perWindow: [], dormancy: [{ entityId: "e1", name: "Marcus", lastMentionAt: "2026-01-01T00:00:00.000Z", daysSinceLastMention: 2, dormant: false }], tieComposition: [], alterDensity: null }
    });
    expect(selectReportTopics(report, [{ id: "e1", name: "Marcus", sourceEventIds: ["m1"] }])).toEqual([]);
  });

  it("a word-class shift with NO co-occurring trend topic in the same window produces nothing — word-class signals are never the sole basis for a passage", () => {
    const wordClassRates = wordClassRatesAllQuiet();
    wordClassRates[0] = { wordClass: ALL_WORD_CLASSES[0]!, baseline: withBaseline(0.3, 2.5) };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [{ id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "hi" }] }],
      baselines: [{ windowIndex: 0, activeTieCount: noBaseline(2), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates }]
    });
    expect(selectReportTopics(report, [])).toEqual([]);
  });

  it("a word-class shift attaches as supporting color ONLY when a real trend topic already exists in the same window", () => {
    const wordClassRates = wordClassRatesAllQuiet();
    wordClassRates[0] = { wordClass: ALL_WORD_CLASSES[0]!, baseline: withBaseline(0.3, 2.5) };
    const message = { id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "a lot happened" };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [message] }],
      baselines: [{ windowIndex: 0, activeTieCount: withBaseline(9, 2.1), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates }]
    });
    expect(selectReportTopics(report, [])[0]!.hasSupportingWordClassSignal).toBe(true);
  });

  it("a word-class shift below its own (stricter) bar never attaches, even alongside a real trend topic", () => {
    const wordClassRates = wordClassRatesAllQuiet();
    wordClassRates[0] = { wordClass: ALL_WORD_CLASSES[0]!, baseline: withBaseline(0.3, 1.2) }; // clears the 1.0 general bar but not the 1.5 word-class bar
    const message = { id: "m1", recordedAt: "2026-01-02T00:00:00.000Z", text: "a lot happened" };
    const report = baseReport({
      windows: [{ index: 0, start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z", messages: [message] }],
      baselines: [{ windowIndex: 0, activeTieCount: withBaseline(9, 2.1), mentionConcentrationHhi: noBaseline(0.5), lexicalDiversityTypeTokenRatio: noBaseline(0.5), wordClassRates }]
    });
    expect(selectReportTopics(report, [])[0]!.hasSupportingWordClassSignal).toBe(false);
  });

  it("an empty report (no windows, no dormancy) produces zero topics — a short report, never a reaching one", () => {
    expect(selectReportTopics(baseReport(), [])).toEqual([]);
  });
});
