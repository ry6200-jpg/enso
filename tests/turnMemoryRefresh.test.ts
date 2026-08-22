import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { refreshMemoryAfterTurn } from "../src/conversation/turnMemoryRefresh.js";
import type { ExtractionRouter } from "../src/providers/router.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { PROACTIVE_OPENER_MESSAGE } from "../src/persona/proactiveOpener.js";

let eventLog: EventLog;
let projectionsDb: ProjectionsDb;
let retrievalDb: RetrievalDb;
const embedder: Embedder = {
  async embed(): Promise<Float32Array> {
    return new Float32Array(EMBEDDING_DIMENSIONS);
  },
  modelId: "fake-test-embedder",
  dimensions: EMBEDDING_DIMENSIONS
};

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projectionsDb = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
});

describe("refreshMemoryAfterTurn (item 7: preceding-reply lookup)", () => {
  it("passes the immediately-preceding reply_sent text through to extraction, not an earlier one", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "work has been busy", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "Busy can swallow the whole week." }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "do you want to know my birthday?", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "I'd love to. When is it?" }, userId: PRIMARY_USER_ID });
    const dateMessage = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "4/24/1970", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    let received: string | undefined;
    const extractionRouter: ExtractionRouter = {
      extract: async (request) => {
        received = request.precedingReplyText;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    };

    await refreshMemoryAfterTurn({ eventLog, projectionsDb, retrievalDb, embedder, extractionRouter }, PRIMARY_USER_ID, dateMessage.id);
    expect(received).toBe("I'd love to. When is it?");
  });

  it("item 10: on the very first message of a session, falls back to the real (fixed, never-persisted) proactive opener text — this is exactly the live-caught case where 'Richard' got extracted as a third-party entity because nothing told extraction it was answering 'what should I call you?'", async () => {
    const message = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Richard", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    let received: string | undefined;
    const extractionRouter: ExtractionRouter = {
      extract: async (request) => {
        received = request.precedingReplyText;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    };

    await refreshMemoryAfterTurn({ eventLog, projectionsDb, retrievalDb, embedder, extractionRouter }, PRIMARY_USER_ID, message.id);
    expect(received).toBe(PROACTIVE_OPENER_MESSAGE);
  });

  it("does NOT fall back to the opener text once a real prior message exists, even if that message's own reply hasn't landed yet", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Richard", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    // No reply_sent for the above yet — simulates a prior turn whose reply failed (EN-010: the
    // message_sent commit is never rolled back even when the provider call afterward fails).
    const secondMessage = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hello?", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    let received: string | undefined = "sentinel";
    const extractionRouter: ExtractionRouter = {
      extract: async (request) => {
        received = request.precedingReplyText;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    };

    await refreshMemoryAfterTurn({ eventLog, projectionsDb, retrievalDb, embedder, extractionRouter }, PRIMARY_USER_ID, secondMessage.id);
    expect(received).toBeUndefined();
  });
});
