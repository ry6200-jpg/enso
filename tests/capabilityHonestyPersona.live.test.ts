/**
 * Live verification for CAPABILITY_HONESTY_INSTRUCTION (EN-117, R56/R57/
 * R58). Real API calls; run with `node --env-file=.env node_modules/.bin/vitest
 * run tests/capabilityHonestyPersona.live.test.ts` (needs OPENAI_API_KEY,
 * GEMINI_API_KEY — GOOGLE_MAPS_API_KEY unused, ownCoordinates is null by
 * construction in both cases). Per EN-091: never `.skipIf` on a missing key.
 *
 * Exactly two exchanges, per the batch's own cost discipline — not a suite,
 * a targeted persona-wording check. Case A reproduces the real transcript's
 * shape as closely as a single turn allows: a traffic question with only
 * city-tier location resolved (no coordinates), so the real router/fetch
 * pipeline genuinely has nothing to route with — confirms the honesty
 * clause holds in practice, not just that the prompt text says the right
 * thing. Case B is the explicit regression guard: the transcript's own GPS
 * answer was correct and must not regress under the new instruction.
 */
import { describe, expect, it } from "vitest";
import { sendMessage, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { configureLocalOnlyEmbeddings, createEmbedder, EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { createDefaultChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultIntentRouter } from "../src/conversation/router/intentRouter.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

const unusedEmbedder: Embedder = {
  async embed(): Promise<Float32Array> {
    throw new Error("embedder should not be called — this file's cases avoid retrieval mode explicitly");
  },
  modelId: "unused-in-this-file",
  dimensions: EMBEDDING_DIMENSIONS
};

async function freshDepsWithRouter(): Promise<SendMessageDeps> {
  configureLocalOnlyEmbeddings();
  return {
    eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
    retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
    projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
    embedder: await createEmbedder(),
    chatRouter: createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }),
    intentRouter: createDefaultIntentRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") }),
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
  };
}

const INTERNAL_TERMS = /\bAPI\b|\bsystem\b|\btool\b|context window|\bdatabase\b|\bintegration\b/i;
const HEDGE_WORDS = /\bsometimes\b|\busually\b|\boccasionally\b/i;
const IMPLICIT_ALL_CLEAR = /isn't a reason (to|I'd)|not a reason to|don't see a reason to avoid|should(n't| not) be an issue|shouldn't be a problem|nothing to worry about (with|regarding) (the )?traffic/i;

describe("Capability honesty (EN-117, live, real API)", () => {
  it("case A — traffic asked with no origin resolved (city-tier only, matching the real transcript): no hedge, no internal terms, no implicit all-clear", async () => {
    const deps = await freshDepsWithRouter();

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Do you know what the traffic is like getting to Koreatown right now? I'm hungry and thinking about driving over.",
      recentTurns: [],
      locationContext: { placeName: "Los Angeles, California", tier: "ip", timezone: "America/Los_Angeles" },
      ownCoordinates: null
    });

    console.log("\n=== Case A (traffic, no origin resolved) ===\nUser: Do you know what the traffic is like getting to Koreatown right now? I'm hungry and thinking about driving over.\nEnso:", result.replyText, "\n");

    expect(result.replyText).not.toMatch(INTERNAL_TERMS);
    expect(result.replyText).not.toMatch(HEDGE_WORDS);
    expect(result.replyText).not.toMatch(IMPLICIT_ALL_CLEAR);
  }, 30000);

  it("case B — regression guard: asked directly for GPS location with only city-tier resolved, still gives the city and never denies having any location signal at all", async () => {
    const deps = await freshDepsWithRouter();

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Wait, do you actually have my GPS location right now?",
      recentTurns: [],
      locationContext: { placeName: "Los Angeles, California", tier: "ip", timezone: "America/Los_Angeles" },
      ownCoordinates: null
    });

    console.log("=== Case B (GPS regression guard) ===\nUser: Wait, do you actually have my GPS location right now?\nEnso:", result.replyText, "\n");

    // Regression guard is about substance, not the literal word "yes" — the
    // real transcript's own phrasing happened to say "Yes," but a reply that
    // correctly distinguishes GPS specifically (not available) from the
    // city-tier network location it DOES have ("No [GPS], but I have an
    // approximate network location showing Los Angeles") is equally honest
    // and equally non-regressive. What must never happen is denying having
    // ANY location signal at all when city-tier data genuinely resolved.
    expect(result.replyText).toMatch(/Los Angeles/i);
    expect(result.replyText).not.toMatch(/no way to know where you are|don't have any location|no location information|not sure where you are/i);
    expect(result.replyText).not.toMatch(INTERNAL_TERMS);
  }, 30000);
});
