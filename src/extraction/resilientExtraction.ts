import type { BlobStore } from "../blobs/blobStore.js";
import type { FileUploadedPayload } from "../attachments/attachmentCapture.js";
import { BOUNDED_EXCERPT_CHARS, type DocumentExtractionCompletedPayload, type ImageExtractionCompletedPayload } from "../attachments/attachmentContent.js";
import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { DocumentContentAdapter, ImageContentAdapter } from "../providers/attachmentTypes.js";
import type { ExtractionRouter } from "../providers/router.js";
import type { AttributeMention, ExtractedEntity, EpisodeMarker, SocialBondMention, StatedFeeling, StructuralAtomMention } from "../providers/types.js";
import { classifyPersonalVsDocument, type ClassifierDecision } from "./personalDocumentClassifier.js";
import { DEFAULT_RETRY_CONFIG, retryWithBackoff, type RetryConfig } from "./retry.js";

export const MESSAGE_EXTRACTOR_VERSION = "message-v1";
export const ATTACHMENT_EXTRACTOR_VERSION = "attachment-v1";

export interface MessageExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion: string;
  kind: "message";
  provider: "openai" | "gemini" | null;
  model: string | null;
  entities: ExtractedEntity[];
  statedFeelings: StatedFeeling[];
  episodeMarkers: EpisodeMarker[];
  structuralAtoms: StructuralAtomMention[];
  socialBonds: SocialBondMention[];
  attributes: AttributeMention[];
  classifierDecision: ClassifierDecision;
  /**
   * Round-trip survival (CLAUDE.md): the known-people list injected into
   * this extraction call (EN-012's known-people context) directly shaped
   * its output ("mom" resolving to "Elena" or not) — recorded here so this
   * observation is self-describing for a future reprocess diff, instead of
   * depending on reconstructing what the projection looked like at call time.
   */
  knownPeopleNames: string[];
}

export interface ExtractionFailedPayload {
  sourceEventId: string;
  kind: "message" | "document" | "image";
  reason: string;
  attempts: number;
}

function appendExtractionFailed(
  eventLog: EventLog,
  sourceEvent: EventRecord,
  kind: "message" | "document" | "image",
  err: unknown,
  attempts: number
): EventRecord {
  const payload: ExtractionFailedPayload = {
    sourceEventId: sourceEvent.id,
    kind,
    reason: err instanceof Error ? err.message : String(err),
    attempts
  };
  return eventLog.append({ type: "extraction_failed", actor: "system", payload, userId: sourceEvent.userId });
}

/**
 * Resilient message extraction (EN-059/060). The classifier runs first,
 * locally, before any network call — for a message (unlike an upload, where
 * we don't have text until the model gives it back to us) we always have
 * the text already, so a non-personal classification skips the LLM call
 * entirely rather than just discarding its output afterward.
 */
export async function extractMessageWithResilience(
  eventLog: EventLog,
  router: ExtractionRouter,
  messageEvent: EventRecord,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  knownPeopleNames: string[] = []
): Promise<EventRecord> {
  const text = (messageEvent.payload as { text: string }).text;
  const classifierDecision = classifyPersonalVsDocument(text);

  if (!classifierDecision.isPersonal) {
    const payload: MessageExtractionCompletedPayload = {
      sourceEventId: messageEvent.id,
      extractorVersion: MESSAGE_EXTRACTOR_VERSION,
      kind: "message",
      provider: null,
      model: null,
      entities: [],
      statedFeelings: [],
      episodeMarkers: [],
      structuralAtoms: [],
      socialBonds: [],
      attributes: [],
      classifierDecision,
      knownPeopleNames
    };
    return eventLog.append({ type: "extraction_completed", actor: "system", payload, userId: messageEvent.userId });
  }

  try {
    const referenceDate = messageEvent.recordedAt.slice(0, 10);
    const result = await retryWithBackoff(() => router.extract({ kind: "message", text, referenceDate, knownPeopleNames }), retryConfig);
    const payload: MessageExtractionCompletedPayload = {
      sourceEventId: messageEvent.id,
      extractorVersion: MESSAGE_EXTRACTOR_VERSION,
      kind: "message",
      provider: result.provider,
      model: result.model,
      entities: result.taxonomy.entities,
      statedFeelings: result.taxonomy.statedFeelings,
      episodeMarkers: result.taxonomy.episodeMarkers,
      structuralAtoms: result.taxonomy.structuralAtoms,
      socialBonds: result.taxonomy.socialBonds,
      attributes: result.taxonomy.attributes,
      classifierDecision,
      knownPeopleNames
    };
    return eventLog.append({ type: "extraction_completed", actor: "system", payload, userId: messageEvent.userId });
  } catch (err) {
    return appendExtractionFailed(eventLog, messageEvent, "message", err, retryConfig.maxAttempts);
  }
}

