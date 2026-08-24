import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { getExportEvents, streamTranscriptJson, streamTranscriptTxt, type ExportEvent } from "../src/export/transcriptExport.js";
import { ATTACHMENT_ONLY_PLACEHOLDER } from "../src/capture/messageCapture.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let dbPath: string;
let eventLog: EventLog;

beforeEach(() => {
  dbPath = freshTestDbPath(import.meta.url, "events");
  eventLog = new EventLog(dbPath);
});

function collect(gen: Generator<string>): string {
  let out = "";
  for (const chunk of gen) out += chunk;
  return out;
}

describe("getExportEvents (production bug batch, item 5: full transcript export)", () => {
  it("returns an empty array for a genuinely fresh user", () => {
    expect(getExportEvents(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("returns every message_sent/reply_sent event in log order, with no session-window truncation", () => {
    const m1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "turn one", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const r1 = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "reply one" }, userId: PRIMARY_USER_ID });
    const m2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "turn two", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const r2 = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "reply two" }, userId: PRIMARY_USER_ID });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(events.map((e) => e.id)).toEqual([m1.id, r1.id, m2.id, r2.id]);
  });

  it("excludes non-conversational events (uploads, extractions) from the exported transcript itself", () => {
    eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "x.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: "x", extractorVersion: "v1", kind: "document" }, userId: PRIMARY_USER_ID });
    expect(getExportEvents(eventLog, PRIMARY_USER_ID)).toEqual([]);
  });

  it("keeps the raw payload intact (archival, not a flattened projection) alongside recordedAt/occurredAt/schemaVersion", () => {
    const r = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "hi", provider: "openai", model: "gpt-5.6-sol" }, userId: PRIMARY_USER_ID });
    const [event] = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(event).toMatchObject({
      id: r.id,
      recordedAt: r.recordedAt,
      occurredAt: r.occurredAt,
      type: "reply_sent",
      actor: "enso",
      schemaVersion: r.schemaVersion,
      payload: { text: "hi", provider: "openai", model: "gpt-5.6-sol" }
    });
  });

  it("joins a message's attachment filename via the explicit attachmentEventId link, not by adjacency in the log", () => {
    const targetUpload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "resume.pdf", mimeType: "application/pdf", byteLength: 1000, path: "ab/resume.pdf" },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "decoy.pdf", mimeType: "application/pdf", byteLength: 1000, path: "cd/decoy.pdf" },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "unrelated reply sitting in between" }, userId: PRIMARY_USER_ID });

    const msg = eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "here's my resume", attachmentOnly: false, attachmentEventId: targetUpload.id },
      userId: PRIMARY_USER_ID
    });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    const joined = events.find((e) => e.id === msg.id);
    expect(joined?.attachmentFilename).toBe("resume.pdf");
  });

  it("the file-with-no-text case: an attachment-only message (R1/EN-064's placeholder text) still resolves its filename", () => {
    const upload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "photo.jpg", mimeType: "image/jpeg", byteLength: 500, path: "ef/photo.jpg" },
      userId: PRIMARY_USER_ID
    });
    const msg = eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: ATTACHMENT_ONLY_PLACEHOLDER, attachmentOnly: true, attachmentEventId: upload.id },
      userId: PRIMARY_USER_ID
    });

    const [event] = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(event!.id).toBe(msg.id);
    expect(event!.attachmentFilename).toBe("photo.jpg");
    expect((event!.payload as { text: string }).text).toBe(ATTACHMENT_ONLY_PLACEHOLDER);

    // And it renders as a real block in the txt export, not a blank one.
    const text = collect(streamTranscriptTxt([event!]));
    expect(text).toContain("[attachment: photo.jpg]");
    expect(text).toContain(ATTACHMENT_ONLY_PLACEHOLDER);
  });

  it("a message with no attachmentEventId has no attachmentFilename", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "just text", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const [event] = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(event!.attachmentFilename).toBeUndefined();
  });

  it("a stale attachmentEventId pointing at nothing (or a non-upload event) resolves to no filename rather than throwing", () => {
    eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "orphaned reference", attachmentOnly: false, attachmentEventId: "01NONEXISTENT00000000000" },
      userId: PRIMARY_USER_ID
    });
    const [event] = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(event!.attachmentFilename).toBeUndefined();
  });

  it("scopes strictly to the given user — a request for another user's data never returns their rows", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "someone else's private message", attachmentOnly: false }, userId: "someone-else" });
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "mine", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    const mineOnly = getExportEvents(eventLog, PRIMARY_USER_ID);
    expect(mineOnly).toHaveLength(1);
    expect((mineOnly[0]!.payload as { text: string }).text).toBe("mine");

    const someoneElseOnly = getExportEvents(eventLog, "someone-else");
    expect(someoneElseOnly).toHaveLength(1);
    expect((someoneElseOnly[0]!.payload as { text: string }).text).toBe("someone else's private message");

    // Neither user's export ever contains so much as an id belonging to the other.
    expect(mineOnly.map((e) => e.id)).not.toEqual(expect.arrayContaining(someoneElseOnly.map((e) => e.id)));
  });

  it("ordering survives a real close/reopen — not an in-memory artifact of one still-open connection", () => {
    const m1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "first", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const r1 = eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "second" }, userId: PRIMARY_USER_ID });
    const m2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "third", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.close();

    // Fresh EventLog instance against the exact same file — simulates the
    // real request path, where a new checkout opens a brand-new connection
    // every time (src/storage/userSession.ts), never a long-lived one.
    const reopened = new EventLog(dbPath);
    const events = getExportEvents(reopened, PRIMARY_USER_ID);
    expect(events.map((e) => e.id)).toEqual([m1.id, r1.id, m2.id]);
    reopened.close();
  });
});

