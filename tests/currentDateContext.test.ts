import { describe, expect, it } from "vitest";
import { buildCurrentDateContextBlock, buildSystemPrompt } from "../src/persona/systemPrompt.js";

describe("buildCurrentDateContextBlock (breadth-before-depth batch, item 4)", () => {
  it("renders today's real date, not a guess derived from anything else", () => {
    const block = buildCurrentDateContextBlock(new Date("2026-08-22T12:00:00Z"), 100)!;
    expect(block).toContain("=== CURRENT DATE (begin) ===");
    expect(block).toContain("Today's date:");
    expect(block).toMatch(/August 22, 2026/);
  });

  it("age-derivation across a birthday boundary: the SAME birthdate (May 20) must render an unambiguously different, correct date on either side of it — the real live bug (86, then 87, then a 'turns 88' date already in the past) was exactly this grounding missing", () => {
    const beforeBirthday = buildCurrentDateContextBlock(new Date("2026-05-19T12:00:00Z"), 100)!;
    const onBirthday = buildCurrentDateContextBlock(new Date("2026-05-20T12:00:00Z"), 100)!;
    const afterBirthday = buildCurrentDateContextBlock(new Date("2026-05-21T12:00:00Z"), 100)!;

    expect(beforeBirthday).toMatch(/May 19, 2026/);
    expect(onBirthday).toMatch(/May 20, 2026/);
    expect(afterBirthday).toMatch(/May 21, 2026/);
    // Three genuinely distinct strings — a model computing age from a 1938-05-20 birthdate has
    // correct, unambiguous grounding for "not yet 88" vs. "turned 88 today" vs. "already 88" instead
    // of no current-date anchor at all (the real bug: the location block's local time is the only
    // date/time computation anywhere in the prompt, and it's absent whenever location never resolves).
    expect(new Set([beforeBirthday, onBirthday, afterBirthday]).size).toBe(3);
  });

  it("respects its own tiny budget — omitted (never mangled) if somehow exceeded", () => {
    expect(buildCurrentDateContextBlock(new Date("2026-08-22"), 5)).toBeNull();
  });

  it("never throws on construction, whatever the input date", () => {
    expect(() => buildCurrentDateContextBlock(new Date("2026-01-01T00:00:00Z"), 100)).not.toThrow();
  });
});

describe("buildSystemPrompt threads the current-date block through", () => {
  it("includes the date block when supplied, omits it entirely when null (never a placeholder line)", () => {
    const dateBlock = buildCurrentDateContextBlock(new Date("2026-08-22T12:00:00Z"), 100);
    const withDate = buildSystemPrompt("", "", null, "natural", null, null, null, dateBlock);
    expect(withDate).toContain("Today's date: Saturday, August 22, 2026");

    // The static CURRENT_DATE_INSTRUCTION prose always mentions "CURRENT DATE" as a concept (same as
    // CURRENT_LOCATION_INSTRUCTION does for location) — what must be absent is the actual per-turn DATA block.
    const withoutDate = buildSystemPrompt("", "", null, "natural", null, null, null, null);
    expect(withoutDate).not.toContain("=== CURRENT DATE (begin) ===");
    expect(withoutDate).not.toContain("Today's date:");
  });
});
