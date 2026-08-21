import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import { UpcasterRegistry } from "../upcasters/registry.js";
import { assertAttribute } from "../perception/attributes.js";
import { assertParentOf, assertSiblingOf, assertSpouseOf, closeSpouseOf, deriveSiblingsFromParents } from "../relationships/structuralAtoms.js";
import { closeBond, openBond } from "../relationships/socialBonds.js";
import type { ProjectionsDb } from "./db.js";

interface ExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion?: string;
  entities?: { name: string }[];
  structuralAtoms?: { type: "parent_of" | "spouse_of" | "sibling_of"; fromName: string; toName: string; action: "assert" | "close" }[];
  socialBonds?: {
    type: "friend" | "colleague" | "mentor_of" | "neighbor" | "classmate" | "romantic";
    fromName: string;
    toName: string;
    qualifier: string | null;
    basis: "inferred" | "stated";
    action: "open" | "close";
  }[];
  attributes?: { entityName: string; attribute: "birthdate" | "location" | "occupation"; value: string; eventDate: string | null }[];
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
  structuralAtomsApplied: number;
  socialBondsApplied: number;
  attributesApplied: number;
}

const UNKNOWN_EXTRACTOR_VERSION = "unknown";

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** The primary user's own entity id — stable per user, not written as an `entities` row (that table is for *other* mentioned people). */
export function primaryEntityId(userId: string): string {
  return `primary:${userId}`;
}

