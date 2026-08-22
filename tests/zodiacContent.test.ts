import { describe, expect, it } from "vitest";
import { getZodiacSidebarReflection } from "../src/zodiac/zodiacContent.js";
import { DailyContentCache } from "../src/zodiac/dailyContentCache.js";
import type { ChatRouter } from "../src/providers/chatRouter.js";

/**
 * EN-047/048's explicit requirement: the voice-architecture refactor
 * demotes zen from the conversational default, but item 1 of that refactor
 * says explicitly NOT to touch src/zodiac/zodiacContent.ts — the sidebar's
 * standalone daily reflections are the one surface where the zen register
 * is still correct. This test is the regression guard for that: zodiac
 * generation must keep receiving EN_ZEN_VOICE_INSTRUCTION's markers,
 * completely unaffected by the natural-voice default now used elsewhere.
 */
function capturingChatRouter() {
  let capturedSystem = "";
  const router: ChatRouter = {
    async reply(request) {
      capturedSystem = request.system;
      return { provider: "openai", model: "gpt-5.6-sol", text: "A short reflection.", usage: { inputTokens: 1, outputTokens: 1 } };
    }
  };
  return { router, getCapturedSystem: () => capturedSystem };
}

describe("getZodiacSidebarReflection still receives the zen voice, unaffected by the conversational voice split", () => {
  it("the system prompt carries EN_ZEN_VOICE_INSTRUCTION's own markers, never the new natural-voice or zen-mode conversational text", async () => {
    const cache = new DailyContentCache(":memory:");
    const { router, getCapturedSystem } = capturingChatRouter();

    await getZodiacSidebarReflection(cache, router, "western", "Taurus");

    const system = getCapturedSystem();
    // Markers unique to EN_ZEN_VOICE_INSTRUCTION's own body text.
    expect(system).toMatch(/BREVITY IS THE IMPACT, ALWAYS, NOT AN OCCASIONAL EXCEPTION/);
    expect(system).toMatch(/Calibration \(tone reference only/);
    // Never the new conversational-split constants — zodiac copy is
    // standalone written reflection, not a conversational reply, so
    // neither of these belongs here at all.
    expect(system).not.toMatch(/THE NATURAL VOICE/);
    expect(system).not.toMatch(/ZEN MODE —/);
  });
});
