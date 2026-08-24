import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { MessageSentPayload } from "../capture/messageCapture.js";
import type { FileUploadedPayload } from "../attachments/attachmentCapture.js";

export type ExportFormat = "txt" | "json";

/**
 * A single message_sent/reply_sent event, ready for export. Deliberately
 * the RAW EventRecord (id, recordedAt, occurredAt, type, actor, payload,
 * schemaVersion, userId) with one addition — `attachmentFilename`, resolved
 * via the same explicit attachmentEventId link conversationHistory.ts's
 * getConversationHistory already uses (never positional, never "whatever
 * file_uploaded event happens to sit nearby in the log"). Keeping the
 * payload intact rather than flattening it is deliberate: the JSON export
 * format is for archival, so it should hold what was actually recorded,
 * not a lossy projection of it.
 */
export interface ExportEvent extends EventRecord {
  type: "message_sent" | "reply_sent";
  attachmentFilename?: string;
}

/**
 * Every message_sent/reply_sent event for a user, in log order
 * (EventLog.listForUser already sorts by id ASC — ULIDs are lexicographic
 * by time, so no separate sort is needed here). No session window, no
 * truncation — this is the transcript export's whole point, unlike
 * getConversationHistory's caller, which only ever wants the current
 * session. Same DB access pattern as getConversationHistory (listForUser +
 * an explicit getById join for attachments) — deliberately not a new one.
 */
export function getExportEvents(eventLog: EventLog, userId: string): ExportEvent[] {
  return eventLog
    .listForUser(userId)
    .filter((e): e is EventRecord & { type: "message_sent" | "reply_sent" } => e.type === "message_sent" || e.type === "reply_sent")
    .map((e) => {
      if (e.type !== "message_sent") return e as ExportEvent;
      const attachmentEventId = (e.payload as MessageSentPayload).attachmentEventId;
      if (!attachmentEventId) return e as ExportEvent;
      const uploadEvent = eventLog.getById(attachmentEventId);
      if (!uploadEvent || uploadEvent.type !== "file_uploaded") return e as ExportEvent;
      return { ...e, attachmentFilename: (uploadEvent.payload as FileUploadedPayload).filename } as ExportEvent;
    });
}

function roleLabel(type: ExportEvent["type"]): "You" | "Enso" {
  return type === "message_sent" ? "You" : "Enso";
}

/** One turn, one block: a timestamp/role header line (with the attachment filename inline, when present), then the text. */
export function formatExportEventAsText(event: ExportEvent): string {
  const text = (event.payload as { text: string }).text;
  const attachmentSuffix = event.attachmentFilename ? ` [attachment: ${event.attachmentFilename}]` : "";
  return `[${event.recordedAt}] ${roleLabel(event.type)}${attachmentSuffix}\n${text}\n\n`;
}

/**
 * Yields one formatted block at a time rather than building the whole
 * transcript as a single string up front — the caller (the export route)
 * turns this into a ReadableStream so the response body is written
 * incrementally instead of buffered whole in memory before the first byte
 * goes out. (The underlying event array itself is already fully in memory
 * by this point — better-sqlite3's API is synchronous and has no streaming
 * read cursor in this codebase — this is what streaming can honestly mean
 * here: the potentially much larger FORMATTED output is never buffered as
 * one string.)
 */
export function* streamTranscriptTxt(events: ExportEvent[]): Generator<string> {
  for (const event of events) yield formatExportEventAsText(event);
}

/** Same incremental-output rationale as streamTranscriptTxt, producing a single well-formed JSON array without ever holding its serialized text as one string. */
export function* streamTranscriptJson(events: ExportEvent[]): Generator<string> {
  yield "[\n";
  for (let i = 0; i < events.length; i++) {
    yield (i > 0 ? ",\n" : "") + JSON.stringify(events[i]);
  }
  yield "\n]\n";
}
