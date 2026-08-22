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
