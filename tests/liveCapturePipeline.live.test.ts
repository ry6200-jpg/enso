/**
 * LIVE suite graduation (EN-090, Phase 3 Part 4). These three checks ran as
 * a one-off script in Phase 2's verification (scripts/phase2Verify.ts) —
 * repeatable certification requires them in the actual suite, not a script
 * someone has to remember to re-run by hand. Real API calls; run with
 * `npm run test:live` (needs OPENAI_API_KEY and GEMINI_API_KEY — see .env).
 *
 * Per EN-091: never `.skipIf` on a missing key — that's how skipped tests
 * drift invisibly. If a key is missing, these fail loudly instead.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { captureMessage, ATTACHMENT_ONLY_PLACEHOLDER, type MessageSentPayload } from "../src/capture/messageCapture.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { createDefaultRouter } from "../src/providers/router.js";
import { createExtractionRouter } from "../src/providers/router.js";
import { createGeminiAdapter } from "../src/providers/geminiAdapter.js";
import { classifyProviderError } from "../src/providers/errors.js";
import type { ExtractionRouter } from "../src/providers/router.js";
import type { ExtractionRequest, ProviderCallResult } from "../src/providers/types.js";
import { ExtractionCache } from "../src/extraction/cache.js";
import { createCachedRouter } from "../src/extraction/cachedRouter.js";
import { extractMessageWithResilience } from "../src/extraction/resilientExtraction.js";
import type { MessageExtractionCompletedPayload } from "../src/extraction/resilientExtraction.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import OpenAI from "openai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

let openaiKey: string;
let geminiKey: string;

beforeAll(() => {
  openaiKey = requireEnv("OPENAI_API_KEY");
  geminiKey = requireEnv("GEMINI_API_KEY");
});

/** Points a real OpenAI client at an unreachable host to force a genuine connection failure. */
function createUnreachableOpenAiRouter(): ExtractionRouter {
  const client = new OpenAI({ apiKey: "sk-does-not-matter", baseURL: "http://127.0.0.1:9/v1", timeout: 3000, maxRetries: 0 });
  return {
    extract: async (_req: ExtractionRequest): Promise<ProviderCallResult> => {
      try {
        await client.responses.create({ model: "gpt-5.6-terra", input: "x" });
        throw new Error("unreachable-host call unexpectedly succeeded");
      } catch (err) {
        throw classifyProviderError(err);
      }
    }
  };
}

describe("forced provider failure -> fallback fires (EN-083, live)", () => {
  it("a real unreachable primary falls back to a real, working Gemini call", async () => {
    const brokenPrimary = createUnreachableOpenAiRouter();
    const realGemini = createGeminiAdapter(geminiKey);
    const router = createExtractionRouter({
      message: { primary: brokenPrimary.extract, fallback: realGemini },
      document: { primary: brokenPrimary.extract, fallback: realGemini }
    });

    const result = await router.extract({ kind: "message", text: "Testing the live fallback path with a friend named Diego." });

    expect(result.provider).toBe("gemini");
    expect(result.taxonomy.entities.some((e) => e.name === "Diego")).toBe(true);
  }, 40_000);
});

describe("extraction cache prevents re-extraction on identical content (EN-056, live)", () => {
  it("misses on first call, hits on second — no second API call for the same text", async () => {
    const costTracker = new CostTracker();
    const realRouter = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
    const cache = new ExtractionCache(freshTestDbPath(import.meta.url, "live-cache"));
    const { router: cachedRouter, stats } = createCachedRouter(cache, realRouter, "message-v1");

    const text = "Live cache test message about my friend Priya.";
    await cachedRouter.extract({ kind: "message", text });
    const callsAfterFirst = costTracker.all().length;
    await cachedRouter.extract({ kind: "message", text });

    expect(stats).toEqual({ hits: 1, misses: 1 });
    expect(costTracker.all().length).toBe(callsAfterFirst); // no new billed call on the second, cached request
  }, 20_000);
});

describe("attachment-only message placeholder survives the full real pipeline (R1/EN-064, live)", () => {
  it("captures the placeholder and successfully extracts against it (never an empty-content crash)", async () => {
    const eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
    const router = createDefaultRouter({ openai: openaiKey, gemini: geminiKey });

    const message = captureMessage(eventLog, { userId: PRIMARY_USER_ID, attachmentCount: 1 });
    const payload = message.payload as MessageSentPayload;
    expect(payload.text).toBe(ATTACHMENT_ONLY_PLACEHOLDER);
    expect(payload.text.length).toBeGreaterThan(0);

    // Real end-to-end proof: the placeholder is real content, not an empty
    // string, so it must flow through real extraction without the
    // empty-user-message crash R1 exists to prevent.
    const extractionEvent = await extractMessageWithResilience(eventLog, router, message);
    expect(extractionEvent.type).toBe("extraction_completed");
    const extractionPayload = extractionEvent.payload as MessageExtractionCompletedPayload;
    expect(extractionPayload.entities).toEqual([]); // "[attachment]" has no people in it, and that's fine
  }, 20_000);
});
