import { beforeEach, describe, expect, it } from "vitest";
import { sendMessage, type ReplySentPayload, type SendMessageDeps } from "../src/conversation/chatPipeline.js";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../src/embeddings/embedder.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import type { ChatRouter } from "../src/providers/chatRouter.js";
import type { ChatCallResult } from "../src/providers/chatTypes.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let retrievalDb: RetrievalDb;
let projectionsDb: ProjectionsDb;
let deps: SendMessageDeps;

const CANNED_REPLY: ChatCallResult = {
  provider: "openai",
  model: "gpt-5.6-sol",
  text: "Got it, noted.",
  usage: { inputTokens: 10, outputTokens: 5 } as ChatCallResult["usage"]
};

function fakeChatRouter(result: ChatCallResult = CANNED_REPLY): ChatRouter {
  return {
    async reply() {
      return result;
    }
  };
}

// No network: hybrid mode's runRetrieval always calls embedder.embed even
// against an empty index, so a stub is needed regardless of the override.
const fakeEmbedder: Embedder = {
  async embed(): Promise<Float32Array> {
    return new Float32Array(EMBEDDING_DIMENSIONS);
  },
  modelId: "fake-test-embedder",
  dimensions: EMBEDDING_DIMENSIONS
};

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
  // Part B (R38): the self-profile block reads projectionsDb unconditionally
  // on every turn now, so this can no longer be the `undefined` stand-in it
  // used to be when only the router branch touched it — an empty real
  // instance (no self-facts on record) is enough for these tests.
  projectionsDb = new ProjectionsDb(":memory:");
  deps = {
    eventLog,
    retrievalDb,
    projectionsDb,
    embedder: fakeEmbedder,
    chatRouter: fakeChatRouter()
  };
});

describe("sendMessage — mechanical guarantees on empty retrieval (EN-010/035/040)", () => {
  it("still produces a reply when retrieval finds nothing (recency mode, empty index)", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "catch me up",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "catch me up", n: 10 }
    });

    expect(result.replyText).toBe("Got it, noted.");
    expect(result.replyEvent.type).toBe("reply_sent");
    expect(result.debug.retrieval.candidateCount).toBe(0);
    expect(result.debug.retrieval.injectedChunkIds).toEqual([]);
  });

  it("still produces a reply when hybrid retrieval finds nothing", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "tell me something",
      recentTurns: [],
      // hybridSearch is bypassed entirely by the override, so this exercises
      // the "hybrid mode, zero candidates" shape without needing a real
      // embedder wired up.
      retrievalOverride: { mode: "hybrid", query: "tell me something" }
    });

    expect(result.replyText).toBe("Got it, noted.");
    expect(result.replyEvent.type).toBe("reply_sent");
  });

  it("captures the message before the reply, even though retrieval and the provider call return nothing/empty", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "hello", n: 10 }
    });

    expect(result.messageEvent.type).toBe("message_sent");
    // The capture write is independently visible in the log, not just on
    // the returned object (mirrors messageCapture.test.ts's re-read check).
    expect(eventLog.getById(result.messageEvent.id)).toBeDefined();
  });
});

describe("reply_sent always records contextProvenance, including when empty (round-trip survival, CLAUDE.md)", () => {
  it("records an explicit empty injectedChunkIds array — never omits the field — when retrieval found nothing", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "catch me up",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "catch me up", n: 10 }
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance).toBeDefined();
    expect(Array.isArray(payload.contextProvenance.injectedChunkIds)).toBe(true);
    expect(payload.contextProvenance.injectedChunkIds).toEqual([]);
    expect(payload.contextProvenance.candidateChunkCount).toBe(0);
    expect(payload.contextProvenance.retrievalTruncated).toBe(false);
  });

  it("records recent-window provenance as explicit zeros, not omitted, when there is no conversation history yet", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "hello", n: 10 }
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.recentWindowAvailableTurns).toBe(0);
    expect(payload.contextProvenance.recentWindowInjectedTurns).toBe(0);
    expect(payload.contextProvenance.recentWindowTruncated).toBe(false);
  });

  it("records inReplyToEventId pointing at the just-captured message_sent event, and persists on re-read from the log", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "hello", n: 10 }
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.inReplyToEventId).toBe(result.messageEvent.id);

    const reread = eventLog.getById(result.replyEvent.id);
    expect(reread).toBeDefined();
    const rereadPayload = reread!.payload as ReplySentPayload;
    expect(rereadPayload.contextProvenance.injectedChunkIds).toEqual([]);
    expect(rereadPayload.inReplyToEventId).toBe(result.messageEvent.id);
  });

  it("records provider/model on reply_sent so a failover reply is distinguishable from a primary-tier reply", async () => {
    deps.chatRouter = fakeChatRouter({ ...CANNED_REPLY, provider: "gemini", model: "gemini-3.7-flash" });

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "hello", n: 10 }
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.provider).toBe("gemini");
    expect(payload.model).toBe("gemini-3.7-flash");
  });
});

