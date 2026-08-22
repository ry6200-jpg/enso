import { describe, expect, it } from "vitest";
import { PROACTIVE_OPENER_MESSAGE } from "../src/persona/proactiveOpener.js";

describe("PROACTIVE_OPENER_MESSAGE (EN-097 first-session introduction)", () => {
  it("conveys what the user will GET: a place to talk about their life and the people in it", () => {
    expect(PROACTIVE_OPENER_MESSAGE).toMatch(/talk about your life and the people in it/);
  });

  it("conveys that it remembers, so it's still here later", () => {
    expect(PROACTIVE_OPENER_MESSAGE).toMatch(/I remember, so it's still here later/);
  });

  it("conveys that sharing more means it can hold more", () => {
    expect(PROACTIVE_OPENER_MESSAGE).toMatch(/the more you share, the more I can hold onto/);
  });

  it("ends with a short, warm opening, not a pitch or a tour", () => {
    expect(PROACTIVE_OPENER_MESSAGE.trim().endsWith("What should I call you?")).toBe(true);
  });

  it("never lists features — no memory/zodiac/provenance/attachments named as capabilities", () => {
    const lower = PROACTIVE_OPENER_MESSAGE.toLowerCase();
    expect(lower).not.toMatch(/zodiac/);
    expect(lower).not.toMatch(/horoscope/);
    expect(lower).not.toMatch(/provenance/);
    expect(lower).not.toMatch(/attachment/);
    expect(lower).not.toMatch(/upload/);
    expect(lower).not.toMatch(/feature/);
  });

  it("reads as plain, short sentences, not a bulleted or numbered list", () => {
    expect(PROACTIVE_OPENER_MESSAGE).not.toMatch(/\n/);
    expect(PROACTIVE_OPENER_MESSAGE).not.toMatch(/^[-*\d]/m);
  });

  it("stays short — a first-session introduction, not a paragraph", () => {
    expect(PROACTIVE_OPENER_MESSAGE.length).toBeLessThan(320);
  });
});
