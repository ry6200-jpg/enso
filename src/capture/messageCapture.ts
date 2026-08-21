import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";

/**
 * Attachment-only messages carry this placeholder text, never empty content
 * (R1/EN-064): an empty user message crashes provider chat APIs, and this
 * was a real production bug in Mirror.
 */
export const ATTACHMENT_ONLY_PLACEHOLDER = "[attachment]";

export interface CaptureMessageInput {
  userId: string;
  text?: string;
  /** How many files were attached to this same turn, if any. */
  attachmentCount?: number;
  /** When this actually happened, if different from now (EN-016 dual time) — e.g. backdating an imported note. Defaults to unset (occurred_at null; told-time is recorded_at). */
  occurredAt?: string;
}

export interface MessageSentPayload {
  text: string;
  attachmentOnly: boolean;
}

/**
 * The message ingest path (EN-010): appends `message_sent` and returns as
 * soon as that single INSERT has committed — nothing else runs inside this
 * function. Extraction is a deliberately separate call the orchestrator
 * makes afterward (Part 4/EN-059), so a failed or slow extraction call can
 * never race with, block, or roll back the fact that the user's message was
 * saved. This is what "saved before any AI call is attempted" means
 * structurally, not just by convention: there is no code path here that
 * reaches the network.
 */
export function captureMessage(eventLog: EventLog, input: CaptureMessageInput): EventRecord {
  const hasText = typeof input.text === "string" && input.text.trim() !== "";
  const hasAttachments = (input.attachmentCount ?? 0) > 0;

  if (!hasText && !hasAttachments) {
    throw new Error(
      "Refusing to capture a message with no text and no attachments — this is a caller bug, " +
        "not a case the attachment-only placeholder (R1) is meant to paper over."
    );
  }

  const payload: MessageSentPayload = {
    text: hasText ? input.text!.trim() : ATTACHMENT_ONLY_PLACEHOLDER,
    attachmentOnly: !hasText && hasAttachments
  };

  return eventLog.append({
    type: "message_sent",
    actor: "user",
    payload,
    occurredAt: input.occurredAt,
    userId: input.userId
  });
}
