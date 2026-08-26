import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import {
  BOUNDED_EXCERPT_CHARS,
  extractDocumentContent,
  extractImageContent,
  type DocumentExtractionCompletedPayload,
  type ImageExtractionCompletedPayload
} from "../src/attachments/attachmentContent.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../src/providers/attachmentTypes.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

function fakeUploadEvent() {
  return eventLog.append({
    type: "file_uploaded",
    actor: "user",
    payload: { filename: "test.pdf", mimeType: "application/pdf", byteLength: 10, path: "aa/fake.pdf" },
    userId: PRIMARY_USER_ID
  });
}

describe("extractDocumentContent (EN-062/063)", () => {
  it("stores the complete full text and binds provenance to the upload event's ULID (EN-053)", async () => {
    const upload = fakeUploadEvent();
    const fakeRouter = {
      extract: (async () => ({
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        fullText: "Page one text. Page two text.",
        entities: [{ name: "Sarah", type: "person" as const }],
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }
      })) satisfies DocumentContentAdapter
    };

    const event = await extractDocumentContent(eventLog, fakeRouter, upload, {
      bytes: Buffer.from("fake pdf bytes"),
      mimeType: "application/pdf",
      filename: "test.pdf"
    });

    expect(event.type).toBe("extraction_completed");
    const payload = event.payload as DocumentExtractionCompletedPayload;
    expect(payload.sourceEventId).toBe(upload.id);
    expect(payload.fullText).toBe("Page one text. Page two text.");
    expect(payload.entities).toEqual([{ name: "Sarah", type: "person" }]);
    expect(payload.truncated).toBe(false);
    expect(payload.boundedExcerpt).toBe(payload.fullText);
  });

  it("computes a bounded excerpt with explicit truncation for a long document (EN-063)", async () => {
    const upload = fakeUploadEvent();
    const longText = "x".repeat(BOUNDED_EXCERPT_CHARS + 500);
    const fakeRouter = {
      extract: (async () => ({
        provider: "gemini" as const,
        model: "gemini-3.7-flash",
        fullText: longText,
        entities: [],
        usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 0 }
      })) satisfies DocumentContentAdapter
    };

    const event = await extractDocumentContent(eventLog, fakeRouter, upload, {
      bytes: Buffer.from("fake"),
      mimeType: "application/pdf",
      filename: "big.pdf"
    });

    const payload = event.payload as DocumentExtractionCompletedPayload;
    expect(payload.fullText).toBe(longText); // full text always stored, never discarded
    expect(payload.truncated).toBe(true);
    expect(payload.boundedExcerpt).toHaveLength(BOUNDED_EXCERPT_CHARS);
    expect(payload.boundedExcerpt).toBe(longText.slice(0, BOUNDED_EXCERPT_CHARS));
  });
});

describe("extractImageContent (EN-062)", () => {
  it("stores the description bound to the upload event's ULID", async () => {
    const upload = fakeUploadEvent();
    const fakeRouter = {
      extract: (async () => ({
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        description: "A photo of two people at a cafe table.",
        usage: { inputTokens: 15, outputTokens: 20, cachedInputTokens: 0 }
      })) satisfies ImageContentAdapter
    };

    const event = await extractImageContent(eventLog, fakeRouter, upload, {
      bytes: Buffer.from("fake image bytes"),
      mimeType: "image/jpeg"
    });

    expect(event.type).toBe("extraction_completed");
    const payload = event.payload as ImageExtractionCompletedPayload;
    expect(payload.kind).toBe("image");
    expect(payload.sourceEventId).toBe(upload.id);
    expect(payload.description).toBe("A photo of two people at a cafe table.");
  });
});
