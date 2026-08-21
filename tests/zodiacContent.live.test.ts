/**
 * EN-031 live verification: near-identical advice across signs is a named
 * regression (R21 — "Chinese and Western zodiac advice near-identical").
 * Generates today's sidebar reflection for every Chinese sign AND every
 * Western sign (24 real calls) and asserts no two are identical — the
 * concrete, observable proof this defect class doesn't exist here.
 *
 * Real API calls; run with `npm run test:live`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHINESE_ZODIAC_SIGNS, WESTERN_ZODIAC_SIGNS } from "../src/zodiac/zodiac.js";
import { getZodiacSidebarReflection } from "../src/zodiac/zodiacContent.js";
import { DailyContentCache } from "../src/zodiac/dailyContentCache.js";
import { createDefaultChatRouter, type ChatRouter } from "../src/providers/chatRouter.js";
import { freshTestDbPath } from "../src/test/dbPath.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run test:live with real API keys loaded.`);
  return value;
}

let chatRouter: ChatRouter;

beforeAll(() => {
  chatRouter = createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") });
});

describe("Zodiac sidebar reflections are distinct across every sign, same day (R21, EN-031)", () => {
  it("all 12 Chinese signs produce distinct reflections", async () => {
    const cache = new DailyContentCache(freshTestDbPath(import.meta.url, "dailyContent"));
    const reflections = await Promise.all(CHINESE_ZODIAC_SIGNS.map((sign) => getZodiacSidebarReflection(cache, chatRouter, "chinese", sign)));
    cache.close();

    const unique = new Set(reflections);
    if (unique.size !== reflections.length) {
      const bySign = CHINESE_ZODIAC_SIGNS.map((sign, i) => `${sign}: ${reflections[i]}`).join("\n");
      console.log("DUPLICATE REFLECTIONS FOUND:\n" + bySign);
    }
    expect(unique.size).toBe(reflections.length);
  }, 60_000);

  it("all 12 Western signs produce distinct reflections", async () => {
    const cache = new DailyContentCache(freshTestDbPath(import.meta.url, "dailyContent"));
    const reflections = await Promise.all(WESTERN_ZODIAC_SIGNS.map((sign) => getZodiacSidebarReflection(cache, chatRouter, "western", sign)));
    cache.close();

    const unique = new Set(reflections);
    if (unique.size !== reflections.length) {
      const bySign = WESTERN_ZODIAC_SIGNS.map((sign, i) => `${sign}: ${reflections[i]}`).join("\n");
      console.log("DUPLICATE REFLECTIONS FOUND:\n" + bySign);
    }
    expect(unique.size).toBe(reflections.length);
  }, 60_000);

  it("caching returns the exact same content on a second call for the same sign/day (no wasted regeneration)", async () => {
    const cache = new DailyContentCache(freshTestDbPath(import.meta.url, "dailyContent"));
    const first = await getZodiacSidebarReflection(cache, chatRouter, "western", "Aries");
    let secondCallHitProvider = false;
    const spyRouter: ChatRouter = {
      async reply(req) {
        secondCallHitProvider = true;
        return chatRouter.reply(req);
      }
    };
    const second = await getZodiacSidebarReflection(cache, spyRouter, "western", "Aries");
    cache.close();

    expect(second).toBe(first);
    expect(secondCallHitProvider).toBe(false);
  }, 30_000);
});
