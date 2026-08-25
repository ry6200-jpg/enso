import { describe, expect, it } from "vitest";
import { computeWordClassMarkers } from "../src/report/markers/wordClassMarkers.js";
import { ALL_WORD_CLASSES } from "../src/report/wordClasses.js";
import type { ReportWindow } from "../src/report/reportWindows.js";

function window(messages: { id: string; text: string }[]): ReportWindow {
  return { index: 0, start: new Date("2026-08-23T00:00:00.000Z"), end: new Date("2026-08-30T00:00:00.000Z"), messages: messages.map((m) => ({ ...m, recordedAt: "2026-08-23T10:00:00.000Z" })) };
}

describe("computeWordClassMarkers (report page, Stage A, Section 2.1)", () => {
  it("returns zero rates and zero total words for an empty window", () => {
    const result = computeWordClassMarkers(window([]));
    expect(result.totalWords).toBe(0);
    expect(result.rates.every((r) => r.rate === 0 && r.count === 0)).toBe(true);
  });

  it("always returns the full fixed set of word classes, never a subset (methodology 4.5: no selecting on which markers moved)", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "I think I know why." }]));
    expect(result.rates.map((r) => r.wordClass).sort()).toEqual([...ALL_WORD_CLASSES].sort());
  });

  it("counts first-person-singular tokens correctly, case-insensitively", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "I told my friend I was fine, myself." }]));
    const fps = result.rates.find((r) => r.wordClass === "firstPersonSingular")!;
    expect(fps.count).toBe(4); // "I" x2, "my" x1, "myself" x1
  });

  it("exact count verification for first-person-singular on a controlled sentence", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "i me my mine myself" }]));
    const fps = result.rates.find((r) => r.wordClass === "firstPersonSingular")!;
    expect(fps.count).toBe(5);
    expect(result.totalWords).toBe(5);
    expect(fps.rate).toBe(1);
  });

  it("matches multi-word tentative entries ('sort of', 'kind of') as substrings, not as single tokens", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "I sort of think it might work." }]));
    const tentative = result.rates.find((r) => r.wordClass === "tentative")!;
    expect(tentative.count).toBeGreaterThanOrEqual(2); // "sort of" and "might"
  });

  it("negation class catches contractions", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "I don't know, it isn't clear, I can't tell." }]));
    const negation = result.rates.find((r) => r.wordClass === "negation")!;
    expect(negation.count).toBe(3);
  });

  it("rate is count divided by total words in the window, aggregated across all messages in it", () => {
    const result = computeWordClassMarkers(window([{ id: "m1", text: "I am here" }, { id: "m2", text: "I am there" }]));
    expect(result.totalWords).toBe(6);
    const fps = result.rates.find((r) => r.wordClass === "firstPersonSingular")!;
    expect(fps.count).toBe(2);
    expect(fps.rate).toBeCloseTo(2 / 6);
  });
});
