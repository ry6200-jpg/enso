/**
 * Assertion-guard live verification (R23, from the Phase 5 closeout
 * finding): the extractor recorded "location: Portland" in dev-data from
 * the literal question "didn't elena move to portland last year?", twice
 * — and separately fabricated a parent_of structural atom from "How's my
 * mom these days?". Both are a proposition embedded in a question being
 * treated as user-asserted fact. taxonomySchema.ts's buildExtractionSystemPrompt
 * now carries an explicit ASSERTION GUARD covering statedFeelings,
 * structuralAtoms, socialBonds (including closures), and attributes alike.
 *
 * Real API calls; run with `npm run test:live` (needs OPENAI_API_KEY and
 * GEMINI_API_KEY — see .env). Per EN-091: never `.skipIf` on a missing key.
 *
 * Each case runs 3 times (not vitest's `it.each` sequentially reusing one
 * result — three independent real calls) and requires 3/3 correct, per
 * this fix's explicit reliability bar. This is a narrower standard than
 * EN-075's N=20/19 router-flag bank (this is one prompt-correctness
 * property, not a stochastic judgment gate being certified for production
 * routing) — see the comment at the bottom of this file for where these
 * exact cases belong in Phase 6's real attestation bank.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { extractMessageWithResilience, type MessageExtractionCompletedPayload } from "../src/extraction/resilientExtraction.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

let router: ExtractionRouter;

beforeAll(() => {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");
  router = createDefaultRouter({ openai: openaiKey, gemini: geminiKey });
});

async function extractOnce(text: string, knownPeopleNames: string[] = []): Promise<MessageExtractionCompletedPayload> {
  const eventLog = new EventLog(":memory:");
  const messageEvent = eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
  const extractionEvent = await extractMessageWithResilience(eventLog, router, messageEvent, undefined, knownPeopleNames);
  eventLog.close();
  return extractionEvent.payload as MessageExtractionCompletedPayload;
}

function isEmptyExtraction(p: MessageExtractionCompletedPayload): boolean {
  return p.attributes.length === 0 && p.structuralAtoms.length === 0 && p.socialBonds.length === 0 && p.statedFeelings.length === 0;
}

describe("Assertion guard (R23), 3/3 reliability", () => {
  it("(a) a question embedding a location claim extracts zero attributes, 3/3", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("Didn't Elena move to Portland last year?", ["Elena"]);
      expect(p.attributes, `attempt ${i + 1}`).toEqual([]);
    }
  }, 60_000);

  it("(b) CONTROL — the equivalent declarative still extracts the attribute, 3/3 (proves the guard doesn't over-suppress)", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("Elena moved to Portland last year.", ["Elena"]);
      expect(p.attributes.length, `attempt ${i + 1}: ${JSON.stringify(p.attributes)}`).toBeGreaterThan(0);
      expect(p.attributes.some((a) => a.value.toLowerCase().includes("portland")), `attempt ${i + 1}`).toBe(true);
    }
  }, 60_000);

  it("(c) a hypothetical/conditional extracts nothing, 3/3", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("If Diego moved away, I'd miss him.", ["Diego"]);
      expect(isEmptyExtraction(p), `attempt ${i + 1}: ${JSON.stringify(p)}`).toBe(true);
    }
  }, 60_000);

  it("(d) a question about whether a bond ended produces no closure (EN-013's stated-basis rule extended), 3/3", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("Did Priya and I stop talking?", ["Priya"]);
      expect(p.socialBonds.some((b) => b.action === "close"), `attempt ${i + 1}: ${JSON.stringify(p.socialBonds)}`).toBe(false);
    }
  }, 60_000);

  it("(structural-atom regression case) a question resolving a kinship term via knownPeopleNames extracts no relationship, 3/3 — the exact dev-data failure", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("How's my mom doing these days?", ["Elena"]);
      expect(p.structuralAtoms, `attempt ${i + 1}`).toEqual([]);
    }
  }, 60_000);

  it("(reported-speech case) someone else's reported belief extracts nothing as the user's own assertion, 3/3", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await extractOnce("Marcus thinks Elena moved to Portland.", ["Elena", "Marcus"]);
      expect(p.attributes.some((a) => a.value.toLowerCase().includes("portland")), `attempt ${i + 1}: ${JSON.stringify(p.attributes)}`).toBe(false);
    }
  }, 60_000);
});

/**
 * Phase 6 attestation bank earmark: when the real N=20/19-threshold LIVE
 * bank for EN-066/EN-075 gets built, it needs an assertion-vs-non-assertion
 * axis alongside the explicit-affirmation-vs-continuer axis EN-066 already
 * specifies. Positive/negative cases to carry forward from this incident:
 *   - direct question:        "Didn't Elena move to Portland last year?"
 *   - lowercase/casual phrasing of the same:  "didn't elena move to portland last year?"
 *   - kinship-term question:  "How's my mom doing these days?" / "how my mon these days?"
 *   - bond-existence question: "Is Diego my cousin?"
 *   - bond-closure question:  "Did Priya and I stop talking?"
 *   - hypothetical/conditional: "If Diego moved away, I'd miss him."
 *   - negation:                "Elena didn't move to Portland." (should extract nothing —
 *                               a stated negative isn't a stated location; not yet tested live)
 *   - reported speech:         "Marcus thinks Elena moved to Portland."
 *   - CONTROL declaratives (must still extract): "Elena moved to Portland last year.",
 *     "We had a falling out and don't talk anymore."
 */