function boundedExcerptOf(fullText: string): { boundedExcerpt: string; truncated: boolean } {
  const truncated = fullText.length > BOUNDED_EXCERPT_CHARS;
  return { boundedExcerpt: truncated ? fullText.slice(0, BOUNDED_EXCERPT_CHARS) : fullText, truncated };
}

/**
 * Resilient document extraction. Unlike messages, we don't have text to
 * classify until the model transcribes it — so the classifier runs *after*
 * a successful call, against the returned fullText, and its only effect is
 * whether the already-computed entities are kept or dropped (EN-060: it
 * governs entity extraction only). fullText itself is always kept and
 * stored regardless (EN-061/062) — the classifier cannot make an upload's
 * content disappear.
 */
export async function extractDocumentWithResilience(
  eventLog: EventLog,
  documentRouter: { extract: DocumentContentAdapter },
  uploadEvent: EventRecord,
  input: { bytes: Buffer; mimeType: string; filename: string },
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<EventRecord> {
  try {
    const result = await retryWithBackoff(() => documentRouter.extract(input), retryConfig);
    const classifierDecision = classifyPersonalVsDocument(result.fullText);
    const { boundedExcerpt, truncated } = boundedExcerptOf(result.fullText);

    const payload: DocumentExtractionCompletedPayload & { classifierDecision: ClassifierDecision } = {
      sourceEventId: uploadEvent.id,
      extractorVersion: ATTACHMENT_EXTRACTOR_VERSION,
      provider: result.provider,
      model: result.model,
      kind: "document",
      fullText: result.fullText,
      boundedExcerpt,
      truncated,
      entities: classifierDecision.isPersonal ? result.entities : [],
      classifierDecision
    };
    return eventLog.append({ type: "extraction_completed", actor: "system", payload, userId: uploadEvent.userId });
  } catch (err) {
    return appendExtractionFailed(eventLog, uploadEvent, "document", err, retryConfig.maxAttempts);
  }
}

/** Resilient image description. No entity taxonomy on images (Part 3 scope decision), so no classifier gating is meaningful here — it always runs to completion or fails. */
export async function extractImageWithResilience(
  eventLog: EventLog,
  imageRouter: { extract: ImageContentAdapter },
  uploadEvent: EventRecord,
  input: { bytes: Buffer; mimeType: string },
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<EventRecord> {
  try {
    const result = await retryWithBackoff(() => imageRouter.extract(input), retryConfig);
    const payload: ImageExtractionCompletedPayload = {
      sourceEventId: uploadEvent.id,
      extractorVersion: ATTACHMENT_EXTRACTOR_VERSION,
      provider: result.provider,
      model: result.model,
      kind: "image",
      description: result.description
    };
    return eventLog.append({ type: "extraction_completed", actor: "system", payload, userId: uploadEvent.userId });
  } catch (err) {
    return appendExtractionFailed(eventLog, uploadEvent, "image", err, retryConfig.maxAttempts);
  }
}

export interface RetryDependencies {
  eventLog: EventLog;
  blobStore: BlobStore;
  messageRouter: ExtractionRouter;
  documentRouter: { extract: DocumentContentAdapter };
  imageRouter: { extract: ImageContentAdapter };
  retryConfig?: RetryConfig;
}

/**
 * The retry entry point for a failed extraction (EN-059) — callable now,
 * even though the automatic recovery path (the reflection loop re-invoking
 * this on a schedule) is Phase 8. Re-reads the original source event
 * (and, for uploads, the original bytes from the blob store) and re-runs
 * the same resilient extraction that failed the first time.
 */
export async function retryFailedExtraction(deps: RetryDependencies, failedEvent: EventRecord): Promise<EventRecord> {
  if (failedEvent.type !== "extraction_failed") {
    throw new Error(`retryFailedExtraction expects an extraction_failed event, got ${failedEvent.type}`);
  }
  const payload = failedEvent.payload as ExtractionFailedPayload;
  const sourceEvent = deps.eventLog.getById(payload.sourceEventId);
  if (!sourceEvent) {
    throw new Error(`Source event ${payload.sourceEventId} not found — cannot retry`);
  }

  if (payload.kind === "message") {
    return extractMessageWithResilience(deps.eventLog, deps.messageRouter, sourceEvent, deps.retryConfig);
  }

  const uploadPayload = sourceEvent.payload as FileUploadedPayload;
  const bytes = deps.blobStore.get(uploadPayload.path);

  if (payload.kind === "document") {
    return extractDocumentWithResilience(
      deps.eventLog,
      deps.documentRouter,
      sourceEvent,
      { bytes, mimeType: uploadPayload.mimeType, filename: uploadPayload.filename },
      deps.retryConfig
    );
  }
  return extractImageWithResilience(deps.eventLog, deps.imageRouter, sourceEvent, { bytes, mimeType: uploadPayload.mimeType }, deps.retryConfig);
}
