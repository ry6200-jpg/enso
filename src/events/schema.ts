/**
 * The ten resolved event types (Section 12, Q1 of enso-rebuild-requirements.md).
 * This list is exhaustive by design — new types require the user's explicit
 * decision, never an ad-hoc addition here.
 */
export const EVENT_TYPES = [
  // Authoritative — user acts
  "message_sent",
  "file_uploaded",
  "upload_deleted",
  "fact_corrected",
  "fact_confirmed",
  "user_annotation",
  // Authoritative — Enso acts
  "reply_sent",
  // Supersedable — pipeline outputs
  "extraction_completed",
  "extraction_failed",
  "external_lookup_performed"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ACTORS = ["user", "enso", "system"] as const;
export type Actor = (typeof ACTORS)[number];

/** The current schema_version each event type is written and expected at. */
export const CURRENT_SCHEMA_VERSION: Record<EventType, number> = {
  message_sent: 1,
  file_uploaded: 1,
  upload_deleted: 1,
  fact_corrected: 1,
  fact_confirmed: 1,
  user_annotation: 1,
  reply_sent: 1,
  extraction_completed: 1,
  extraction_failed: 1,
  external_lookup_performed: 1
};

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function isActor(value: string): value is Actor {
  return (ACTORS as readonly string[]).includes(value);
}

export interface EventRecord {
  id: string;
  recordedAt: string;
  occurredAt: string | null;
  type: EventType;
  actor: Actor;
  payload: unknown;
  schemaVersion: number;
  userId: string;
}

/** Fields the caller supplies when appending; id/recordedAt are assigned by the log. */
export interface NewEventInput {
  occurredAt?: string | null;
  type: string;
  actor: string;
  payload: unknown;
  schemaVersion?: number;
  userId: string;
}