describe("sendMessage — attachment context reaches the reply (item 8)", () => {
  function seedDocumentAttachment(fullText: string, boundedExcerpt: string) {
    const upload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "notes.txt", mimeType: "text/plain", byteLength: fullText.length, path: "x" },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, extractorVersion: "attachment-v1", provider: "openai", model: "gpt-5.6-terra", kind: "document", fullText, boundedExcerpt, truncated: false, entities: [] },
      userId: PRIMARY_USER_ID
    });
    return upload.id;
  }

  it("allows an attachment-only message with empty text (R1/EN-064), never crashing on an empty provider call", async () => {
    const uploadId = seedDocumentAttachment("Trip itinerary: Lisbon, Oct 3-10.", "Trip itinerary: Lisbon, Oct 3-10.");
    let receivedLatestMessage: string | undefined;
    deps.chatRouter = {
      async reply(request) {
        receivedLatestMessage = request.latestMessage;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "", n: 10 },
      attachmentEventId: uploadId
    });

    expect(receivedLatestMessage).toBe("[attachment]"); // never an empty string to the provider
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.attachmentContext).toEqual({ sourceEventId: uploadId, filename: "notes.txt", kind: "document", contentInjected: true });
  });

  it("injects the attachment's actual content into the system prompt, framed conversationally not as a report", async () => {
    const uploadId = seedDocumentAttachment("Trip itinerary: Lisbon, Oct 3-10.", "Trip itinerary: Lisbon, Oct 3-10.");
    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "what do you think?",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "what do you think?", n: 10 },
      attachmentEventId: uploadId
    });

    expect(receivedSystem).toContain("Trip itinerary: Lisbon, Oct 3-10.");
    expect(receivedSystem).toContain("NOT a request for a document summary or report");
  });

  it("round-trip survival: attachmentContext is null when no attachment was part of this turn", async () => {
    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "no file here",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "no file here", n: 10 }
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.attachmentContext).toBeNull();
  });

  it("round-trip survival: records contentInjected false, with the real filename, when extraction hasn't completed yet — never indistinguishable from no attachment", async () => {
    const upload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "still-processing.pdf", mimeType: "application/pdf", byteLength: 100, path: "x" },
      userId: PRIMARY_USER_ID
    });

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "", n: 10 },
      attachmentEventId: upload.id
    });

    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.attachmentContext).toEqual({ sourceEventId: upload.id, filename: "still-processing.pdf", kind: "document", contentInjected: false });
  });

  it("EN-065 edge case: a stale reference to an already-deleted upload is treated as no attachment at all, never injected", async () => {
    const uploadId = seedDocumentAttachment("Trip itinerary: Lisbon, Oct 3-10.", "Trip itinerary: Lisbon, Oct 3-10.");
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: uploadId, filename: "notes.txt", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "what do you think?",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "what do you think?", n: 10 },
      attachmentEventId: uploadId
    });

    expect(receivedSystem).not.toContain("Trip itinerary");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.attachmentContext).toBeNull();
  });
});

describe("sendMessage — self-profile block reaches the prompt (Part B, R38)", () => {
  it("a known self-fact reaches the actual system prompt sent to the model, and is recorded in contextProvenance", async () => {
    projectionsDb.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "birthdate",
      value: "1970-04-24",
      source_event_ids: "[]",
      created_at: new Date().toISOString()
    });

    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "what do you know about me?",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "what do you know about me?", n: 10 }
    });

    expect(receivedSystem).toContain("=== OWNER PROFILE (begin) ===");
    expect(receivedSystem).toContain("Birthdate: 1970-04-24");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.selfProfile).toEqual({ included: true, attributeCount: 1, bondCount: 0, truncated: false });
  });

  it("omits the block from the prompt entirely for a genuinely fresh user — no OWNER PROFILE marker at all", async () => {
    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "hello", n: 10 }
    });

    expect(receivedSystem).not.toContain("OWNER PROFILE");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.selfProfile).toEqual({ included: false, attributeCount: 0, bondCount: 0, truncated: false });
  });
});

