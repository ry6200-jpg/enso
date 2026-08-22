import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { getConversationHistory } from "../src/conversation/conversationHistory.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

describe("getConversationHistory (item 9: conversation appeared to vanish on refresh)", () => {
  it("returns an empty array for a genuinely fresh user — never data loss, this is what a real fresh session looks like", () => {
    expect(getConversationHistory(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("returns user and enso turns in chronological order, exactly as they were said", () => {
    const m1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Richard", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const r1 = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "Nice to meet you, Richard." }, userId: PRIMARY_USER_ID });
    const m2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "work has been busy", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    expect(getConversationHistory(eventLog, PRIMARY_USER_ID)).toEqual([
      { id: m1.id, role: "user", text: "Richard" },
      { id: r1.id, role: "enso", text: "Nice to meet you, Richard." },
      { id: m2.id, role: "user", text: "work has been busy" }
    ]);
  });

  it("excludes non-conversational events (uploads, extractions) from the visible transcript", () => {
    eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "x.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: "x", extractorVersion: "v1", kind: "document" }, userId: PRIMARY_USER_ID });

    expect(getConversationHistory(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("scopes strictly to the given user — never leaks another user's turns", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "someone else's message", attachmentOnly: false }, userId: "someone-else" });
    expect(getConversationHistory(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });
});
