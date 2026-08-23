/**
 * Live verification for BREADTH_BEFORE_DEPTH_INSTRUCTION (breadth-before-
 * depth batch, item 1). Real API calls; run with `npm run test:live`
 * (needs OPENAI_API_KEY and GEMINI_API_KEY — see .env). Per EN-091: never
 * `.skipIf` on a missing key.
 *
 * Scope: this instruction governs the FREE-FORM, organically-curious
 * turns that never go through any router-gated candidate pool at all —
 * R44/R45 (elicitation.ts, circleBack.ts) already fix the mechanical half
 * of the real live failure (a gate re-offering the same subject); this
 * targets the other half, reproduced with retrievalOverride n:0 and no
 * gate directive in play, so any pressing of the same thread in these
 * tests can only come from the base model's own organic curiosity — the
 * exact shape of three of the six real askings, which never touched any
 * gate at all.
 *
 * Two cases, one run each — a targeted persona-wording check, not a new
 * router flag needing EN-075's N=20 bar, same scoping precedent as
 * currentLocationPersona.live.test.ts.
 */
import { describe, expect, it } from "vitest";
import { sendMessage, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { createDefaultChatRouter } from "../src/providers/chatRouter.js";
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
    throw new Error("embedder should not be called — every test here uses a recency-mode retrievalOverride");
  },
  modelId: "unused-in-this-file",
  dimensions: EMBEDDING_DIMENSIONS
};

function freshDeps(): SendMessageDeps {
  return {
    eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
    retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
    projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
    embedder: unusedEmbedder,
    chatRouter: createDefaultChatRouter({ openai: requireEnv("OPENAI_API_KEY"), gemini: requireEnv("GEMINI_API_KEY") })
  };
}

// Phrases that would mean the reply pressed back into the SAME already-asked, signal-less thread
// (how they met, who broke the ice, what drew them together, etc.) instead of rotating to a fresh area.
const FRIEND_THREAD_FOLLOWUP_PHRASES = ["how did you", "how you two", "how the two of you", "first met", "broke the ice", "drew you", "how you met"];

describe("BREADTH_BEFORE_DEPTH_INSTRUCTION (breadth-before-depth batch, item 1, live)", () => {
  it("real shape: a signal-less answer about a thread already asked about is NOT pressed again — a fresh area is opened instead", async () => {
    const deps = freshDeps();
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Work has been pretty busy lately, trying to catch up on a backlog.",
      recentTurns: [
        { role: "user", text: "I went to visit a childhood friend recently, first time in years." },
        { role: "enso", text: "That's wonderful — how did you and your childhood friend first meet?" },
        { role: "user", text: "We met at work, nothing special." }
      ],
      retrievalOverride: { mode: "recency", query: "childhood friend", n: 0 }
    });

    console.log("\n=== Case 1 (real shape — signal-less, should NOT press the same thread) ===\nEnso:", result.replyText, "\n");

    const lower = result.replyText.toLowerCase();
    const pressedSameThread = FRIEND_THREAD_FOLLOWUP_PHRASES.some((p) => lower.includes(p));
    expect(pressedSameThread).toBe(false);
  }, 30000);

  it("control — depth requires a signal, not depth-avoidance: when the owner returns to the SAME subject themselves with real elaboration, Enso is still free to engage with it, not deflect", async () => {
    const deps = freshDeps();
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "Actually, thinking about it more — he was the one who got me through a really rough patch in high school. I don't know how I'd have made it without him.",
      recentTurns: [
        { role: "user", text: "I went to visit a childhood friend recently, first time in years." },
        { role: "enso", text: "That's wonderful — how did you and your childhood friend first meet?" },
        { role: "user", text: "We met at work, nothing special." }
      ],
      retrievalOverride: { mode: "recency", query: "childhood friend", n: 0 }
    });

    console.log("=== Case 2 (control — owner returns with a genuine signal, depth should be allowed) ===\nEnso:", result.replyText, "\n");

    expect(result.replyText.length).toBeGreaterThan(0);
    const deflected = /\b(let's talk about something else|moving on|anyway|changing the subject)\b/i.test(result.replyText);
    expect(deflected).toBe(false);
  }, 30000);
});
