import { describe, expect, it } from "vitest";
import { daySeparatorLabel, formatExactTimestamp, formatInlineTime, INLINE_TIME_GAP_MINUTES, isNewLocalDay, shouldShowInlineTime } from "../app/lib/chatTimestamps.js";

describe("isNewLocalDay (chat timestamps, part 3)", () => {
  it("the very first message (no prior) always starts a new day", () => {
    expect(isNewLocalDay(null, "2026-08-23T10:00:00.000Z", "UTC")).toBe(true);
  });

  it("no day change within the same local day", () => {
    expect(isNewLocalDay("2026-08-23T09:00:00.000Z", "2026-08-23T20:00:00.000Z", "UTC")).toBe(false);
  });

  it("a real day change is detected", () => {
    expect(isNewLocalDay("2026-08-23T23:00:00.000Z", "2026-08-24T01:00:00.000Z", "UTC")).toBe(true);
  });

  it("day boundary is computed in LOCAL time, not UTC — a UTC-same-day pair can be different local days and vice versa", () => {
    // 2026-08-23T23:30 UTC is 2026-08-24T07:30 in a UTC+8 zone — a genuine local day change from a UTC-same-day message.
    expect(isNewLocalDay("2026-08-23T10:00:00.000Z", "2026-08-23T23:30:00.000Z", "Asia/Shanghai")).toBe(true);
    // 2026-08-24T01:00 UTC is still 2026-08-23 in America/Los_Angeles (UTC-7/8) — no local day change despite crossing UTC midnight.
    expect(isNewLocalDay("2026-08-23T23:00:00.000Z", "2026-08-24T01:00:00.000Z", "America/Los_Angeles")).toBe(false);
  });
});

describe("daySeparatorLabel", () => {
  const now = new Date("2026-08-24T15:00:00.000Z");

  it("labels a message from today as 'Today'", () => {
    expect(daySeparatorLabel("2026-08-24T09:00:00.000Z", "UTC", now)).toBe("Today");
  });

  it("labels a message from yesterday as 'Yesterday'", () => {
    expect(daySeparatorLabel("2026-08-23T09:00:00.000Z", "UTC", now)).toBe("Yesterday");
  });

  it("labels anything older with a real date, not a relative label", () => {
    expect(daySeparatorLabel("2026-08-01T09:00:00.000Z", "UTC", now)).toBe("August 1, 2026");
  });

  it("'Today'/'Yesterday' are computed in local time, not UTC", () => {
    // now = 2026-08-25T01:00 UTC -> 2026-08-25T09:00 in Asia/Shanghai (local day: Aug 25).
    // message = 2026-08-24T20:00 UTC -> DIFFERENT UTC calendar day (Aug 24) from `now`'s UTC day
    // (Aug 25), which a UTC-day-math implementation would wrongly label "Yesterday" — but in
    // Asia/Shanghai local time the message is 2026-08-25T04:00, the SAME local day as `now`.
    const localNow = new Date("2026-08-25T01:00:00.000Z");
    expect(daySeparatorLabel("2026-08-24T20:00:00.000Z", "Asia/Shanghai", localNow)).toBe("Today");
  });
});

describe("shouldShowInlineTime", () => {
  it("the very first message (no prior) always shows a time", () => {
    expect(shouldShowInlineTime(null, "2026-08-23T10:00:00.000Z")).toBe(true);
  });

  it("no time shown for a short gap under the threshold", () => {
    expect(INLINE_TIME_GAP_MINUTES).toBeGreaterThan(0);
    const prev = "2026-08-23T10:00:00.000Z";
    const soonAfter = new Date(new Date(prev).getTime() + (INLINE_TIME_GAP_MINUTES - 1) * 60 * 1000).toISOString();
    expect(shouldShowInlineTime(prev, soonAfter)).toBe(false);
  });

  it("time shown once the gap meets or exceeds the threshold", () => {
    const prev = "2026-08-23T10:00:00.000Z";
    const later = new Date(new Date(prev).getTime() + INLINE_TIME_GAP_MINUTES * 60 * 1000).toISOString();
    expect(shouldShowInlineTime(prev, later)).toBe(true);
  });

  it("a custom threshold is respected", () => {
    const prev = "2026-08-23T10:00:00.000Z";
    const after10Min = new Date(new Date(prev).getTime() + 10 * 60 * 1000).toISOString();
    expect(shouldShowInlineTime(prev, after10Min, 5)).toBe(true);
    expect(shouldShowInlineTime(prev, after10Min, 15)).toBe(false);
  });
});

describe("formatInlineTime / formatExactTimestamp", () => {
  it("renders a real, non-empty local time string", () => {
    expect(formatInlineTime("2026-08-23T10:00:00.000Z", "UTC")).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  });

  it("shifts with a real timezone, not always UTC", () => {
    const utc = formatInlineTime("2026-08-23T23:30:00.000Z", "UTC");
    const pacific = formatInlineTime("2026-08-23T23:30:00.000Z", "America/Los_Angeles");
    expect(utc).not.toBe(pacific);
  });

  it("the exact timestamp includes the date, not just the time — hover/long-press must show more than the compact badge", () => {
    const exact = formatExactTimestamp("2026-08-23T10:00:00.000Z", "UTC");
    expect(exact).toMatch(/2026/);
    expect(exact).toMatch(/Aug/);
  });

  it("falls back to a real string on an invalid timezone rather than throwing", () => {
    expect(() => formatInlineTime("2026-08-23T10:00:00.000Z", "Not/A_Zone")).not.toThrow();
    expect(() => formatExactTimestamp("2026-08-23T10:00:00.000Z", "Not/A_Zone")).not.toThrow();
  });
});
