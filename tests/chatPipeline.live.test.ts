/**
 * Phase 5 Part 1 live verification (EN-035/040/081/083). Real API calls;
 * run with `npm run test:live` (needs OPENAI_API_KEY and GEMINI_API_KEY —
 * see .env). Per EN-091: never `.skipIf` on a missing key.
 *
 * Scope: the mechanical pipeline (sendMessage end-to-end against a real
 * provider, and a genuine forced-failure fallback to the real Gemini tier)
 * plus one direct persona-voice read of a real reply, per Section 5's
 * verification requirement ("read actual replies from live conversations,
 * never inspect prompt text"). This is not the full repeated-question
 * stress test from Section 5 — that's a larger, dedicated persona
 * validation pass, tracked separately.
 */
import { beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { sendMessage, type ReplySentPayload, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { createChatRouter, createDefaultChatRouter } from "../src/providers/chatRouter.js";
import { createGeminiChatAdapter } from "../src/providers/chatAdapters.js";
import { classifyProviderError } from "../src/providers/errors.js";
import type { ChatAdapter, ChatCallResult, ChatRequest } from "../src/providers/chatTypes.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run test:live with real API keys loaded (e.g. node --env-file=.env node_modules/.bin/vitest ...).`);
  }
  return value;
}

let openaiKey: string;
let geminiKey: string;

// Not touched by any test here: every case uses a retrievalOverride
// (recency mode), so decideRetrievalInvocation and hybridSearch's embedder
// call never run — this file verifies the chat pipeline/provider chain
// (Part 1), not retrieval itself (already live-verified in Phase 4).
const unusedEmbedder: Embedder = {
  async embed(): Promise<Float32Array> {
    throw new Error("embedder should not be called in this file — every test uses a recency-mode retrievalOverride");
  },
  modelId: "unused-in-this-file",
  dimensions: EMBEDDING_DIMENSIONS
};

beforeAll(() => {
  openaiKey = requireEnv("OPENAI_API_KEY");
  geminiKey = requireEnv("GEMINI_API_KEY");
});

function freshDeps(chatRouter: SendMessageDeps["chatRouter"]): SendMessageDeps {
  return {
    eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
    retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
    // Part B (R38): the self-profile block reads projectionsDb unconditionally
    // now, so this can no longer be the `undefined` stand-in it used to be
    // when only the router branch touched it.
    projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
    embedder: unusedEmbedder,
    chatRouter
  };
}

describe("sendMessage against the real OpenAI primary tier (EN-081, live)", () => {
  it("produces a real, non-empty reply and records correct reply_sent provenance", async () => {
    const chatRouter = createDefaultChatRouter({ openai: openaiKey, gemini: geminiKey });
    const deps = freshDeps(chatRouter);

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Just checking in — no big news today.",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "checking in", n: 10 }
    });

    expect(result.replyText.length).toBeGreaterThan(0);
    expect(result.replyEvent.type).toBe("reply_sent");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.provider).toBe("openai");
    expect(payload.text).toBe(result.replyText);
    expect(payload.inReplyToEventId).toBe(result.messageEvent.id);
    expect(payload.contextProvenance.injectedChunkIds).toEqual([]);
  }, 30_000);

  it("a plain factual-style message gets a short, direct reply — not the full therapist validation structure (EN-040)", async () => {
    const chatRouter = createDefaultChatRouter({ openai: openaiKey, gemini: geminiKey });
    const deps = freshDeps(chatRouter);

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Running an errand to pick up dry cleaning this afternoon.",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "errand", n: 10 }
    });

    // EN-041's anti-robot rule and EN-040's voice, read from the actual
    // reply text (never inspected as prompt text): a mundane status update
    // should not get clinical validation-script language.
    const lower = result.replyText.toLowerCase();
    expect(lower).not.toContain("it makes sense that");
    expect(lower).not.toContain("it sounds like you're saying");
  }, 30_000);
});

/** Points a real OpenAI client at an unreachable host to force a genuine connection failure (mirrors liveCapturePipeline.live.test.ts). */
function createUnreachableOpenAiChatAdapter(): ChatAdapter {
  const client = new OpenAI({ apiKey: "sk-does-not-matter", baseURL: "http://127.0.0.1:9/v1", timeout: 3000, maxRetries: 0 });
  return async (_request: ChatRequest): Promise<ChatCallResult> => {
    try {
      await client.responses.create({ model: "gpt-5.6-sol", input: "x" });
      throw new Error("unreachable-host call unexpectedly succeeded");
    } catch (err) {
      throw classifyProviderError(err);
    }
  };
}

describe("forced provider failure -> fallback fires (EN-083, live)", () => {
  it("a real unreachable OpenAI primary falls back to a real, working Gemini reply", async () => {
    const brokenPrimary = createUnreachableOpenAiChatAdapter();
    const realGemini = createGeminiChatAdapter(geminiKey);
    const chatRouter = createChatRouter(brokenPrimary, realGemini);
    const deps = freshDeps(chatRouter);

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Testing the live chat fallback path.",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "fallback test", n: 10 }
    });

    expect(result.replyText.length).toBeGreaterThan(0);
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.provider).toBe("gemini");
  }, 40_000);
});
