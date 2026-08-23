/**
 * Part B (R38) live verification. Real API calls (chat + extraction, ~13
 * turns each); run with `npm run test:live` (needs OPENAI_API_KEY and
 * GEMINI_API_KEY — see .env). Per EN-091: never `.skipIf` on a missing key.
 *
 * Reproduces the exact real symptom this whole 3-part fix started from: a
 * birthdate stated early in a session, ~10 turns of unrelated conversation
 * later, "when is my birthday" answered "I don't have your birthday in
 * what came back" — confirmed via the earlier investigation to be because
 * the recent window is hard-capped at 6 turns and the raw chunk holding a
 * bare date structurally loses hybridSearch's ranking competition (0 on
 * FTS, an unreliable vector rank) once a session has enough other text.
 *
 * ONE continuous session, real embedder (local, no network — EN-094),
 * no intentRouter (the plain heuristic retrieval path, same as this
 * project's other lighter-weight live tests) for the filler turns to keep
 * this to one paid call per turn instead of two. The final two questions
 * force retrievalOverride n=0 (recencyMode with LIMIT 0 — zero candidate
 * chunks, verified against src/retrieval/recencyMode.ts) so a correct
 * answer CANNOT be retrieval luck: with the birthdate more than 6 turns
 * back (outside maxRecentTurns) and retrieval deliberately starved, the
 * self-profile block (always-on, independent of retrievalOverride — see
 * chatPipeline.ts) is the only remaining source.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sendMessage, type ReplySentPayload, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { refreshMemoryAfterTurn } from "../src/conversation/turnMemoryRefresh.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { configureLocalOnlyEmbeddings, createEmbedder } from "../src/embeddings/embedder.js";
import { createDefaultChatRouter } from "../src/providers/chatRouter.js";
import { createDefaultRouter } from "../src/providers/router.js";
import type { RecentTurnForPrompt } from "../src/persona/systemPrompt.js";
import type { RetrievalInvocation } from "../src/conversation/retrievalInvocation.js";
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

beforeAll(() => {
  openaiKey = requireEnv("OPENAI_API_KEY");
  geminiKey = requireEnv("GEMINI_API_KEY");
});

const FILLER_MESSAGES = [
  "I've been really into hiking lately, especially trails with good views.",
  "This weekend I'm thinking about trying a new trail near the coast.",
  "Work has been steady — mostly routine maintenance tickets this week.",
  "I tried a new coffee shop downtown yesterday, pretty good espresso.",
  "Been reading a science fiction novel before bed most nights.",
  "The weather's been unusually warm for this time of year.",
  "I'm planning to repaint my kitchen sometime next month.",
  "Caught up with an old college friend over the phone last night.",
  "Thinking about getting a new pair of running shoes soon.",
  "Watched a documentary about deep sea creatures last night, really interesting."
];

describe("self-profile block answers 'when is my birthday' after ~10 unrelated turns, without retrieval (Part B, R38, live)", () => {
  it(
    "both 'what do you know about me' and 'when is my birthday' correctly state the birthdate with retrieval forced to zero candidates",
    async () => {
      configureLocalOnlyEmbeddings();
      const embedder = await createEmbedder();
      const deps: SendMessageDeps = {
        eventLog: new EventLog(freshTestDbPath(import.meta.url, "events")),
        projectionsDb: new ProjectionsDb(freshTestDbPath(import.meta.url, "projections")),
        retrievalDb: new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval")),
        embedder,
        chatRouter: createDefaultChatRouter({ openai: openaiKey, gemini: geminiKey })
      };
      const extractionRouter = createDefaultRouter({ openai: openaiKey, gemini: geminiKey });

      const recentTurns: RecentTurnForPrompt[] = [];
      const transcript: string[] = [];

      async function turn(text: string, retrievalOverride?: RetrievalInvocation) {
        const result = await sendMessage(deps, { userId: PRIMARY_USER_ID, text, recentTurns: [...recentTurns], retrievalOverride });
        await refreshMemoryAfterTurn({ eventLog: deps.eventLog, projectionsDb: deps.projectionsDb, retrievalDb: deps.retrievalDb, embedder, extractionRouter }, PRIMARY_USER_ID, result.messageEvent.id);
        recentTurns.push({ role: "user", text }, { role: "enso", text: result.replyText });
        transcript.push(`User: ${text}`, `Enso: ${result.replyText}`);
        return result;
      }

      await turn("Hi, I'm Richard. My birthday is April 24, 1970.");
      for (const filler of FILLER_MESSAGES) {
        await turn(filler);
      }

      const aboutMeResult = await turn("What do you know about me?", { mode: "recency", query: "What do you know about me?", n: 0 });
      const birthdayResult = await turn("When is my birthday?", { mode: "recency", query: "When is my birthday?", n: 0 });

      // Print the transcript so a human can read exactly what happened, per this project's
      // reporting policy — plain terminal text, evidence not just an assertion.
      console.log("\n=== selfProfile.live.test.ts transcript ===\n" + transcript.join("\n") + "\n=== end transcript ===\n");

      const aboutMeProvenance = (aboutMeResult.replyEvent.payload as ReplySentPayload).contextProvenance;
      const birthdayProvenance = (birthdayResult.replyEvent.payload as ReplySentPayload).contextProvenance;

      // The isolation the test depends on: retrieval genuinely contributed nothing,
      // the profile block genuinely was included — so a correct answer can only have
      // come from the profile block, never from retrieval luck.
      expect(aboutMeProvenance.candidateChunkCount).toBe(0);
      expect(aboutMeProvenance.injectedChunkIds).toEqual([]);
      expect(aboutMeProvenance.selfProfile?.included).toBe(true);
      expect(birthdayProvenance.candidateChunkCount).toBe(0);
      expect(birthdayProvenance.injectedChunkIds).toEqual([]);
      expect(birthdayProvenance.selfProfile?.included).toBe(true);

      expect(aboutMeResult.replyText).toMatch(/1970/);
      expect(birthdayResult.replyText).toMatch(/1970/);
      expect(birthdayResult.replyText).toMatch(/april|4\/24|04\/24/i);
    },
    180000
  );
});
