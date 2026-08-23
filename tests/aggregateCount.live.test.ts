/**
 * Live verification for the narrowed AGGREGATE/COUNT clause in
 * MEMORY_HONESTY_INSTRUCTION (breadth-before-depth batch, item 5). Real
 * API calls; run with `npm run test:live` (needs OPENAI_API_KEY and
 * GEMINI_API_KEY — see .env). Per EN-091: never `.skipIf` on a missing
 * key.
 *
 * The old rule banned computing a count at all, in response to a real bug
 * that invented a number from nothing. The narrowed rule keeps that ban
 * for genuinely incomplete data but now allows a real, shown-derivation
 * count when every contributing item is actually visible — reproduced
 * here with the real family-tree case (three + two + one, plus one
 * sibling with none of her own = six grandchildren) plus a control where
 * one branch is genuinely unknown.
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

const FULL_FAMILY_TREE =
  "My mother Ah Kam was born on 5/20/1938. I have three older sisters and one younger sister. Irene is married to Bao Qing; they have no children together, though Bao Qing has two children from a previous marriage. Alice is married to An Song; they have three children together: Soon Jack, Vanessa, and Prisca. Christine has two adult sons. Elly is my younger sister, married to Ah Boon, and they have a daughter named Yan Xi.";

const FAMILY_TREE_MISSING_ELLY =
  "My mother Ah Kam was born on 5/20/1938. I have three older sisters and one younger sister. Irene is married to Bao Qing; they have no children together, though Bao Qing has two children from a previous marriage. Alice is married to An Song; they have three children together: Soon Jack, Vanessa, and Prisca. Christine has two adult sons. Elly is my younger sister — I haven't told you much about her family yet.";

describe("Narrowed AGGREGATE/COUNT rule (breadth-before-depth batch, item 5, live)", () => {
  it("real case: every contributor visible in-session -> computes the real total (6) and shows the derivation", async () => {
    const deps = freshDeps();
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "how many grandchildren does she have?",
      recentTurns: [{ role: "user", text: FULL_FAMILY_TREE }],
      retrievalOverride: { mode: "recency", query: "grandchildren", n: 0 }
    });

    console.log("\n=== Case 1 (real family tree, everything visible) ===\nEnso:", result.replyText, "\n");

    expect(/\b6\b|\bsix\b/i.test(result.replyText)).toBe(true);
    // Shows its work — either by naming individual grandchildren, or by breaking the total down per sibling
    // (e.g. "Alice's 3, Christine's 2, and Elly's 1") — either is a real derivation, not a bare final number.
    const grandchildNames = ["Soon Jack", "Vanessa", "Prisca", "Yan Xi"].filter((n) => result.replyText.includes(n)).length;
    const siblingBreakdown = ["Alice", "Christine", "Elly"].filter((n) => result.replyText.includes(n)).length;
    expect(grandchildNames >= 2 || siblingBreakdown >= 2).toBe(true);
  }, 30000);

  it("control: one branch genuinely unknown (Elly's family never described) -> refuses the total and names the missing part", async () => {
    const deps = freshDeps();
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "how many grandchildren does she have?",
      recentTurns: [{ role: "user", text: FAMILY_TREE_MISSING_ELLY }],
      retrievalOverride: { mode: "recency", query: "grandchildren", n: 0 }
    });

    console.log("=== Case 2 (control — Elly's branch unknown) ===\nEnso:", result.replyText, "\n");

    // Must NOT confidently state a specific total as if complete (3 from Alice + 2 from Christine = 5, the wrong-but-plausible trap).
    expect(/\bexactly (five|5)\b/i.test(result.replyText)).toBe(false);
    // Must name the actual gap.
    expect(/elly/i.test(result.replyText)).toBe(true);
  }, 30000);
});