/**
 * The rebuild command (EN-054 v1.5): drop all projections and replay the
 * log, consuming recorded `extraction_completed` payloads. No extraction
 * runs here and no provider is ever called — this reads what the log
 * already recorded, which is what makes rebuild free, deterministic, and
 * exactly verifiable (EN-057). Re-running extraction over content is
 * reprocess's job (a distinct, deliberate, versioned, paid operation, not
 * built this phase) — rebuild and reprocess must never be blurred.
 *
 * Entities, structural atoms, social bonds, and attributes are all built
 * in this ONE pass sharing ONE name-to-entity-id map: entity ids are
 * ephemeral and regenerated every rebuild (EN-055), so an atom or bond
 * referencing an entity id could only stay consistent with the entities
 * table if both are assigned ids from the same map in the same run. A
 * separate rebuild pass for relationships, resolving names independently,
 * would silently produce dangling or duplicate entity ids the moment the
 * two passes' id choices diverged.
 *
 * Still deliberately NOT entity resolution (EN-012, Phase 3 Part 2):
 * names are deduped globally per user by exact normalized text. "me" is
 * the reserved name for the primary user's own (unwritten, stable) entity
 * id — see primaryEntityId. Corrections and confirmations still bind to
 * the extraction_completed event ULID they target, never to a projection
 * entity id, and — a known scope boundary this phase — only affect the
 * `entities` projection; a correction to an entity's name does not
 * retroactively repoint structural atoms/bonds/attributes that named it
 * before the correction.
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
  // extraction runs (EN-054 v1.5). Registers every name mentioned anywhere
  // (entities array, or only as a party to a relationship/attribute) so
  // every name that needs an entity id gets exactly one, consistently.
  let extractionsConsumed = 0;
  for (const extractionEvent of extractionCompletedBySourceId.values()) {
    extractionsConsumed++;
    const payload = extractionEvent.payload;
    const extractorVersion = payload.extractorVersion ?? UNKNOWN_EXTRACTOR_VERSION;
    const provenance = [payload.sourceEventId, extractionEvent.id];

    for (const entity of payload.entities ?? []) {
      upsert(entity.name, provenance, false, extractorVersion);
    }
    for (const atom of payload.structuralAtoms ?? []) {
      if (normalize(atom.fromName) !== "me") upsert(atom.fromName, provenance, false, extractorVersion);
      if (normalize(atom.toName) !== "me") upsert(atom.toName, provenance, false, extractorVersion);
    }
    for (const bond of payload.socialBonds ?? []) {
      if (normalize(bond.fromName) !== "me") upsert(bond.fromName, provenance, false, extractorVersion);
      if (normalize(bond.toName) !== "me") upsert(bond.toName, provenance, false, extractorVersion);
    }
    for (const attr of payload.attributes ?? []) {
      if (normalize(attr.entityName) !== "me") upsert(attr.entityName, provenance, false, extractorVersion);
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

  // Assign final entity ids and write the entities table. This is the ONE
  // point where names become ids — everything after this resolves through
  // entityIdByName, so atoms/bonds/attributes stay consistent with it.
  const entityIdByName = new Map<string, string>();
  let entitiesWritten = 0;
  for (const [key, acc] of byNormalizedName) {
    const id = newId();
    entityIdByName.set(key, id);
    projections.insertEntity({
      id,
      user_id: userId,
      name: acc.name,
      confirmed: acc.confirmed ? 1 : 0,
      source_event_ids: JSON.stringify([...acc.sourceEventIds].sort()),
      extractor_version: acc.extractorVersion,
      created_at: new Date().toISOString()
    });
    entitiesWritten++;
  }

  function resolveEntityId(name: string): string {
    const key = normalize(name);
    if (key === "me") return primaryEntityId(userId);
    return entityIdByName.get(key)!; // registered in pass 1 for every name mentioned anywhere
  }

  // Pass 4: structural atoms (EN-013 Class A) and social bonds (Class B),
  // resolved through the same name map. Atom ids created here are tracked
  // so a later "close" mention (matching the same normalized pair) can
  // find and close the atom/bond opened by an earlier mention.
  let structuralAtomsApplied = 0;
  let socialBondsApplied = 0;
  for (const extractionEvent of extractionCompletedBySourceId.values()) {
    const payload = extractionEvent.payload;
    const provenance = [payload.sourceEventId, extractionEvent.id];

    for (const atom of payload.structuralAtoms ?? []) {
      const fromId = resolveEntityId(atom.fromName);
      const toId = resolveEntityId(atom.toName);
      if (atom.type === "parent_of") {
        assertParentOf(projections, userId, fromId, toId, provenance);
      } else if (atom.type === "spouse_of") {
        if (atom.action === "assert") {
          assertSpouseOf(projections, userId, fromId, toId, provenance);
        } else {
          const existing = projections
            .listStructuralAtoms(userId, "spouse_of")
            .find((a) => (a.from_entity_id === fromId && a.to_entity_id === toId) || (a.from_entity_id === toId && a.to_entity_id === fromId));
          if (existing) closeSpouseOf(projections, existing.id, extractionEvent.recordedAt, extractionEvent.id);
        }
      } else {
        assertSiblingOf(projections, userId, fromId, toId, provenance);
      }
      structuralAtomsApplied++;
    }

    for (const bond of payload.socialBonds ?? []) {
      const fromId = resolveEntityId(bond.fromName);
      const toId = resolveEntityId(bond.toName);
      if (bond.action === "open") {
        openBond(projections, userId, {
          type: bond.type,
          fromEntityId: fromId,
          toEntityId: toId,
          qualifier: bond.qualifier,
          openedBasis: bond.basis,
          sourceEventIds: provenance
        });
      } else {
        const existing = projections
          .listSocialBonds(userId)
          .find(
            (b) =>
              b.type === bond.type &&
              b.interval_end === null &&
              ((b.from_entity_id === fromId && b.to_entity_id === toId) || (b.from_entity_id === toId && b.to_entity_id === fromId))
          );
        if (existing) closeBond(projections, existing.id, extractionEvent.recordedAt, extractionEvent.id);
      }
      socialBondsApplied++;
    }
  }
  deriveSiblingsFromParents(projections, userId);

  // Pass 5: third-party attribute persistence (EN-015) with dual-time
  // perception logs (EN-016). told_at is the message's own recorded_at —
  // when the user actually said it — never whenever rebuild happens to run.
  let attributesApplied = 0;
  for (const extractionEvent of extractionCompletedBySourceId.values()) {
    const payload = extractionEvent.payload;
    for (const attr of payload.attributes ?? []) {
      const entityId = resolveEntityId(attr.entityName);
      const row = assertAttribute(projections, userId, entityId, attr.attribute, attr.value, [payload.sourceEventId, extractionEvent.id]);
      projections.insertPerceptionLog({
        id: newId(),
        user_id: userId,
        fact_type: "entity_attribute",
        fact_ref: row.id,
        told_at: extractionEvent.recordedAt,
        event_at: attr.eventDate,
        source_event_ids: row.source_event_ids,
        raw_value: attr.value,
        created_at: new Date().toISOString()
      });
      attributesApplied++;
    }
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
    confirmationsApplied,
    structuralAtomsApplied,
    socialBondsApplied,
    attributesApplied
  };
}
