import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import { UpcasterRegistry } from "../upcasters/registry.js";
import type { ProjectionsDb } from "./db.js";

interface ExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion?: string;
  entities?: { name: string }[];
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
  extractorVersion: string;
}

export interface RebuildResult {
  entitiesWritten: number;
  /** extraction_completed events actually read and folded into the projection. */
  extractionsConsumed: number;
  messagesCurrentlyFailed: number;
  correctionsApplied: number;
  confirmationsApplied: number;
}

const UNKNOWN_EXTRACTOR_VERSION = "unknown";

/**
 * The rebuild command (EN-054 v1.5): drop all projections and replay the
 * log, consuming recorded `extraction_completed` payloads. No extraction
 * runs here and no provider is ever called — this reads what the log
 * already recorded, which is what makes rebuild free, deterministic, and
 * exactly verifiable (EN-057). Re-running extraction over content is
 * reprocess's job (a distinct, deliberate, versioned, paid operation,
 * not built this phase) — rebuild and reprocess must never be blurred.
 *
 * Prior to v1.5 this function re-ran a (stub, free) extractor during
 * replay, which was reasonable only because that extractor cost nothing;
 * it could never have generalized to real LLM extraction without either
 * re-paying for every rebuild or reintroducing non-determinism into a
 * recovery tool. Phase 2's real capture pipeline already writes the fuller
 * payload shape this function now reads directly.
 *
 * Still deliberately NOT entity resolution (EN-012, Phase 3 Part 2):
 * entities are deduped globally per user by exact normalized name.
 * Corrections and confirmations bind to the extraction_completed event
 * ULID they target, never to a projection entity id — entity ids are
 * regenerated every rebuild and would break exactly the recovery path
 * EN-055 exists to protect.
 */
export function rebuildProjections(
  rawEvents: EventRecord[],
  projections: ProjectionsDb,
  userId: string,
  upcasters: UpcasterRegistry = new UpcasterRegistry()
): RebuildResult {
  projections.clearProjections();

  // Every event passes through the upcaster chain before replay sees it
  // (EN-058). Today every real event type is at schema_version 1 with no
  // migrations registered, so this is a no-op passthrough — but it's
  // genuinely wired in, not just available to call.
  const events = rawEvents.map((event) => upcasters.apply(event));

  const extractionCompletedBySourceId = new Map<string, EventRecord & { payload: ExtractionCompletedPayload }>();
  // Latest-event-wins per source: a message can fail then later succeed on
  // retry (EN-059), so "currently failed" means the most recent
  // extraction-related event for that source is extraction_failed, not
  // merely that a failure was ever recorded.
  const lastOutcomeBySourceId = new Map<string, "completed" | "failed">();

  for (const event of events) {
    if (event.type === "extraction_completed") {
      const payload = event.payload as ExtractionCompletedPayload;
      extractionCompletedBySourceId.set(payload.sourceEventId, event as EventRecord & { payload: ExtractionCompletedPayload });
      lastOutcomeBySourceId.set(payload.sourceEventId, "completed");
    }
    if (event.type === "extraction_failed") {
      const payload = event.payload as ExtractionFailedPayload;
      lastOutcomeBySourceId.set(payload.sourceEventId, "failed");
    }
  }

  const byNormalizedName = new Map<string, EntityAccumulator>();

  function normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  function upsert(name: string, sourceEventIds: string[], confirmed: boolean, extractorVersion: string): void {
    const key = normalize(name);
    let acc = byNormalizedName.get(key);
    if (!acc) {
      acc = { name, confirmed: false, sourceEventIds: new Set(), extractorVersion };
      byNormalizedName.set(key, acc);
    }
    for (const id of sourceEventIds) acc.sourceEventIds.add(id);
    if (confirmed) acc.confirmed = true;
    acc.extractorVersion = extractorVersion;
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

  // Pass 1: read every recorded extraction_completed payload directly — no
  // extraction runs (EN-054 v1.5).
  let extractionsConsumed = 0;
  for (const extractionEvent of extractionCompletedBySourceId.values()) {
    extractionsConsumed++;
    const extractorVersion = extractionEvent.payload.extractorVersion ?? UNKNOWN_EXTRACTOR_VERSION;
    for (const entity of extractionEvent.payload.entities ?? []) {
      upsert(entity.name, [extractionEvent.payload.sourceEventId, extractionEvent.id], false, extractorVersion);
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
    upsert(payload.correctedName, [...acc.sourceEventIds], acc.confirmed, acc.extractorVersion);
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
      extractor_version: acc.extractorVersion,
      created_at: new Date().toISOString()
    });
    entitiesWritten++;
  }

  let messagesCurrentlyFailed = 0;
  for (const outcome of lastOutcomeBySourceId.values()) {
    if (outcome === "failed") messagesCurrentlyFailed++;
  }

  return {
    entitiesWritten,
    extractionsConsumed,
    messagesCurrentlyFailed,
    correctionsApplied,
    confirmationsApplied
  };
}
