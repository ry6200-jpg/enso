import { describe, expect, it } from "vitest";
import { AUTO_SCROLL_THRESHOLD_PX, isPinnedToBottom } from "../app/lib/chatScroll.js";

describe("isPinnedToBottom (mobile layout and scroll fixes batch)", () => {
  it("is pinned when scrolled exactly to the bottom", () => {
    // scrollHeight 1000, clientHeight 400 -> scrolled-to-bottom scrollTop is 600.
    expect(isPinnedToBottom(600, 1000, 400)).toBe(true);
  });

  it("is pinned when within the threshold of the bottom", () => {
    expect(isPinnedToBottom(600 - AUTO_SCROLL_THRESHOLD_PX, 1000, 400)).toBe(true);
  });

  it("is NOT pinned just past the threshold", () => {
    expect(isPinnedToBottom(600 - AUTO_SCROLL_THRESHOLD_PX - 1, 1000, 400)).toBe(false);
  });

  it("is NOT pinned when scrolled to the very top of a long transcript", () => {
    expect(isPinnedToBottom(0, 5000, 400)).toBe(false);
  });

  it("is pinned when the whole transcript fits without scrolling at all", () => {
    // scrollHeight <= clientHeight means there's nothing to scroll — distance from bottom is <= 0.
    expect(isPinnedToBottom(0, 300, 400)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isPinnedToBottom(500, 1000, 400, 200)).toBe(true); // distance 100, under 200
    expect(isPinnedToBottom(500, 1000, 400, 50)).toBe(false); // distance 100, over 50
  });

  it("is independent of transcript length — a long history scrolled to its end reads the same as a short one", () => {
    expect(isPinnedToBottom(9600, 10000, 400)).toBe(true);
    expect(isPinnedToBottom(0, 400, 400)).toBe(true);
  });
});
