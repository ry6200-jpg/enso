import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import { UpcasterRegistry } from "../upcasters/registry.js";
import { assertAttribute, ATTRIBUTE_MUTABILITY } from "../perception/attributes.js";
import { computeEclipsedEventIds } from "../attachments/uploadDeletion.js";
import {
  findFuzzyNameMatch,
  findUnambiguousPartialNameMatch,
  hasConflictingStructuralAtom,
  normalizeForMatching,
  type NameCandidate
} from "../entities/resolutionCascade.js";
import { assertParentOf, assertSiblingOf, assertSpouseOf, closeSpouseOf, deriveSiblingsFromParents } from "../relationships/structuralAtoms.js";
import { closeBond, openBond } from "../relationships/socialBonds.js";
import type { ProjectionsDb } from "./db.js";
import type { AttributeType } from "./attributeVocabulary.js";
import { clusterEpisodeMarkers, type EpisodeMarkerEvent, type EpisodeMarkerKind } from "./episodes.js";

interface ExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion?: string;
  entities?: { name: string }[];
  structuralAtoms?: { type: "parent_of" | "spouse_of" | "sibling_of"; fromName: string; toName: string; action: "assert" | "close"; explicitlyNewPerson?: boolean }[];
  socialBonds?: {
    type: "friend" | "colleague" | "mentor_of" | "neighbor" | "classmate" | "romantic";
    fromName: string;
    toName: string;
    qualifier: string | null;
    basis: "inferred" | "stated";
    action: "open" | "close";
    explicitlyNewPerson?: boolean;
  }[];
  attributes?: { entityName: string; attribute: AttributeType; value: string; eventDate: string | null; action?: "open" | "close" }[];
  episodeMarkers?: { kind: EpisodeMarkerKind; text: string }[];
}
interface ExtractionFailedPayload {
  sourceEventId: string;
  reason: string;
}
interface FactCorrectedPayload {
  targetEventId: string; // the extraction_completed event ULID being corrected (EN-055)
  entityName: string;
  /** Entity-NAME correction (original use). Exactly one of correctedName / (attribute + correctedValue) is ever present on a real fact_corrected event — never both, see rebuild's processing below. */
  correctedName?: string;
  /** Attribute-VALUE correction (item 4 #2, new) — see src/conversation/correction.ts's resolveCorrection for how this gets produced. */
  attribute?: AttributeType;
  correctedValue?: string;
}
interface FactConfirmedPayload {
  targetEventId: string; // the extraction_completed event ULID being confirmed
  entityName: string;
  /**
   * Phase 6 (EN-066): which specific value the attestation gate resolved
   * this confirmation to, when it came from that gate rather than a
   * bare entity-identity confirmation. Optional and not yet consumed by
   * rebuild's projection logic below (which only ever needed
   * targetEventId + entityName to resolve entities.confirmed) — carried
   * for round-trip completeness and for the eventual attribute-level
   * deletion-provenance work (EN-065/066), not built this phase.
   */
  attribute?: AttributeType;
  value?: string;
}

export interface RebuildResult {
  entitiesWritten: number;
  /** extraction_completed events actually read and folded into the projection. */
  extractionsConsumed: number;
  messagesCurrentlyFailed: number;
  correctionsApplied: number;
  /** Item 4 #2: fact_corrected events that replaced an entity_attributes VALUE, distinct from correctionsApplied (entity-NAME corrections). */
  attributeCorrectionsApplied: number;
  confirmationsApplied: number;
  structuralAtomsApplied: number;
  socialBondsApplied: number;
  attributesApplied: number;
  /** Entities created via the lowest-confidence fuzzy/phonetic path or a same-counterparty kinship conflict — flagged, never auto-merged (EN-012). */
  pendingDisambiguations: number;
  /** EN-037 Phase 8.5: episodes clustered from episodeMarkers this rebuild — see projections/episodes.ts's clusterEpisodeMarkers. */
  episodesBuilt: number;
}

