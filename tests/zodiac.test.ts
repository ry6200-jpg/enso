import { describe, expect, it } from "vitest";
import { getChineseZodiacSign, getCurrentChineseYearSign, getWesternZodiacSign } from "../src/zodiac/zodiac.js";

describe("date parsing (item 7: a real, valid birthdate silently failed to unlock the sidebar)", () => {
  it("parses strict ISO YYYY-MM-DD", () => {
    expect(getWesternZodiacSign("1970-04-24")).toBe("Taurus");
    expect(getChineseZodiacSign("1970-04-24")).toBe("Dog");
  });

  it("parses US M/D/YYYY, exactly the real live-caught case — 4/24/1970 silently returned null before this fix", () => {
    expect(getWesternZodiacSign("4/24/1970")).toBe("Taurus");
    expect(getChineseZodiacSign("4/24/1970")).toBe("Dog");
  });

  it("parses US MM/DD/YYYY with leading zeros", () => {
    expect(getWesternZodiacSign("04/24/1970")).toBe("Taurus");
  });

  it("parses spelled-out month names — R38 follow-up, found live: a birthdate stated in an ordinary sentence ('My birthday is April 24, 1970') is stored as literal prose (taxonomySchema.ts's 'as literally asserted'), never reformatted, and this silently returned null before this fix", () => {
    expect(getWesternZodiacSign("April 24, 1970")).toBe("Taurus");
    expect(getWesternZodiacSign("April 24 1970")).toBe("Taurus");
    expect(getWesternZodiacSign("Apr 24, 1970")).toBe("Taurus");
    expect(getWesternZodiacSign("24 April 1970")).toBe("Taurus");
    expect(getWesternZodiacSign("24th April, 1970")).toBe("Taurus");
    expect(getChineseZodiacSign("April 24, 1970")).toBe("Dog");
  });

  it("still returns null for genuinely unparseable input, never a guess", () => {
    expect(getWesternZodiacSign("sometime in spring")).toBeNull();
    expect(getChineseZodiacSign("not a date")).toBeNull();
    expect(getWesternZodiacSign("Notamonth 24, 1970")).toBeNull();
  });
});

describe("getCurrentChineseYearSign", () => {
  it("2026 is the Year of the Horse", () => {
    expect(getCurrentChineseYearSign(new Date("2026-06-15"))).toBe("Horse");
  });
});
