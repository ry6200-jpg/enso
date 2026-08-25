import { afterEach, describe, expect, it } from "vitest";
import { computeReportWindows, DEFAULT_REPORT_WINDOW_DAYS, getReportWindowDays } from "../src/report/reportWindows.js";

describe("getReportWindowDays (report page, Stage A — window size as a named, env-configurable constant)", () => {
  const original = process.env.REPORT_WINDOW_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.REPORT_WINDOW_DAYS;
    else process.env.REPORT_WINDOW_DAYS = original;
  });

  it("falls back to DEFAULT_REPORT_WINDOW_DAYS when unset", () => {
    delete process.env.REPORT_WINDOW_DAYS;
    expect(getReportWindowDays()).toBe(DEFAULT_REPORT_WINDOW_DAYS);
  });

  it("reads a real override, changeable without a code change", () => {
    process.env.REPORT_WINDOW_DAYS = "3";
    expect(getReportWindowDays()).toBe(3);
  });

  it("falls back to the default on garbage input rather than throwing", () => {
    process.env.REPORT_WINDOW_DAYS = "not-a-number";
    expect(getReportWindowDays()).toBe(DEFAULT_REPORT_WINDOW_DAYS);
    process.env.REPORT_WINDOW_DAYS = "-5";
    expect(getReportWindowDays()).toBe(DEFAULT_REPORT_WINDOW_DAYS);
    process.env.REPORT_WINDOW_DAYS = "0";
    expect(getReportWindowDays()).toBe(DEFAULT_REPORT_WINDOW_DAYS);
  });
});

describe("computeReportWindows", () => {
  it("returns no windows for an empty message list", () => {
    expect(computeReportWindows([], 7)).toEqual([]);
  });

  it("buckets all messages into one window when the whole corpus fits inside the window size", () => {
    const messages = [
      { id: "m1", recordedAt: "2026-08-23T10:00:00.000Z", text: "hi" },
      { id: "m2", recordedAt: "2026-08-24T23:00:00.000Z", text: "hello again" }
    ];
    const windows = computeReportWindows(messages, 7);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("splits messages into separate windows once the window size is exceeded", () => {
    const messages = [
      { id: "m1", recordedAt: "2026-08-01T10:00:00.000Z", text: "hi" },
      { id: "m2", recordedAt: "2026-08-20T10:00:00.000Z", text: "much later" }
    ];
    const windows = computeReportWindows(messages, 7);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows[0]!.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("silent gaps produce no empty window rows — only non-empty windows are returned", () => {
    const messages = [
      { id: "m1", recordedAt: "2026-08-01T10:00:00.000Z", text: "hi" },
      { id: "m2", recordedAt: "2026-09-01T10:00:00.000Z", text: "a month later" }
    ];
    const windows = computeReportWindows(messages, 7);
    expect(windows.every((w) => w.messages.length > 0)).toBe(true);
  });

  it("respects a smaller window size — e.g. 1 day, appropriate for a dense chat-rhythm corpus rather than 7-day journal-entry spacing", () => {
    const messages = [
      { id: "m1", recordedAt: "2026-08-23T10:00:00.000Z", text: "day one" },
      { id: "m2", recordedAt: "2026-08-24T10:00:00.000Z", text: "day two" }
    ];
    const windows = computeReportWindows(messages, 1);
    expect(windows).toHaveLength(2);
  });

  it("windows are returned in ascending order", () => {
    const messages = [
      { id: "m2", recordedAt: "2026-08-20T10:00:00.000Z", text: "later" },
      { id: "m1", recordedAt: "2026-08-01T10:00:00.000Z", text: "earlier" }
    ];
    const windows = computeReportWindows(messages, 7);
    expect(windows[0]!.messages[0]!.id).toBe("m1");
    expect(windows[windows.length - 1]!.messages[0]!.id).toBe("m2");
  });
});
