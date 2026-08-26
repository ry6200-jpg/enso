import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { BlobStore } from "../src/blobs/blobStore.js";
import { captureUpload } from "../src/attachments/attachmentCapture.js";
import {
  extractDocumentWithResilience,
  extractImageWithResilience,
  extractMessageWithResilience,
  retryFailedExtraction,
  type ExtractionFailedPayload,
  type MessageExtractionCompletedPayload
} from "../src/extraction/resilientExtraction.js";
import { getExtractionStatus } from "../src/extraction/extractionStatus.js";
import { ProviderAvailabilityError, ClientRequestError } from "../src/providers/errors.js";
import type { ExtractionRouter } from "../src/providers/router.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../src/providers/attachmentTypes.js";
import type { DocumentExtractionCompletedPayload } from "../src/attachments/attachmentContent.js";
import { freshTestDbPath, resolveTestDbDir } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let blobStore: BlobStore;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  blobStore = new BlobStore(resolveTestDbDir(import.meta.url) + "-blobs");
});

function captureTestMessage(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

describe("extractMessageWithResilience (EN-059/060)", () => {
  it("on success, appends extraction_completed with the FULL taxonomy (entities, atoms, bonds, attributes) and classifier decision", async () => {
    const message = captureTestMessage("I had lunch with Sarah today.");
    const router: ExtractionRouter = {
      extract: async () => ({
        provider: "openai",
        model: "gpt-5.6-terra",
        taxonomy: {
          entities: [{ name: "Sarah", type: "person" }],
          statedFeelings: [],
          episodeMarkers: [],
          structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Sarah", action: "assert", explicitlyNewPerson: false }],
          socialBonds: [{ type: "friend", fromName: "me", toName: "Sarah", qualifier: null, basis: "stated", action: "open", explicitlyNewPerson: false }],
          attributes: [{ entityName: "Sarah", attribute: "location", value: "Boston", eventDate: null }]
        },
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }
      })
    };

    const result = await extractMessageWithResilience(eventLog, router, message, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result.type).toBe("extraction_completed");
    const payload = result.payload as MessageExtractionCompletedPayload;
    expect(payload.sourceEventId).toBe(message.id);
    expect(payload.entities).toEqual([{ name: "Sarah", type: "person" }]);
    expect(payload.classifierDecision.isPersonal).toBe(true);
    expect(getExtractionStatus(eventLog, message.id)).toBe("completed");

    // Regression check: these three fields were silently dropped between
    // the provider's taxonomy and the recorded event payload in an earlier
    // version — caught by live verification, not by this suite, which is
    // exactly why this assertion exists now.
    expect(payload.structuralAtoms).toEqual([{ type: "sibling_of", fromName: "me", toName: "Sarah", action: "assert", explicitlyNewPerson: false }]);
    expect(payload.socialBonds).toEqual([{ type: "friend", fromName: "me", toName: "Sarah", qualifier: null, basis: "stated", action: "open", explicitlyNewPerson: false }]);
    expect(payload.attributes).toEqual([{ entityName: "Sarah", attribute: "location", value: "Boston", eventDate: null }]);
  });

  it("passes the message's own told-time as referenceDate, not whenever extraction happens to run (EN-016)", async () => {
    const message = captureTestMessage("She moved last year.");
    let receivedReferenceDate: string | undefined;
    const router: ExtractionRouter = {
      extract: async (request) => {
        receivedReferenceDate = request.referenceDate;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
        };
      }
    };

    await extractMessageWithResilience(eventLog, router, message);
    expect(receivedReferenceDate).toBe(message.recordedAt.slice(0, 10));
  });

  it("passes knownPeopleNames through to the router (EN-012, so the extractor can use an established name instead of a kinship term)", async () => {
    const message = captureTestMessage("My mom called.");
    let received: string[] | undefined;
    const router: ExtractionRouter = {
      extract: async (request) => {
        received = request.knownPeopleNames;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
        };
      }
    };

    await extractMessageWithResilience(eventLog, router, message, undefined, ["Elena", "Marcus"]);
    expect(received).toEqual(["Elena", "Marcus"]);
  });

  it("passes precedingReplyText through to the router (item 7: resolving elliptical answers like a bare date)", async () => {
    const message = captureTestMessage("4/24/1970");
    let received: string | undefined;
    const router: ExtractionRouter = {
      extract: async (request) => {
        received = request.precedingReplyText;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
        };
      }
    };

    await extractMessageWithResilience(eventLog, router, message, undefined, [], "I'd love to. When is it?");
    expect(received).toBe("I'd love to. When is it?");
  });

  it("passes precedingReplyText as undefined when none is available, never a placeholder string", async () => {
    const message = captureTestMessage("A message with no preceding reply.");
    let received: string | undefined = "sentinel";
    const router: ExtractionRouter = {
      extract: async (request) => {
        received = request.precedingReplyText;
        return {
          provider: "openai",
          model: "gpt-5.6-terra",
          taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
        };
      }
    };

    await extractMessageWithResilience(eventLog, router, message);
    expect(received).toBeUndefined();
  });

  it("round-trip survival (CLAUDE.md): the knownPeopleNames that shaped this extraction are recorded in its own payload", async () => {
    const message = captureTestMessage("My mom called.");
    const router: ExtractionRouter = {
      extract: async () => ({
        provider: "openai",
        model: "gpt-5.6-terra",
        taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
      })
    };

    const result = await extractMessageWithResilience(eventLog, router, message, undefined, ["Elena", "Marcus"]);
    const payload = result.payload as MessageExtractionCompletedPayload;
    expect(payload.knownPeopleNames).toEqual(["Elena", "Marcus"]);
  });

  it("round-trip survival: recorded as an empty array, not omitted, when no known people were injected", async () => {
    const message = captureTestMessage("Someone new said hi.");
    const router: ExtractionRouter = {
      extract: async () => ({
        provider: "openai",
        model: "gpt-5.6-terra",
        taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
      })
    };

    const result = await extractMessageWithResilience(eventLog, router, message);
    const payload = result.payload as MessageExtractionCompletedPayload;
    expect(payload.knownPeopleNames).toEqual([]);
  });

  it("round-trip survival holds even on the non-personal (LLM-skipped) path", async () => {
    const referenceText = `Table of Contents\n1.1 Introduction\n1.2 Background\n- a\n- b\n- c\n${"filler word ".repeat(80)}`;
    const message = captureTestMessage(referenceText);
    const router: ExtractionRouter = {
      extract: async () => {
        throw new Error("should never be called for non-personal content");
      }
    };

    const result = await extractMessageWithResilience(eventLog, router, message, undefined, ["Elena"]);
    const payload = result.payload as MessageExtractionCompletedPayload;
    expect(payload.knownPeopleNames).toEqual(["Elena"]);
  });

  it("skips the LLM call entirely for non-personal content — no provider/model recorded", async () => {
    const referenceText = `Table of Contents\n1.1 Introduction\n1.2 Background\n- a\n- b\n- c\n${"filler word ".repeat(80)}`;
    const message = captureTestMessage(referenceText);
    let called = false;
    const router: ExtractionRouter = {
      extract: async () => {
        called = true;
        return { provider: "openai", model: "gpt-5.6-terra", taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] }, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
      }
    };

    const result = await extractMessageWithResilience(eventLog, router, message);
    expect(called).toBe(false);
    const payload = result.payload as MessageExtractionCompletedPayload;
    expect(payload.provider).toBeNull();
    expect(payload.classifierDecision.isPersonal).toBe(false);
  });

  it("retries on availability errors and succeeds, recording status completed", async () => {
    const message = captureTestMessage("Trying again after a hiccup.");
    let attempts = 0;
    const router: ExtractionRouter = {
      extract: async () => {
        attempts++;
        if (attempts < 2) throw new ProviderAvailabilityError("503", 503);
        return { provider: "gemini", model: "gemini-3.7-flash", taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      }
    };

    const result = await extractMessageWithResilience(eventLog, router, message, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result.type).toBe("extraction_completed");
    expect(attempts).toBe(2);
  });

  it("persists extraction_failed after exhausting retries, status queryable as failed", async () => {
    const message = captureTestMessage("This one never succeeds.");
    const router: ExtractionRouter = {
      extract: async () => {
        throw new ProviderAvailabilityError("both tiers down", 503);
      }
    };

    const result = await extractMessageWithResilience(eventLog, router, message, { maxAttempts: 2, baseDelayMs: 1 });
    expect(result.type).toBe("extraction_failed");
    const payload = result.payload as ExtractionFailedPayload;
    expect(payload.sourceEventId).toBe(message.id);
    expect(payload.attempts).toBe(2);
    expect(getExtractionStatus(eventLog, message.id)).toBe("failed");
  });

  it("persists extraction_failed immediately (no retries) on a client error", async () => {
    const message = captureTestMessage("Malformed request scenario.");
    let calls = 0;
    const router: ExtractionRouter = {
      extract: async () => {
        calls++;
        throw new ClientRequestError("400 bad request", 400);
      }
    };

    const result = await extractMessageWithResilience(eventLog, router, message, { maxAttempts: 5, baseDelayMs: 1 });
    expect(result.type).toBe("extraction_failed");
    expect(calls).toBe(1);
  });

  it("a failed extraction can be retried to success via retryFailedExtraction (EN-059's retry entry point)", async () => {
    const message = captureTestMessage("Eventually this will work.");
    let shouldFail = true;
    const router: ExtractionRouter = {
      extract: async () => {
        if (shouldFail) throw new ProviderAvailabilityError("down for now", 503);
        return { provider: "openai", model: "gpt-5.6-terra", taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [], attributes: [] }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      }
    };

    const failedEvent = await extractMessageWithResilience(eventLog, router, message, { maxAttempts: 1, baseDelayMs: 1 });
    expect(failedEvent.type).toBe("extraction_failed");
    expect(getExtractionStatus(eventLog, message.id)).toBe("failed");

    shouldFail = false;
    const retried = await retryFailedExtraction(
      {
        eventLog,
        blobStore,
        messageRouter: router,
        documentRouter: { extract: (async () => { throw new Error("unused"); }) as DocumentContentAdapter },
        imageRouter: { extract: (async () => { throw new Error("unused"); }) as ImageContentAdapter },
        retryConfig: { maxAttempts: 1, baseDelayMs: 1 }
      },
      failedEvent
    );

    expect(retried.type).toBe("extraction_completed");
    expect(getExtractionStatus(eventLog, message.id)).toBe("completed"); // latest wins
  });
});

