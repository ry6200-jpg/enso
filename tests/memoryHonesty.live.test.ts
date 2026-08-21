/**
 * Phase 5 Part 2 live verification (EN-020/035/045, R9/R10/R14). Real API
 * calls; run with `npm run test:live` (needs OPENAI_API_KEY and
 * GEMINI_API_KEY — see .env). Per EN-091: never `.skipIf` on a missing key.
 *
 * Scope: the three honesty behaviors the persona prompt (already ported in
 * Part 1's persona/instructions.ts — MEMORY_HONESTY_INSTRUCTION) is
 * supposed to enforce, read from actual live replies (Section 5's
 * verification requirement), never from prompt-text inspection:
 *  1. Accurate citation from the retrieved block — no confabulated
 *     specifics (R14).
 *  2. Empty retrieval handled honestly, in-voice — never a flat capability
 *     denial (R10).
 *  3. Never exposes retrieval mechanics in prose.
 *
 * R9 (literal user phrasing used as the search query) is NOT re-tested
 * here: it's a deterministic routing decision (decideRetrievalInvocation's
 * RECENCY_PHRASES check), already FAST-tested in
 * tests/retrievalInvocation.test.ts — a live LLM call adds no information
 * about a branch that never reaches a model.
 *
 * The two chatPipeline mechanical guarantees this phase's prompt also asked
 * about (empty-retrieval still produces a reply; reply_sent always records
 * contextProvenance, including empty) are already FAST-tested in
 * tests/chatPipeline.test.ts (Part 1) — not duplicated here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sendMessage, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
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

let openaiKey: string;
let geminiKey: string;
let embedder: Embedder;

beforeAll(async () => {
  openaiKey = requireEnv("OPENAI_API_KEY");
  geminiKey = requireEnv("GEMINI_API_KEY");
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

function freshDeps(): SendMessageDeps & { eventLog: EventLog; retrievalDb: RetrievalDb; projectionsDb: ProjectionsDb } {
  return {
    eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
    retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
    projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
    embedder,
    chatRouter: createDefaultChatRouter({ openai: openaiKey, gemini: geminiKey })
  };
}

// Phrases that would mean the model flatly denied having any way to check
// the user's own history (R10) — the honest gap is "not found this time,"
// never "can't look."
const CAPABILITY_DENIAL_PHRASES = ["don't have access", "do not have access", "can't search", "cannot search", "no way to check", "don't have the ability", "unable to access", "i can't look", "i cannot look"];

// Words that would mean the model exposed how memory retrieval actually
// works, instead of speaking "the way a person with a very good memory
// would" (MEMORY_HONESTY_INSTRUCTION's own phrasing).
const MECHANICS_WORDS = ["database", "sql", "chunk", "vector embed", "embedding", " query", "provenance", " index", "retriev"];

describe("Memory honesty in conversation (EN-020/035/045, live)", () => {
  it("cites a real retrieved fact accurately, without inventing specifics beyond it (R14)", async () => {
    const deps = freshDeps();
    deps.eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My dog's name is Biscuit." }, userId: PRIMARY_USER_ID });
    await rebuildRetrievalIndex(deps.eventLog.listForUser(PRIMARY_USER_ID), deps.retrievalDb, PRIMARY_USER_ID, embedder);

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "What's my dog's name again?",
      recentTurns: []
    });

    expect(result.debug.retrieval.injectedChunkIds.length).toBeGreaterThan(0);
    expect(result.replyText.toLowerCase()).toContain("biscuit");
  }, 30_000);

  it("handles an empty retrieval result honestly, in-voice — never denies having a way to check history (R10)", async () => {
    const deps = freshDeps();
    // No seeded history at all for this fresh user/store.
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "What's my sister's middle name?",
      recentTurns: []
    });

    expect(result.debug.retrieval.injectedChunkIds).toEqual([]);
    const lower = result.replyText.toLowerCase();
    for (const phrase of CAPABILITY_DENIAL_PHRASES) {
      expect(lower).not.toContain(phrase);
    }
  }, 30_000);

  it("never exposes retrieval mechanics in prose, even when directly asked how memory works", async () => {
    const deps = freshDeps();
    deps.eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My favorite color is teal." }, userId: PRIMARY_USER_ID });
    await rebuildRetrievalIndex(deps.eventLog.listForUser(PRIMARY_USER_ID), deps.retrievalDb, PRIMARY_USER_ID, embedder);

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "How exactly do you remember things I've told you?",
      recentTurns: []
    });

    const lower = result.replyText.toLowerCase();
    for (const word of MECHANICS_WORDS) {
      expect(lower).not.toContain(word);
    }
  }, 30_000);
});
