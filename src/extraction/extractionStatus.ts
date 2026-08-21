import type { EventLog } from "../events/eventLog.js";

export type ExtractionStatus = "pending" | "completed" | "failed";

/**
 * Per-message (or per-upload) extraction status, queryable (EN-059).
 * "Latest wins": if an extraction failed and was later retried to success,
 * the completed event recorded after it makes the status "completed" again
 * — status reflects current truth, not history.
 */
export function getExtractionStatus(eventLog: EventLog, sourceEventId: string): ExtractionStatus {
  const sourceEvent = eventLog.getById(sourceEventId);
  if (!sourceEvent) {
    throw new Error(`No such event: ${sourceEventId}`);
  }

  const related = eventLog
    .listForUser(sourceEvent.userId)
    .filter(
      (e) =>
        (e.type === "extraction_completed" || e.type === "extraction_failed") &&
        (e.payload as { sourceEventId?: string }).sourceEventId === sourceEventId
    );

  if (related.length === 0) return "pending";
  const latest = related[related.length - 1]!; // listForUser is in log (ULID) order
  return latest.type === "extraction_completed" ? "completed" : "failed";
}
