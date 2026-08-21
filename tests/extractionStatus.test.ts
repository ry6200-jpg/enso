import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { getExtractionStatus } from "../src/extraction/extractionStatus.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

describe("getExtractionStatus (EN-059)", () => {
  it("is 'pending' when no extraction event references the source yet", () => {
    const message = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hi" }, userId: PRIMARY_USER_ID });
    expect(getExtractionStatus(eventLog, message.id)).toBe("pending");
  });

  it("is 'completed' after an extraction_completed event references it", () => {
    const message = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hi" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: message.id }, userId: PRIMARY_USER_ID });
    expect(getExtractionStatus(eventLog, message.id)).toBe("completed");
  });

  it("is 'failed' after an extraction_failed event references it", () => {
    const message = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hi" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_failed", actor: "system", payload: { sourceEventId: message.id, reason: "timeout" }, userId: PRIMARY_USER_ID });
    expect(getExtractionStatus(eventLog, message.id)).toBe("failed");
  });

  it("reflects the latest event when failed then retried to success", () => {
    const message = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hi" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_failed", actor: "system", payload: { sourceEventId: message.id, reason: "timeout" }, userId: PRIMARY_USER_ID });
    expect(getExtractionStatus(eventLog, message.id)).toBe("failed");

    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: message.id }, userId: PRIMARY_USER_ID });
    expect(getExtractionStatus(eventLog, message.id)).toBe("completed");
  });

  it("throws for an unknown event id rather than silently returning pending", () => {
    expect(() => getExtractionStatus(eventLog, "01NOPE0000000000000000000")).toThrow(/No such event/);
  });
});