describe("extractDocumentWithResilience (EN-059/060/062/063)", () => {
  it("classifies after extraction and strips entities (but keeps fullText) for non-personal documents", async () => {
    const upload = captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: Buffer.from("pdf bytes"), filename: "manual.pdf", mimeType: "application/pdf" });
    const referenceText = `Table of Contents\n1.1 Introduction\n1.2 Background\n- a\n- b\n- c\n${"filler word ".repeat(80)}`;
    const documentRouter = {
      extract: (async () => ({
        provider: "gemini" as const,
        model: "gemini-3.7-flash",
        fullText: referenceText,
        entities: [{ name: "SomeName", type: "person" as const }],
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }
      })) satisfies DocumentContentAdapter
    };

    const result = await extractDocumentWithResilience(eventLog, documentRouter, upload, { bytes: Buffer.from("x"), mimeType: "application/pdf", filename: "manual.pdf" });
    const payload = result.payload as DocumentExtractionCompletedPayload & { classifierDecision: { isPersonal: boolean } };
    expect(payload.fullText).toBe(referenceText); // always kept regardless of classification
    expect(payload.entities).toEqual([]); // stripped — classifier governs entity extraction only
    expect(payload.classifierDecision.isPersonal).toBe(false);
  });

  it("keeps entities for personal documents", async () => {
    const upload = captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: Buffer.from("pdf bytes"), filename: "diary.pdf", mimeType: "application/pdf" });
    const documentRouter = {
      extract: (async () => ({
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        fullText: "I wrote about my day with Sarah.",
        entities: [{ name: "Sarah", type: "person" as const }],
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }
      })) satisfies DocumentContentAdapter
    };

    const result = await extractDocumentWithResilience(eventLog, documentRouter, upload, { bytes: Buffer.from("x"), mimeType: "application/pdf", filename: "diary.pdf" });
    const payload = result.payload as DocumentExtractionCompletedPayload;
    expect(payload.entities).toEqual([{ name: "Sarah", type: "person" }]);
  });

  it("persists extraction_failed for a document after exhausting retries", async () => {
    const upload = captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: Buffer.from("pdf bytes"), filename: "bad.pdf", mimeType: "application/pdf" });
    const documentRouter = { extract: (async () => { throw new ProviderAvailabilityError("down", 503); }) satisfies DocumentContentAdapter };

    const result = await extractDocumentWithResilience(eventLog, documentRouter, upload, { bytes: Buffer.from("x"), mimeType: "application/pdf", filename: "bad.pdf" }, { maxAttempts: 2, baseDelayMs: 1 });
    expect(result.type).toBe("extraction_failed");
    expect(getExtractionStatus(eventLog, upload.id)).toBe("failed");
  });
});

describe("extractImageWithResilience (EN-059/062)", () => {
  it("appends extraction_completed with the description", async () => {
    const upload = captureUpload(eventLog, blobStore, { userId: PRIMARY_USER_ID, bytes: Buffer.from("img bytes"), filename: "photo.jpg", mimeType: "image/jpeg" });
    const imageRouter = {
      extract: (async () => ({ provider: "openai" as const, model: "gpt-5.6-terra", description: "A photo of a cat.", usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 } })) satisfies ImageContentAdapter
    };

    const result = await extractImageWithResilience(eventLog, imageRouter, upload, { bytes: Buffer.from("x"), mimeType: "image/jpeg" });
    expect(result.type).toBe("extraction_completed");
    expect(getExtractionStatus(eventLog, upload.id)).toBe("completed");
  });
});
