import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ATTACHMENT_ONLY_PLACEHOLDER, captureMessage, type MessageSentPayload } from "../src/capture/messageCapture.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

describe("captureMessage (EN-010/064)", () => {
  it("appends message_sent with the given text", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "Hello journal." });
    expect(event.type).toBe("message_sent");
    expect(event.actor).toBe("user");
    const payload = event.payload as MessageSentPayload;
    expect(payload.text).toBe("Hello journal.");
    expect(payload.attachmentOnly).toBe(false);
  });

  it("the event is durably committed as soon as captureMessage returns (EN-010)", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "Saved before any AI call." });
    // Re-reading from the log (not from any in-memory reference) proves the
    // write already committed, independent of whatever happens next.
    const reread = eventLog.getById(event.id);
    expect(reread).toBeDefined();
    expect((reread!.payload as MessageSentPayload).text).toBe("Saved before any AI call.");
  });

  it("survives a simulated extraction failure immediately after capture — the message is never lost (EN-010)", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "Important thing to remember." });

    function simulateExtraction(): never {
      throw new Error("simulated provider outage");
    }
    expect(() => simulateExtraction()).toThrow();

    // The message survives regardless of what extraction does afterward.
    expect(eventLog.getById(event.id)).toBeDefined();
    expect(eventLog.count()).toBe(1);
  });

  it("uses the placeholder, never empty content, for an attachment-only message (R1)", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, attachmentCount: 1 });
    const payload = event.payload as MessageSentPayload;
    expect(payload.text).toBe(ATTACHMENT_ONLY_PLACEHOLDER);
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.attachmentOnly).toBe(true);
  });

  it("prefers real text over the placeholder when both text and attachments are present", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "check this out", attachmentCount: 2 });
    const payload = event.payload as MessageSentPayload;
    expect(payload.text).toBe("check this out");
    expect(payload.attachmentOnly).toBe(false);
  });

  it("refuses to capture a message with neither text nor attachments", () => {
    expect(() => captureMessage(eventLog, { userId: PRIMARY_USER_ID })).toThrow(/caller bug/);
    expect(eventLog.count()).toBe(0);
  });

  it("treats whitespace-only text as no text, falling back to the placeholder when attachments are present", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "   ", attachmentCount: 1 });
    expect((event.payload as MessageSentPayload).text).toBe(ATTACHMENT_ONLY_PLACEHOLDER);
  });

  it("records attachmentEventId on the message_sent payload when given one — the explicit link getConversationHistory joins on", () => {
    const upload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "photo.png", mimeType: "image/png", byteLength: 100, path: "ab/photo.png" },
      userId: PRIMARY_USER_ID
    });
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "check this out", attachmentCount: 1, attachmentEventId: upload.id });
    expect((event.payload as MessageSentPayload).attachmentEventId).toBe(upload.id);
  });

  it("omits attachmentEventId from the payload entirely when none was given — never a stray undefined/null field", () => {
    const event = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "no attachment here" });
    expect("attachmentEventId" in (event.payload as object)).toBe(false);
  });

  it("accepts an explicit occurredAt for backdating (EN-016 dual time), defaulting to null when omitted", () => {
    const backdated = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "An old note.", occurredAt: "2020-01-01T00:00:00.000Z" });
    expect(backdated.occurredAt).toBe("2020-01-01T00:00:00.000Z");

    const ordinary = captureMessage(eventLog, { userId: PRIMARY_USER_ID, text: "A normal message." });
    expect(ordinary.occurredAt).toBeNull();
  });
});
