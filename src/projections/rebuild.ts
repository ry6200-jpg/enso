import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import { STUB_EXTRACTOR_VERSION, stubExtract } from "../extraction/stubExtractor.js";
import type { ExtractionStructure } from "../extraction/types.js";
import { UpcasterRegistry } from "../upcasters/registry.js";
import type { ProjectionsDb } from "./db.js";

interface MessageSentPayload {
  text: string;
}
interface ExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion: string;
  modelId: string;
  entities: { name: string }[];
  relationships: unknown[];
  dates: string[];
}
interface ExtractionFailedPayload {
  sourceEventId: string;
  reason: string;
}
interface FactCorrectedPayload {
  targetEventId: string; // the extraction_completed event ULID being corrected (EN-055)
  entityName: string;
  correctedName: string;
}
interface FactConfirmedPayload {
  targetEventId: string; // the extraction_completed event ULID being confirmed
  entityName: string;
}

interface EntityAccumulator {
  name: string;
  confirmed: boolean;
  sourceEventIds: Set<string>;
}

export interface RebuildResult {
  entitiesWritten: number;
  extractionsRun: number;
  messagesSkippedAsFailed: number;
  correctionsApplied: number;
  confirmationsApplied: number;
}

/**
 * The rebuild command (EN-054): drop all projections, replay the log,
 * regenerate. This is the one real projection for Phase 1 — a minimal
 * `entities` fold — built purely to exercise the machinery: provenance
 * (EN-053), extractor_version, and correction precedence (EN-055).
 *
 * Deliberately NOT entity resolution (EN-012, a later phase): entities are
 * deduped globally per user by exact normalized name. Corrections and
 * confirmations bind to the extraction_completed event ULID they target,
 * never to a projection entity id — entity ids are regenerated every
 * rebuild and would break exactly the recovery path EN-055 exists to
 * protect.
 */
export function rebuildProjections(
  rawEvents: EventRecord[],
  projections: ProjectionsDb,
  userId: string,
  extract: (text: string) => ExtractionStructure = stubExtract,
  extractorVersion: string = STUB_EXTRACTOR_VERSION,
  upcasters: UpcasterRegistry = new UpcasterRegistry()
): RebuildResult {
  projections.clearProjections();

  // Every event passes through the upcaster chain before replay sees it
  // (EN-058). Today every real event type is at schema_version 1 with no
  // migrations registered, so this is a no-op passthrough — but it's
  // genuinely wired in, not just available to call.
  const events = rawEvents.map((event) => upcasters.apply(event));

  const messages = events.filter(
    (e): e is EventRecord & { payload: MessageSentPayload } => e.type === "message_sent"
  );
  const extractionCompletedBySourceId = new Map<string, EventRecord & { payload: ExtractionCompletedPayload }>();
  const failedMessageIds = new Set<string>();

  for (const event of events) {
    if (event.type === "extraction_completed") {
      const payload = event.payload as ExtractionCompletedPayload;
      extractionCompletedBySourceId.set(payload.sourceEventId, event as EventRecord & { payload: ExtractionCompletedPayload });
    }
    if (event.type === "extraction_failed") {
      failedMessageIds.add((event.payload as ExtractionFailedPayload).sourceEventId);
    }
  }

  const byNormalizedName = new Map<string, EntityAccumulator>();
  let extractionsRun = 0;

  function normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  function upsert(name: string, sourceEventIds: string[], confirmed: boolean): void {
    const key = normalize(name);
    let acc = byNormalizedName.get(key);
    if (!acc) {
      acc = { name, confirmed: false, sourceEventIds: new Set() };
      byNormalizedName.set(key, acc);
    }
    for (const id of sourceEventIds) acc.sourceEventIds.add(id);
    if (confirmed) acc.confirmed = true;
  }

  // A single extraction_completed event can produce several entities (e.g.
  // "Sarah and Amy" in one message), so the event ULID alone doesn't pick
  // out one of them — the original name it was extracted under is also
  // needed to disambiguate which mention a correction/confirmation targets.
  function findBucketByEventAndName(eventId: string, originalName: string): [string, EntityAccumulator] | undefined {
    const wanted = normalize(originalName);
    for (const [key, acc] of byNormalizedName) {
      if (acc.sourceEventIds.has(eventId) && normalize(acc.name) === wanted) return [key, acc];
    }
    return undefined;
  }

  // Pass 1: run (or re-run) extraction over every message with a completed
  // extraction. Re-running rather than trusting the stored payload is what
  // makes the extraction cache (EN-056) meaningful during replay (EN-055:
  // "applied after extraction during replay").
  for (const message of messages) {
    const extractionEvent = extractionCompletedBySourceId.get(message.id);
    if (!extractionEvent) continue; // no completed extraction yet (failed or pending) — no entities from it
    const structure = extract(message.payload.text);
    extractionsRun++;
    for (const entity of structure.entities) {
      upsert(entity.name, [message.id, extractionEvent.id], false);
    }
  }

  // Pass 2: corrections take precedence over extraction output (EN-055).
  let correctionsApplied = 0;
  for (const event of events) {
    if (event.type !== "fact_corrected") continue;
    const payload = event.payload as FactCorrectedPayload;
    const found = findBucketByEventAndName(payload.targetEventId, payload.entityName);
    if (!found) continue; // nothing to correct — the target produced no entity
    const [oldKey, acc] = found;
    byNormalizedName.delete(oldKey);
    acc.sourceEventIds.add(event.id);
    upsert(payload.correctedName, [...acc.sourceEventIds], acc.confirmed);
    correctionsApplied++;
  }

  // Pass 3: confirmations mark an entity as user-attested.
  let confirmationsApplied = 0;
  for (const event of events) {
    if (event.type !== "fact_confirmed") continue;
    const payload = event.payload as FactConfirmedPayload;
    const found = findBucketByEventAndName(payload.targetEventId, payload.entityName);
    if (!found) continue;
    const [, acc] = found;
    acc.confirmed = true;
    acc.sourceEventIds.add(event.id);
    confirmationsApplied++;
  }

  let entitiesWritten = 0;
  for (const acc of byNormalizedName.values()) {
    projections.insertEntity({
      id: newId(),
      user_id: userId,
      name: acc.name,
      confirmed: acc.confirmed ? 1 : 0,
      source_event_ids: JSON.stringify([...acc.sourceEventIds].sort()),
      extractor_version: extractorVersion,
      created_at: new Date().toISOString()
    });
    entitiesWritten++;
  }

  return {
    entitiesWritten,
    extractionsRun,
    messagesSkippedAsFailed: failedMessageIds.size,
    correctionsApplied,
    confirmationsApplied
  };
}
