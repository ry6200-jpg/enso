/**
 * Batch 2, item 7 live verification. Real API call against OpenAI's
 * extraction tier; run with `npm run test:live` (needs OPENAI_API_KEY and
 * GEMINI_API_KEY — see .env). Per EN-091: never `.skipIf` on a missing key.
 *
 * Reproduces the exact live-caught bug with the exact real text: the user
 * answered Enso's own "I'd love to. When is it?" (about their birthday)
 * with the bare message "4/24/1970". Confirmed via direct dev-data query
 * (no live call needed for the reproduction itself — see the batch report)
 * that the extractor, given only that bare text, returned an empty
 * attributes array. This file's job is the one thing that DOES need a real
 * call: confirming that passing Enso's preceding reply as context (the
 * item 7 fix) now lets the same model resolve what the bare date refers to
 * and extract it as the primary user's own birthdate.
 */
import { describe, expect, it } from "vitest";
import { createDefaultRouter } from "../src/providers/router.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

describe("message extraction with precedingReplyText (item 7 fix, real API)", () => {
  it("resolves a bare date answering Enso's own birthday question into a 'me' birthdate attribute", async () => {
    const router = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") });

    const result = await router.extract({
      kind: "message",
      text: "4/24/1970",
      referenceDate: "2026-08-21",
      knownPeopleNames: ["Richard", "team lead"],
      precedingReplyText: "I'd love to. When is it?"
    });

    const attribute = result.taxonomy.attributes.find((a) => a.attribute === "birthdate");
    expect(attribute).toBeDefined();
    expect(attribute?.entityName.toLowerCase()).toBe("me");
    expect(attribute?.value).toContain("1970");
  }, 30000);
});

describe("message extraction with precedingReplyText (item 10 fix, real API)", () => {
  it("recognizes a bare name answering Enso's own 'what should I call you?' as self-reference — extracts NO third-party entity", async () => {
    const router = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") });

    const result = await router.extract({
      kind: "message",
      text: "Richard",
      referenceDate: "2026-08-21",
      knownPeopleNames: [],
      precedingReplyText: "Hi, I'm Enso. I'd love to get to know you a little before we start — what should I call you?"
    });

    expect(result.taxonomy.entities).toEqual([]);
  }, 30000);
});

/**
 * Part C (R37/R38 investigation follow-up). taxonomySchema.ts's
 * precedingReplyBlock used to hard-code the example "a bare date answering
 * a question about a birthday" on EVERY extraction call, regardless of
 * what the actual preceding question was about — a standing anchor toward
 * exactly this misreading. This reproduces the exact real failure with the
 * exact real text (confirmed via dev-data query, no live call needed for
 * the reproduction itself: the extractor tagged "1983" — answering "what
 * year did you turn 13?" — as a `birthdate` for "me") against the FIXED
 * prompt, plus a genuine birthday-answer control to confirm the fix didn't
 * regress the original item-7 case above. 3 runs each per the scope this
 * verification was asked for — a lighter bar than EN-075's N=20 router-flag
 * doctrine, deliberate: this is one extraction-prompt wording change, not a
 * new stochastic router decision.
 */
describe("precedingReplyBlock anchor fix — the real failing case (R37/R38, real API, 3 runs)", () => {
  it.each([1, 2, 3])("run %i: 'What year did you turn 13?' -> '1983' extracts NO birthdate for 'me'", async () => {
    const router = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") });

    const result = await router.extract({
      kind: "message",
      text: "1983",
      referenceDate: "2026-08-21",
      knownPeopleNames: [],
      precedingReplyText:
        "Since you mentioned SRP and SPM, at 13 you were probably entering Form 1 in Malaysia's national secondary-school system. What year did you turn 13? That matters because Malaysia's curriculum, exam names, and language policies changed quite a bit over time."
    });

    const meBirthdate = result.taxonomy.attributes.find((a) => a.entityName.toLowerCase() === "me" && a.attribute === "birthdate");
    expect(meBirthdate).toBeUndefined();
  }, 30000);
});

describe("precedingReplyBlock anchor fix — control: a genuine birthday answer still extracts correctly (R37/R38, real API, 3 runs)", () => {
  it.each([1, 2, 3])("run %i: 'When's your birthday?' -> '4/24/1970' still extracts a birthdate for 'me'", async () => {
    const router = createDefaultRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") });

    const result = await router.extract({
      kind: "message",
      text: "4/24/1970",
      referenceDate: "2026-08-21",
      knownPeopleNames: [],
      precedingReplyText: "Glad you're here, Richard. When's your birthday?"
    });

    const meBirthdate = result.taxonomy.attributes.find((a) => a.entityName.toLowerCase() === "me" && a.attribute === "birthdate");
    expect(meBirthdate).toBeDefined();
    expect(meBirthdate?.value).toContain("1970");
  }, 30000);
});
