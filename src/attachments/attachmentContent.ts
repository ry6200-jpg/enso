import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../providers/attachmentTypes.js";

/**
 * EN-063 bounded exposure: the "opening portion" a future chat turn would
 * see, computed from the (always fully stored, EN-062) complete text. Full
 * text is never discarded — this is a marked, explicit slice alongside it,
 * not a replacement for it. Chosen as a build-time default; FTS chunking
 * (Section 12 Q4) supersedes this for retrieval once Phase 4 exists.
 */
export const BOUNDED_EXCERPT_CHARS = 2000;

export const ATTACHMENT_EXTRACTOR_VERSION = "attachment-v1";

export interface DocumentExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion: string;
  provider: "openai" | "gemini";
  model: string;
  kind: "document";
  fullText: string;
  boundedExcerpt: string;
  truncated: boolean;
  entities: { name: string; type: "person" }[];
}

export interface ImageExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion: string;
  provider: "openai" | "gemini";
  model: string;
  kind: "image";
  description: string;
}

function boundedExcerptOf(fullText: string): { boundedExcerpt: string; truncated: boolean } {
  const truncated = fullText.length > BOUNDED_EXCERPT_CHARS;
  return {
    boundedExcerpt: truncated ? fullText.slice(0, BOUNDED_EXCERPT_CHARS) : fullText,
    truncated
  };
}

/**
 * Runs document content extraction (full text + entities, EN-062) and
 * records it as `extraction_completed`, bound to the upload event's ULID
 * (provenance, EN-053). This is the single-attempt version — retry with
 * backoff and the personal-vs-document classifier (EN-059/060) wrap this in
 * Part 4; this function only implements EN-081/083's provider fallback
 * (already handled inside the router passed in).
 */
export async function extractDocumentContent(
  eventLog: EventLog,
  documentRouter: { extract: DocumentContentAdapter },
  uploadEvent: EventRecord,
  input: { bytes: Buffer; mimeType: string; filename: string }
): Promise<EventRecord> {
  const result = await documentRouter.extract(input);
  const { boundedExcerpt, truncated } = boundedExcerptOf(result.fullText);

  const payload: DocumentExtractionCompletedPayload = {
    sourceEventId: uploadEvent.id,
    extractorVersion: ATTACHMENT_EXTRACTOR_VERSION,
    provider: result.provider,
    model: result.model,
    kind: "document",
    fullText: result.fullText,
    boundedExcerpt,
    truncated,
    entities: result.entities
  };

  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload,
    userId: uploadEvent.userId
  });
}

/**
 * Runs image description extraction (EN-062) and records it the same way.
 * No entity taxonomy for images in Phase 2 — the spec asks for descriptions
 * only; entity extraction on image content is not requested here.
 */
export async function extractImageContent(
  eventLog: EventLog,
  imageRouter: { extract: ImageContentAdapter },
  uploadEvent: EventRecord,
  input: { bytes: Buffer; mimeType: string }
): Promise<EventRecord> {
  const result = await imageRouter.extract(input);

  const payload: ImageExtractionCompletedPayload = {
    sourceEventId: uploadEvent.id,
    extractorVersion: ATTACHMENT_EXTRACTOR_VERSION,
    provider: result.provider,
    model: result.model,
    kind: "image",
    description: result.description
  };

  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload,
    userId: uploadEvent.userId
  });
}
