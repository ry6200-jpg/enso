import { describe, expect, it } from "vitest";
import { computeTemporalMarkers, SESSION_GAP_MINUTES } from "../src/report/markers/temporalMarkers.js";
import { computeReportWindows } from "../src/report/reportWindows.js";

function msg(id: string, recordedAt: string, text = "hello there friend") {
  return { id, recordedAt, text };
}

describe("computeTemporalMarkers (report page, Stage A, Section 2.3 — exact at any message length)", () => {
  it("a single message is one session with zero duration", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.messageCount).toBe(1);
    expect(result.sessions[0]!.durationMinutes).toBe(0);
  });

  it("messages within SESSION_GAP_MINUTES of each other form one session", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z"), msg("m2", "2026-08-23T10:10:00.000Z")];
    expect(SESSION_GAP_MINUTES).toBeGreaterThan(10);
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.messageCount).toBe(2);
  });

  it("a gap of at least SESSION_GAP_MINUTES starts a new session", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z"), msg("m2", "2026-08-23T12:00:00.000Z")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.sessions).toHaveLength(2);
  });

  it("inter-session gaps count is one less than the session count, and burstiness needs at least 2 gaps", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z"), msg("m2", "2026-08-23T12:00:00.000Z"), msg("m3", "2026-08-23T14:00:00.000Z")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.sessions).toHaveLength(3);
    expect(result.interSessionGapsMinutes).toHaveLength(2);
    expect(result.burstiness).not.toBeNull();
  });

  it("burstiness is null with fewer than 2 inter-session gaps — never a fabricated regularity score from one data point", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.burstiness).toBeNull();
  });

  it("hour-of-day counts sum to the total message count", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z"), msg("m2", "2026-08-23T22:00:00.000Z")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7), "UTC");
    expect(result.hourOfDayCounts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(result.hourOfDayCounts[10]).toBe(1);
    expect(result.hourOfDayCounts[22]).toBe(1);
  });

  it("hour-of-day bucketing shifts with a real IANA timezone, not just UTC", () => {
    const messages = [msg("m1", "2026-08-23T23:30:00.000Z")]; // 23:30 UTC == 16:30 in America/Los_Angeles (PDT, UTC-7)
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7), "America/Los_Angeles");
    expect(result.hourOfDayCounts[16]).toBe(1);
    expect(result.hourOfDayCounts[23]).toBe(0);
  });

  it("falls back to UTC on an invalid/unrecognized timezone string rather than throwing", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z")];
    expect(() => computeTemporalMarkers(messages, computeReportWindows(messages, 7), "Not/A_Real_Zone")).not.toThrow();
  });

  it("message length distribution: mean/median/stdev/min/max over real word counts", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z", "one two three"), msg("m2", "2026-08-23T10:01:00.000Z", "one")];
    const result = computeTemporalMarkers(messages, computeReportWindows(messages, 7));
    expect(result.messageLength.meanWords).toBe(2);
    expect(result.messageLength.minWords).toBe(1);
    expect(result.messageLength.maxWords).toBe(3);
  });

  it("lexical diversity (type-token ratio) is 1.0 when every word in a window is distinct", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z", "apple banana cherry")];
    const windows = computeReportWindows(messages, 7);
    const result = computeTemporalMarkers(messages, windows);
    expect(result.lexicalDiversityByWindow).toHaveLength(1);
    expect(result.lexicalDiversityByWindow[0]!.typeTokenRatio).toBe(1);
  });

  it("lexical diversity drops below 1.0 with real repetition", () => {
    const messages = [msg("m1", "2026-08-23T10:00:00.000Z", "apple apple apple banana")];
    const windows = computeReportWindows(messages, 7);
    const result = computeTemporalMarkers(messages, windows);
    expect(result.lexicalDiversityByWindow[0]!.typeTokenRatio).toBe(0.5); // 2 distinct / 4 total
  });
});
