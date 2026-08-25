import { describe, expect, it } from "vitest";
import { buildReportProseSystemPrompt, describeRoughPeriod } from "../src/report/reportProseSchema.js";
import type { ReportTopicCandidate } from "../src/report/reportTopics.js";

describe("describeRoughPeriod (EN-120): the ONLY temporal grounding the model gets — never a digit", () => {
  it("renders a month name only, same year — no digit anywhere", () => {
    const result = describeRoughPeriod("2026-03-15T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    expect(result).toBe("March");
    expect(result).not.toMatch(/\d/);
  });

  it("marks a prior year in words, still no digit", () => {
    const result = describeRoughPeriod("2025-11-02T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    expect(result).toMatch(/November/);
    expect(result).toMatch(/the year before/);
    expect(result).not.toMatch(/\d/);
  });
});

describe("buildReportProseSystemPrompt (EN-120)", () => {
  const topic: ReportTopicCandidate = {
    id: "dormancy:e1",
    kind: "dormancy",
    direction: null,
    entityName: "Elena",
    sourceMessages: [{ id: "m1", recordedAt: "2026-03-15T00:00:00.000Z", text: "Elena and I grabbed coffee" }],
    hasSupportingWordClassSignal: false
  };

  it("includes the topic's real message text and entity name, with the message's timing rendered digit-free (topic ids themselves are internal identifiers, never prose, and may contain a window index)", () => {
    const prompt = buildReportProseSystemPrompt([topic], "2026-06-01T00:00:00.000Z");
    expect(prompt).toMatch(/Elena and I grabbed coffee/);
    expect(prompt).toMatch(/Concerns: Elena/);
    expect(prompt).toMatch(/\(March\) "Elena and I grabbed coffee"/); // exactly describeRoughPeriod's own output, no digit
  });

  it("tells the model to return an empty passages array honestly when no topics cleared the bar, rather than writing anything", () => {
    const prompt = buildReportProseSystemPrompt([], "2026-06-01T00:00:00.000Z");
    expect(prompt).toMatch(/no topics cleared the bar this time — say so honestly rather than writing about anything/);
  });

  it("never hands the model a topic's direction as a fact to name — only as tone guidance, explicitly labeled not-a-measurement", () => {
    const upTopic: ReportTopicCandidate = { ...topic, id: "shift:0", kind: "networkActivityShift", direction: "up", entityName: null };
    const prompt = buildReportProseSystemPrompt([upTopic], "2026-06-01T00:00:00.000Z");
    expect(prompt).toMatch(/do not name this as a measurement, use it only to shape tone/);
  });

  it("requires every passage to cite the topic ids it actually draws from, and forbids citing an id not offered", () => {
    const prompt = buildReportProseSystemPrompt([topic], "2026-06-01T00:00:00.000Z");
    expect(prompt).toMatch(/cite every topic id a passage actually draws from/);
    expect(prompt).toMatch(/never a topic id a passage doesn't genuinely draw from, and never an id not listed below/);
  });
});