const UNKNOWN_EXTRACTOR_VERSION = "unknown";

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function wordCount(name: string): number {
  return name.trim().split(/\s+/).filter(Boolean).length;
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
 * reprocess's job (not built this phase) — rebuild and reprocess must
 * never be blurred.
 *
 * Entity resolution (EN-012) is ported from old Enso's cascade as a
 * specification (see src/entities/resolutionCascade.ts): exact alias,
 * punctuation-normalized alias, unambiguous word-prefix, then — only if
 * nothing else matched — a fuzzy/phonetic match, which never auto-merges
 * (it creates a new entity flagged `pending_disambiguation` instead).
 * Structural-atom mentions additionally get a same-counterparty kinship
 * conflict check: a name match toward a counterparty who already has a
 * DIFFERENT structural-atom type on file is rejected as likely a
 * different person sharing a name, not merged.
 *
 * Processes extraction_completed events in log order, sharing all
 * resolution state (aliases, entities, atoms so far) across the whole
 * replay — this is what makes same-message double-resolution protection
 * automatic: every mention within one event's payload (entities, atoms,
 * bonds, attributes) that names the same person resolves through the same
 * per-event mention cache, keyed by (event id, normalized name), so it
 * can only ever create one entity for one mention, however many places in
 * that event's payload repeat the name — mirroring the EntityResolutionCache
 * fix old Enso needed, but here it falls out of processing one event's
 * full payload as a unit rather than needing an explicit cache object
 * threaded through separate independent calls.
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

  // EN-065 core mechanism: an extraction_completed event derived from a
  // now-deleted upload is treated as if it doesn't exist for the rest of
  // this rebuild — no separate sweep-and-delete pass, since this function
  // already re-derives every projection row from zero on every call
  // (projections.clearProjections() above). A fact whose sole provenance
  // was such an event simply never gets recreated; one with provenance
  // elsewhere too still exists via that other event. See
  // src/attachments/uploadDeletion.ts for the shared eclipsed-set logic
  // (the SAME function the deletion-impact preview uses) and its explicit
  // note on the EN-066 attestation exception this does NOT yet implement.
  const eclipsedEventIds = computeEclipsedEventIds(events);

  const lastOutcomeBySourceId = new Map<string, "completed" | "failed">();
  for (const event of events) {
    if (event.type === "extraction_completed") {
      lastOutcomeBySourceId.set((event.payload as ExtractionCompletedPayload).sourceEventId, "completed");
    }
    if (event.type === "extraction_failed") {
      lastOutcomeBySourceId.set((event.payload as ExtractionFailedPayload).sourceEventId, "failed");
    }
  }

  // In-memory indexes mirroring what's already been written to the DB this
  // rebuild, so resolution doesn't need to round-trip SQL for every lookup.
  const aliasExactIndex = new Map<string, string>(); // lowercased alias -> entity id
  const aliasNormalizedIndex = new Map<string, string>(); // punctuation-normalized alias -> entity id
  // `${extractionEventId}|${normalizedName}` -> resolved entity id. This IS
  // the same-message double-resolution protection (EN-012): every mention
  // of a name within one event's payload hits this cache after the first.
  const mentionResolution = new Map<string, string>();

  let pendingDisambiguations = 0;

  function registerAlias(entityId: string, rawAlias: string, sourceEventIds: string[]): void {
    const lower = normalize(rawAlias);
    if (!aliasExactIndex.has(lower)) aliasExactIndex.set(lower, entityId);
    const norm = normalizeForMatching(rawAlias);
    if (norm && !aliasNormalizedIndex.has(norm)) aliasNormalizedIndex.set(norm, entityId);
    projections.insertEntityAlias({
      id: newId(),
      user_id: userId,
      entity_id: entityId,
      alias: rawAlias.trim(),
      source_event_ids: JSON.stringify([...sourceEventIds].sort()),
      created_at: new Date().toISOString()
    });
  }

  function createEntity(name: string, extractorVersion: string, sourceEventIds: string[]): string {
    const id = newId();
    projections.insertEntity({
      id,
      user_id: userId,
      name: name.trim(),
      confirmed: 0,
      source_event_ids: JSON.stringify([...sourceEventIds].sort()),
      extractor_version: extractorVersion,
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    registerAlias(id, name, sourceEventIds);
    return id;
  }

  function candidateList(): NameCandidate[] {
    return projections.listEntities(userId).map((e) => ({ id: e.id, name: e.name }));
  }

  /** A plain lookup (alias/normalized-alias only — no fuzzy, no creation) used to find a counterparty's CURRENT entity id, if any. */
  function plainLookup(name: string): string | undefined {
    const lower = normalize(name);
    if (lower === "me") return primaryEntityId(userId);
    return aliasExactIndex.get(lower) ?? aliasNormalizedIndex.get(normalizeForMatching(name));
  }

  function structuralAtomTypesToward(entityId: string, counterpartyId: string): string[] {
    return projections
      .listStructuralAtoms(userId)
      .filter((a) => (a.from_entity_id === entityId && a.to_entity_id === counterpartyId) || (a.from_entity_id === counterpartyId && a.to_entity_id === entityId))
      .map((a) => a.type);
  }

  function resolveName(
    rawName: string,
    eventId: string,
    extractorVersion: string,
    sourceEventIds: string[],
    context?: { structuralAtomType?: string; counterpartyEntityId?: string; explicitlyNewPerson?: boolean }
  ): string {
    const trimmed = rawName.trim();
    const lower = normalize(trimmed);
    if (lower === "me") return primaryEntityId(userId);

    const cacheKey = `${eventId}|${lower}`;
    const cached = mentionResolution.get(cacheKey);
    if (cached) return cached;

    let candidateId = aliasExactIndex.get(lower);
    let viaNormalized = false;
    let viaPartial: NameCandidate | undefined;

    if (!candidateId) {
      candidateId = aliasNormalizedIndex.get(normalizeForMatching(trimmed));
      viaNormalized = !!candidateId;
    }
    if (!candidateId) {
      viaPartial = findUnambiguousPartialNameMatch(trimmed, candidateList());
      candidateId = viaPartial?.id;
    }

    if (candidateId) {
      // Explicit different-person signal (EN-012, ported from old Enso)
      // overrides an otherwise-accepted match on ANY mention type — the
      // text itself said this is a different person sharing a name, which
      // is a stronger, more general signal than any structural check.
      // Lower confidence than the kinship conflict below (this is a name
      // that COULD be the same person, just explicitly flagged as
      // probably not), so it's flagged for a future clarifying question
      // rather than silently split.
      if (context?.explicitlyNewPerson) {
        const created = createEntity(trimmed, extractorVersion, sourceEventIds);
        projections.setPendingDisambiguation(created, JSON.stringify({ candidateName: trimmed, existingEntityId: candidateId, reason: "explicitly_new_person" }));
        pendingDisambiguations++;
        mentionResolution.set(cacheKey, created);
        return created;
      }
      // Counterparty-scoped kinship conflict check (EN-012), structural
      // atoms only — bonds accrete and have no such conflict concept. High
      // confidence (a real person can't be both your parent and your
      // sibling), so this silently splits with no disambiguation flag —
      // same as old Enso's "conflict" case, no user interruption needed.
      if (context?.counterpartyEntityId && context.structuralAtomType) {
        const existingTypes = structuralAtomTypesToward(candidateId, context.counterpartyEntityId);
        if (hasConflictingStructuralAtom(existingTypes, context.structuralAtomType)) {
          const created = createEntity(trimmed, extractorVersion, sourceEventIds);
          mentionResolution.set(cacheKey, created);
          return created;
        }
      }
      if (viaNormalized) registerAlias(candidateId, trimmed, sourceEventIds);
      if (viaPartial && wordCount(trimmed) > wordCount(viaPartial.name)) {
        projections.updateEntityName(candidateId, trimmed);
      }
      if (viaPartial) registerAlias(candidateId, trimmed, sourceEventIds);
      projections.touchEntity(candidateId, sourceEventIds, extractorVersion);
      mentionResolution.set(cacheKey, candidateId);
      return candidateId;
    }

    // Lowest-confidence path: a fuzzy/phonetic near-miss. Never auto-merges
    // — creates a new entity flagged for a future clarifying question
    // (surfacing that question is chat/persona work, not built this phase).
    const fuzzy = findFuzzyNameMatch(trimmed, candidateList());
    const created = createEntity(trimmed, extractorVersion, sourceEventIds);
    if (fuzzy) {
      projections.setPendingDisambiguation(
        created,
        JSON.stringify({ candidateName: trimmed, existingEntityId: fuzzy.id, newStructuralAtomType: context?.structuralAtomType ?? null })
      );
      pendingDisambiguations++;
    }
    mentionResolution.set(cacheKey, created);
    return created;
  }

  let extractionsConsumed = 0;
  let structuralAtomsApplied = 0;
  let socialBondsApplied = 0;

  for (const event of events) {
    if (event.type !== "extraction_completed") continue;
    if (eclipsedEventIds.has(event.id)) continue; // EN-065: derived from a deleted upload — treated as if it never happened
    extractionsConsumed++;
    const payload = event.payload as ExtractionCompletedPayload;
    const extractorVersion = payload.extractorVersion ?? UNKNOWN_EXTRACTOR_VERSION;
    const provenance = [payload.sourceEventId, event.id];

    // Structural atoms and bonds carry richer context (a kinship type +
    // counterparty, or an explicit different-person signal) than the bare
    // `entities` list — they must resolve FIRST so the per-event mention
    // cache is populated with the context-aware result. Processing
    // `entities` first would resolve the name with no context at all,
    // caching a match that a same-message atom/bond mention then couldn't
    // override even if it carried a conflict signal, since the cache would
    // short-circuit before the conflict check ever ran. Caught by a test
    // (tests/rebuildEntityResolution.test.ts) that planted exactly this
    // shape: a "Sarah" mentioned as both a sibling and (separately) a
    // parent within the entities array before the structural atoms were
    // processed.
    for (const atom of payload.structuralAtoms ?? []) {
      const isAssert = atom.action === "assert";
      const roughToId = plainLookup(atom.toName);
      const fromId = resolveName(atom.fromName, event.id, extractorVersion, provenance, {
        explicitlyNewPerson: atom.explicitlyNewPerson,
        ...(isAssert ? { structuralAtomType: atom.type, counterpartyEntityId: roughToId } : {})
      });
      const toId = resolveName(atom.toName, event.id, extractorVersion, provenance, {
        explicitlyNewPerson: atom.explicitlyNewPerson,
        ...(isAssert ? { structuralAtomType: atom.type, counterpartyEntityId: fromId } : {})
      });

      if (atom.type === "parent_of") {
        assertParentOf(projections, userId, fromId, toId, provenance);
      } else if (atom.type === "spouse_of") {
        if (isAssert) {
          assertSpouseOf(projections, userId, fromId, toId, provenance);
        } else {
          const existing = projections
            .listStructuralAtoms(userId, "spouse_of")
            .find((a) => (a.from_entity_id === fromId && a.to_entity_id === toId) || (a.from_entity_id === toId && a.to_entity_id === fromId));
          if (existing) closeSpouseOf(projections, existing.id, event.recordedAt, event.id);
        }
      } else {
        assertSiblingOf(projections, userId, fromId, toId, provenance);
      }
      structuralAtomsApplied++;
    }

    for (const bond of payload.socialBonds ?? []) {
      const fromId = resolveName(bond.fromName, event.id, extractorVersion, provenance, { explicitlyNewPerson: bond.explicitlyNewPerson });
      const toId = resolveName(bond.toName, event.id, extractorVersion, provenance, { explicitlyNewPerson: bond.explicitlyNewPerson });
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
          .find((b) => b.type === bond.type && b.interval_end === null && ((b.from_entity_id === fromId && b.to_entity_id === toId) || (b.from_entity_id === toId && b.to_entity_id === fromId)));
        if (existing) closeBond(projections, existing.id, event.recordedAt, event.id);
      }
      socialBondsApplied++;
    }

    // Processed LAST (see comment above the structuralAtoms loop): a name
    // already resolved above via richer context reuses that result from
    // the per-event cache; a name that ONLY appears in the bare entities
    // list resolves here with no context, same as before.
    for (const entity of payload.entities ?? []) {
      resolveName(entity.name, event.id, extractorVersion, provenance);
    }
  }
  deriveSiblingsFromParents(projections, userId);

  // Attributes are a separate pass so a name that first appears here
  // (rather than in entities/structuralAtoms/socialBonds within the same
  // event) still resolves consistently via the same per-event cache.
  let attributesApplied = 0;
  for (const event of events) {
    if (event.type !== "extraction_completed") continue;
    if (eclipsedEventIds.has(event.id)) continue; // EN-065: same exclusion as above, kept consistent across both passes
    const payload = event.payload as ExtractionCompletedPayload;
    const extractorVersion = payload.extractorVersion ?? UNKNOWN_EXTRACTOR_VERSION;
    for (const attr of payload.attributes ?? []) {
      const entityId = resolveName(attr.entityName, event.id, extractorVersion, [payload.sourceEventId, event.id]);
      // Absent action = "open": every extraction cached before Phase 2
      // (message-v3 and earlier) has no action field at all, and resolves
      // exactly as it always did — an unconditional "open" default is what
      // makes that backward-compatible, not merely convenient.
      const action = attr.action ?? "open";

      // Phase 2 temporal markers, CLOSE branch — mutable attributes only
      // (birthdate has no closed state; ATTRIBUTE_MUTABILITY gates it out
      // here exactly as it already does in resolveAttribute). Two real
      // shapes, same "close" instruction: (1) the value being closed is
      // ALREADY on record as open — "I finally moved out of Toledo last
      // month" after Toledo was the current location — close that EXISTING
      // row, mirroring closeBond/closeStructuralAtom's own established
      // find-the-open-one-and-close-it pattern; (2) the more common
      // historical-aside shape — "I grew up in Toledo, moved away in
      // 1995" — where Toledo was never asserted as open at all, so there is
      // nothing to find; it falls through and gets inserted below, ALREADY
      // closed, so the real historical fact is still recorded (never
      // silently discarded) but can never win attribute currency.
      if (action === "close" && ATTRIBUTE_MUTABILITY[attr.attribute] === "mutable") {
        const existingOpen = projections
          .listEntityAttributeHistory(userId, entityId, attr.attribute)
          .find((r) => !r.interval_end && r.value === attr.value);
        if (existingOpen) {
          projections.closeEntityAttribute(existingOpen.id, event.recordedAt, event.id);
          attributesApplied++;
          continue; // the existing row's own perception log already covers it — no new row, no new log
        }
      }

      const row = assertAttribute(projections, userId, entityId, attr.attribute, attr.value, [payload.sourceEventId, event.id], undefined, {
        intervalStart: attr.eventDate,
        // Told-time (event.recordedAt), never a parsed historical date —
        // same precedent closeBond/closeStructuralAtom already establish
        // for interval_end (see EntityAttributeRow's own doc comment).
        intervalEnd: action === "close" ? event.recordedAt : null
      });
      if (!row) continue; // rejected at write time (assertAttribute already logged loudly) — nothing to record a perception-log entry against
      projections.insertPerceptionLog({
        id: newId(),
        user_id: userId,
        fact_type: "entity_attribute",
        fact_ref: row.id,
        told_at: event.recordedAt,
        event_at: attr.eventDate,
        source_event_ids: row.source_event_ids,
        raw_value: attr.value,
        created_at: new Date().toISOString()
      });
      attributesApplied++;
    }
  }

  // EN-037 Phase 8.5: episode clustering, built on the existing
  // episodeMarkers taxonomy rather than a new extraction category (owner
  // decision — see spec's EN-037 entry and src/projections/episodes.ts's
  // own header comment for the full reasoning). Run AFTER the
  // entities/structuralAtoms/socialBonds pass and the attributes pass
  // above, so mentionResolution already holds every entity this rebuild is
  // ever going to resolve for these events — participant entity ids are
  // derived from that cache, never re-resolved independently, so an
  // episode's participants always agree with what the rest of the
  // projection already knows about who was mentioned in the same message.
  const participantEntityIdsByEventId = new Map<string, Set<string>>();
  for (const [key, entityId] of mentionResolution) {
    const eventId = key.slice(0, key.indexOf("|"));
    if (!participantEntityIdsByEventId.has(eventId)) participantEntityIdsByEventId.set(eventId, new Set());
    participantEntityIdsByEventId.get(eventId)!.add(entityId);
  }

  const markerEvents: EpisodeMarkerEvent[] = [];
  for (const event of events) {
    if (event.type !== "extraction_completed") continue;
    if (eclipsedEventIds.has(event.id)) continue; // EN-065: same exclusion as every other pass
    const payload = event.payload as ExtractionCompletedPayload;
    const participantEntityIds = [...(participantEntityIdsByEventId.get(event.id) ?? [])];
    for (const marker of payload.episodeMarkers ?? []) {
      markerEvents.push({
        extractionEventId: event.id,
        sourceEventId: payload.sourceEventId,
        toldAt: event.recordedAt,
        kind: marker.kind,
        text: marker.text,
        participantEntityIds
      });
    }
  }

  const episodeRows = clusterEpisodeMarkers(markerEvents);
  for (const row of episodeRows) {
    projections.insertEpisode({ id: newId(), user_id: userId, created_at: new Date().toISOString(), ...row });
  }

  /**
   * Ambient/register/zodiac batch, item 4 #2: a pre-existing bug found
   * (not introduced) while wiring attribute-value corrections through
   * this exact lookup — resolveName's own "me" special case (above:
   * `if (lower === "me") return primaryEntityId(userId);`) returns
   * immediately WITHOUT ever populating mentionResolution, since the
   * primary user's own entity id needs no cache-and-search machinery at
   * all. That means a bare `mentionResolution.get(...)` lookup for
   * entityName "me" always misses — silently breaking correction/
   * confirmation of the OWNER's OWN facts specifically, exactly the case
   * this item's birthdate fix is about. Fixed once, here, shared by all
   * three fact_corrected/fact_confirmed lookups below (name correction,
   * attribute correction, confirmation) rather than three separate places
   * inconsistently reimplementing the "me" special case.
   */
  function resolveCorrectionTargetEntity(targetEventId: string, entityName: string): string | undefined {
    if (normalize(entityName.trim()) === "me") return primaryEntityId(userId);
    return mentionResolution.get(`${targetEventId}|${normalize(entityName)}`);
  }

  // Corrections take precedence over extraction output (EN-055), binding
  // to the extraction_completed event ULID + the original mention name —
  // mentionResolution already maps exactly that pair to the entity it
  // resolved to, so no search is needed.
  let correctionsApplied = 0;
  // Item 4 #2: a SECOND kind of fact_corrected, alongside the original
  // entity-name one above — an attribute-VALUE correction. Same
  // targetEventId+entityName binding, then: delete the specific,
  // now-superseded entity_attributes row (found by matching BOTH the
  // attribute type and the targetEventId inside that row's own
  // source_event_ids — a single extraction_completed event can carry
  // several different attributes for the same entity, so matching on
  // targetEventId alone isn't precise enough), then write the corrected
  // value through assertAttribute exactly like a fresh assertion —
  // item 5's write-time validation applies here too, a correction to an
  // implausible value is rejected the same as any other write. This is
  // what makes resolveAttribute treat the correction as authoritative
  // for an immutable attribute: the wrong row is genuinely gone from
  // this rebuild's projection, not merely outranked by "oldest valid
  // wins" the way an ordinary new assertion would be.
  let attributeCorrectionsApplied = 0;
  for (const event of events) {
    if (event.type !== "fact_corrected") continue;
    const payload = event.payload as FactCorrectedPayload;
    const entityId = resolveCorrectionTargetEntity(payload.targetEventId, payload.entityName);
    if (!entityId) continue; // nothing to correct — the target produced no entity under that name

    if (payload.correctedName !== undefined) {
      projections.updateEntityName(entityId, payload.correctedName);
      registerAlias(entityId, payload.correctedName, [event.id]);
      projections.touchEntity(entityId, [event.id], projections.getEntityById(entityId)!.extractor_version);
      correctionsApplied++;
      continue;
    }

    if (payload.attribute !== undefined && payload.correctedValue !== undefined) {
      // Require the target row to actually exist FIRST — resolveName's
      // "me" special case (see resolveCorrectionTargetEntity above) means
      // entityId always resolves for "me" regardless of what targetEventId
      // actually produced, unlike third-party entities where a missing
      // mentionResolution entry already enforces this. Checking for the
      // real row explicitly, here, keeps that same "must bind to a real
      // prior claim" discipline for "me" too — this is not a new
      // assertion wearing a correction's clothing; a correction with
      // nothing real to correct is a no-op, not a fresh claim.
      const existing = projections
        .listEntityAttributeHistory(userId, entityId, payload.attribute)
        .find((r) => (JSON.parse(r.source_event_ids) as string[]).includes(payload.targetEventId));
      if (!existing) continue;

      // Validate-then-delete, deliberately in this order, never the
      // reverse: if the corrected value itself fails write-time
      // validation (item 5) it must never be written, and the OLD row
      // must survive that rejection untouched — deleting first would
      // leave NEITHER the old nor the new value on record for a rejected
      // correction, a strictly worse outcome than doing nothing.
      const row = assertAttribute(projections, userId, entityId, payload.attribute, payload.correctedValue, [event.id, payload.targetEventId]);
      if (!row) continue; // rejected at write time (assertAttribute already logged loudly) — old row left exactly as it was
      projections.deleteEntityAttribute(existing.id);
      attributeCorrectionsApplied++;
    }
  }

  let confirmationsApplied = 0;
  for (const event of events) {
    if (event.type !== "fact_confirmed") continue;
    const payload = event.payload as FactConfirmedPayload;
    const entityId = resolveCorrectionTargetEntity(payload.targetEventId, payload.entityName);
    if (!entityId) continue;
    projections.setEntityConfirmed(entityId);
    projections.touchEntity(entityId, [event.id], projections.getEntityById(entityId)!.extractor_version);
    confirmationsApplied++;
  }

  let messagesCurrentlyFailed = 0;
  for (const outcome of lastOutcomeBySourceId.values()) {
    if (outcome === "failed") messagesCurrentlyFailed++;
  }

  return {
    entitiesWritten: projections.listEntities(userId).length,
    extractionsConsumed,
    messagesCurrentlyFailed,
    correctionsApplied,
    attributeCorrectionsApplied,
    confirmationsApplied,
    structuralAtomsApplied,
    socialBondsApplied,
    attributesApplied,
    pendingDisambiguations,
    episodesBuilt: episodeRows.length
  };
}