describe("sendMessage — recentTurns omitted: the event log is the source of truth (Part B-0)", () => {
  it("with no recentTurns supplied, pulls the real session history from the event log itself, past what any 6-turn cap would have shown", async () => {
    // Seed 8 prior turns directly on the event log — more than the old
    // hardcoded 6-turn window ever showed, and more than the client used
    // to resend (app/page.tsx's old `messages.slice(-6)`).
    for (let i = 0; i < 8; i++) {
      eventLog.append({ type: "message_sent", actor: "user", payload: { text: `old message ${i}`, attachmentOnly: false }, userId: PRIMARY_USER_ID });
      eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: `old reply ${i}` }, userId: PRIMARY_USER_ID });
    }

    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "what's the oldest thing I told you?",
      retrievalOverride: { mode: "recency", query: "oldest", n: 0 }
      // recentTurns intentionally omitted
    });

    expect(receivedSystem).toContain("old message 0"); // the very oldest turn — a 6-turn cap would have dropped it
    expect(receivedSystem).toContain("old reply 7");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.recentWindowAvailableTurns).toBe(16); // 8 pairs, not capped to 6
    expect(payload.contextProvenance.recentWindowInjectedTurns).toBe(16);
  });

  it("the just-captured current message is excluded from its own recent window — it's the live input, not history", async () => {
    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "a genuinely unique marker string xyzq",
      retrievalOverride: { mode: "recency", query: "xyzq", n: 0 }
    });

    // Appears once — as the live message to the model, never duplicated into the recent-window block too.
    const occurrences = receivedSystem.split("a genuinely unique marker string xyzq").length - 1;
    expect(occurrences).toBe(0); // the message itself is the chat call's latestMessage, not part of the system prompt at all
  });

  it("an explicit recentTurns override still works — the escape hatch for direct test control is preserved", async () => {
    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "hello",
      recentTurns: [{ role: "user", text: "explicitly overridden turn" }],
      retrievalOverride: { mode: "recency", query: "hello", n: 0 }
    });

    expect(receivedSystem).toContain("explicitly overridden turn");
  });
});

describe("sendMessage — entity dossier reaches the prompt on direct name match (Part D, R40)", () => {
  it("a known entity named in the current message gets its structured record injected directly", async () => {
    const elenaId = newId();
    projectionsDb.insertEntity({ id: elenaId, user_id: PRIMARY_USER_ID, name: "Elena", confirmed: 1, source_event_ids: "[]", extractor_version: "v1", pending_disambiguation: null, created_at: new Date().toISOString() });
    projectionsDb.insertEntityAlias({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: elenaId, alias: "Elena", source_event_ids: "[]", created_at: new Date().toISOString() });
    projectionsDb.insertEntityAttribute({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: elenaId, attribute: "location", value: "Seattle", source_event_ids: "[]", created_at: new Date().toISOString() });

    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "I saw Elena yesterday.",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "Elena", n: 0 }
    });

    expect(receivedSystem).toContain("=== NAMED PEOPLE (begin) ===");
    expect(receivedSystem).toContain("Elena");
    expect(receivedSystem).toContain("Location: Seattle");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.entityDossier).toEqual({ mentionedEntityIds: [elenaId], includedEntityCount: 1 });
  });

  it("no known entity named: no NAMED PEOPLE block, empty provenance", async () => {
    let receivedSystem = "";
    deps.chatRouter = {
      async reply(request) {
        receivedSystem = request.system;
        return CANNED_REPLY;
      }
    };

    const result = await sendMessage(deps, {
      userId: PRIMARY_USER_ID,
      text: "just an ordinary day",
      recentTurns: [],
      retrievalOverride: { mode: "recency", query: "day", n: 0 }
    });

    // Not a bare "NAMED PEOPLE" substring check — MEMORY_HONESTY_INSTRUCTION (persona block, always present) now references the block by name generically.
    expect(receivedSystem).not.toContain("=== NAMED PEOPLE (begin)");
    const payload = result.replyEvent.payload as ReplySentPayload;
    expect(payload.contextProvenance.entityDossier).toEqual({ mentionedEntityIds: [], includedEntityCount: 0 });
  });
});