describe("streamTranscriptTxt (production bug batch, item 5)", () => {
  it("renders one block per turn: a [timestamp] Role header, then the text, blank line between blocks", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hello", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "hi there" }, userId: PRIMARY_USER_ID });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    const text = collect(streamTranscriptTxt(events));

    expect(text).toMatch(/^\[.+\] You\nhello\n\n\[.+\] Enso\nhi there\n\n$/);
  });

  it("yields incrementally, one chunk per turn, rather than one chunk for the whole transcript", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "a", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "b" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "c", attachmentOnly: false }, userId: PRIMARY_USER_ID });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    const chunks = [...streamTranscriptTxt(events)];
    expect(chunks).toHaveLength(3);
  });
});

describe("streamTranscriptJson (production bug batch, item 5)", () => {
  it("produces a single well-formed JSON array of the raw events, parseable end to end", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "hello", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "reply_sent", actor: "enso", payload: { text: "hi there", provider: "openai" }, userId: PRIMARY_USER_ID });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    const jsonText = collect(streamTranscriptJson(events));

    const parsed = JSON.parse(jsonText) as ExportEvent[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.type).toBe("message_sent");
    expect((parsed[0]!.payload as { text: string }).text).toBe("hello");
    expect(parsed[1]!.type).toBe("reply_sent");
    expect((parsed[1]!.payload as { text: string; provider: string }).provider).toBe("openai");
  });

  it("produces a valid empty array for a fresh user, not malformed output", () => {
    const jsonText = collect(streamTranscriptJson([]));
    expect(JSON.parse(jsonText)).toEqual([]);
  });

  it("includes attachmentFilename in the archived record when resolved", () => {
    const upload = eventLog.append({
      type: "file_uploaded",
      actor: "user",
      payload: { filename: "notes.txt", mimeType: "text/plain", byteLength: 10, path: "gh/notes.txt" },
      userId: PRIMARY_USER_ID
    });
    eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "see attached", attachmentOnly: false, attachmentEventId: upload.id },
      userId: PRIMARY_USER_ID
    });

    const events = getExportEvents(eventLog, PRIMARY_USER_ID);
    const parsed = JSON.parse(collect(streamTranscriptJson(events))) as ExportEvent[];
    expect(parsed[0]!.attachmentFilename).toBe("notes.txt");
  });
});
