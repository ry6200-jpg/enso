import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import { UpcasterRegistry } from "../upcasters/registry.js";
import { assertAttribute, ATTRIBUTE_MUTABILITY, resolveEntityAttribute } from "../perception/attributes.js";
import { computeEclipsedEventIds } from "../attachments/uploadDeletion.js";
import { computeCoReferenceMerges } from "../relationships/coReferenceMerge.js";
import { findRetractionTarget, type RelationshipRetractionPayload } from "../relationships/relationshipRetraction.js";
import { resolveMentionDates } from "./mentionDates.js";
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
import { isAttributeType, type AttributeType, type GenderValue } from "./attributeVocabulary.js";
import { clusterEpisodeMarkers, type EpisodeMarkerEvent, type EpisodeMarkerKind } from "./episodes.js";

interface ExtractionCompletedPayload {
  sourceEventId: string;
  extractorVersion?: string;
  entities?: { name: string }[];
  structuralAtoms?: {
    type: "parent_of" | "spouse_of" | "sibling_of";
    fromName: string;
    toName: string;
    action: "assert" | "close";
    explicitlyNewPerson?: boolean;
    /** Absent on any payload cached before v5 (role-word placeholder fix) — treated as false ("not a role word"), preserving pre-fix behavior for old cached extractions until they're naturally re-extracted. */
    fromNameIsRoleWord?: boolean;
    toNameIsRoleWord?: boolean;
  }[];
  socialBonds?: {
    type: "friend" | "colleague" | "mentor_of" | "neighbor" | "classmate" | "romantic";
    fromName: string;
    toName: string;
    qualifier: string | null;
    basis: "inferred" | "stated";
    action: "open" | "close";
    explicitlyNewPerson?: boolean;
    fromNameIsRoleWord?: boolean;
    toNameIsRoleWord?: boolean;
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
  /** fact_corrected{kind:"relationshipRetraction"} events that actually closed a structural atom or social bond — never a coReferenceRetraction (that's folded in the pre-pass above, EN-101), never a target already closed or never found (idempotent no-op, not counted here). */
  relationshipRetractionsApplied: number;
  confirmationsApplied: number;
  structuralAtomsApplied: number;
  /** Bug fix 3 of 3: parent_of/spouse_of/sibling_of atoms rejected by assertParentOf/assertSpouseOf/assertSiblingOf's semantic validation (a cycle, a self-loop, or a cross-type conflict) — never written, logged loudly, never thrown. Visible here so a rejection is never silent to a caller, matching every other write-outcome counter on this struct. */
  structuralAtomsRejected: number;
  /**
   * Bug fix 3 of 3, change 2: plain observability, not a bound — the
   * highest number of open parent_of atoms held toward any single child,
   * across every entity in this rebuild. Nothing rejects a third (or
   * further) parent; this exists so a caller can SEE when the count is
   * unusual (3+, most often a genuine step/adoptive family shape, but
   * also the shape an extraction error would produce) without the code
   * ever guessing which case it is. 0 when there are no parent_of atoms
   * at all.
   */
  maxOpenParentsForAnyChild: number;
  socialBondsApplied: number;
  attributesApplied: number;
  /**
   * A historical extraction_completed event asserted an attribute type no
   * longer in ATTRIBUTE_TYPES (e.g. sexual_orientation, deprecated — see
   * the deprecation batch) — never written, never crashes the rebuild.
   * Visible here so a deprecated-vocabulary replay gap is never silent to
   * a caller, matching every other write-outcome counter on this struct.
   * 0 whenever nothing in the event log predates a vocabulary narrowing.
   */
  deprecatedAttributesSkipped: number;
  /** Entities created via the lowest-confidence fuzzy/phonetic path or a same-counterparty kinship conflict — flagged, never auto-merged (EN-012). */
  pendingDisambiguations: number;
  /** Unnamed entities (role_word OR an exact NO_REAL_NAME_WORDS match) whose last message mention was 30+ days before referenceDate — purged this rebuild, along with every atom/bond/attribute/alias that referenced them. 0 whenever nothing qualifies (the overwhelmingly common case). */
  entitiesPurged: number;
  /** EN-037 Phase 8.5: episodes clustered from episodeMarkers this rebuild — see projections/episodes.ts's clusterEpisodeMarkers. */
  episodesBuilt: number;
}

const UNKNOWN_EXTRACTOR_VERSION = "unknown";

/**
 * Role-word gender derivation (role-word disambiguation batch). English
 * only, deliberately hardcoded and deliberately incomplete — a gap here
 * means "no gender derived," never a wrong guess. Gender-neutral kinship
 * words (partner, cousin, sibling, parent, spouse, child, guardian, ex)
 * are deliberately absent — see the schema-decision investigation this
 * batch's build prompt references for why inferring gender from a
 * genuinely neutral word would be actively wrong, not just uninformative.
 * Keyed by the SAME normalized lowercase form `resolveRoleWordName` already
 * computes (`lower`), so a lookup here never needs its own normalization.
 */
const ROLE_WORD_GENDER: Record<string, GenderValue> = {
  father: "male",
  dad: "male",
  papa: "male",
  husband: "male",
  brother: "male",
  uncle: "male",
  son: "male",
  grandfather: "male",
  grandpa: "male",
  nephew: "male",
  boyfriend: "male",
  mother: "female",
  mom: "female",
  mama: "female",
  wife: "female",
  sister: "female",
  aunt: "female",
  daughter: "female",
  grandmother: "female",
  grandma: "female",
  niece: "female",
  girlfriend: "female"
};

/**
 * The subset of ROLE_WORD_GENDER that also maps onto a specific GATED_TYPES
 * relation (parent_of/spouse_of) — role-word disambiguation (Task 3) only
 * makes structural sense for these: "father"/"mother"-family words always
 * mean "look at the owner's parent_of atoms" (owner is the CHILD side);
 * "husband"/"wife" always mean "look at the owner's spouse_of atoms"
 * (symmetric — owner can be either side). Words outside this subset
 * (brother, uncle, son, ...) still get a derived gender written (the
 * broader map above), they just never drive disambiguation — sibling_of/
 * socialBonds have no "owner's counterparty" concept parent_of/spouse_of
 * disambiguation relies on here.
 */
const ROLE_WORD_RELATION: Record<string, "parent_of" | "spouse_of"> = {
  father: "parent_of",
  dad: "parent_of",
  papa: "parent_of",
  mother: "parent_of",
  mom: "parent_of",
  mama: "parent_of",
  husband: "spouse_of",
  wife: "spouse_of"
};

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The unnamed-entity purge's second test (approved, see the design
 * report): `name_kind === "role_word"` alone misses any mention the
 * extractor failed to flag as one — confirmed on the real corpus, not
 * hypothesized: "husband", "mother", and "she" all sit with `name_kind`
 * null today, literal role words/pronouns extraction never flagged.
 * Matched via `normalize()` against the entity's FULL name, EXACT match
 * only — never a substring or partial match. A real person named "May"
 * or "Sister Mary" must not qualify just because a role word appears
 * inside their actual name.
 *
 * UNLIKE ROLE_WORD_GENDER/ROLE_WORD_RELATION above, a miss here is not
 * symmetric with a false positive: ROLE_WORD_GENDER missing a word only
 * means no gender gets inferred — annoying, never destructive. This list
 * DECIDES WHAT GETS DELETED (rebuild.ts's purge pass, below) — a false
 * positive here is real, permanent data loss, not a missed convenience.
 * Keep this list conservative: when in doubt, leave a word OUT rather
 * than risk purging someone's actual name.
 */
const NO_REAL_NAME_WORDS = new Set([
  // ROLE_WORD_GENDER's own vocabulary, unchanged.
  "father", "dad", "papa", "husband", "brother", "uncle", "son", "grandfather", "grandpa", "nephew", "boyfriend",
  "mother", "mom", "mama", "wife", "sister", "aunt", "daughter", "grandmother", "grandma", "niece", "girlfriend",
  // Personal pronouns.
  "he", "she", "they", "him", "her", "them",
  // Generic/plural relationship words — confirmed in real use on the
  // production corpus ("parents", "coworkers", "friends", "sisters",
  // "former spouse" all exist as real entities today).
  "parent", "parents", "spouse", "former spouse", "sibling", "siblings", "child", "children",
  "friend", "friends", "colleague", "colleagues", "coworker", "coworkers",
  "neighbor", "neighbors", "classmate", "classmates", "mentor",
  "sisters", "brothers", "cousins"
]);

function hasNoRealName(entityName: string, nameKind: "role_word" | null | undefined): boolean {
  return nameKind === "role_word" || NO_REAL_NAME_WORDS.has(normalize(entityName));
}

/**
 * Purge exemption: an entity that has ever picked up a genuine alternate
 * name — most often via a coReference merge with aliasSuppressed: false —
 * is never purged, regardless of what its own `name`/`name_kind` field
 * currently reads as. Checked against the SAME word list and SAME exact
 * full-string match hasNoRealName uses for the entity's own name, and
 * deliberately so: confirmed on the real corpus that `registerAlias`
 * unconditionally self-aliases every entity created via the ordinary
 * (non-role-word) path, including the exact extraction-fault entities
 * this purge exists to catch ("husband" aliased as "husband", "she"
 * aliased as "she") — an alias that's ITSELF a role word is that
 * self-registration artifact, never evidence a real name was learned,
 * and must not count toward this exemption. Only an alias that is NOT a
 * role word — a genuine name variant — exempts.
 */
function hasNonRoleWordAlias(aliases: { alias: string }[]): boolean {
  return aliases.some((a) => !NO_REAL_NAME_WORDS.has(normalize(a.alias)));
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
  upcasters: UpcasterRegistry = new UpcasterRegistry(),
  // EN-057: rebuilds are deterministic, so rebuild verification is strict
  // — two rebuilds of the same log must match exactly, and any difference
  // is a bug. An explicit parameter, not a read of the system clock
  // inside this function, is what keeps that true once ANY part of this
  // fold becomes time-sensitive (the not-yet-built purge pass): a rebuild
  // stays a pure function of (events, referenceDate), so the same pair of
  // inputs always produces the same output regardless of when it's
  // actually run. Defaults to "now" so every existing caller that has no
  // reason to care keeps behaving exactly as before this parameter
  // existed — see CLAUDE.md/the design report for the explicit list of
  // callers updated to pass this deliberately.
  referenceDate: Date = new Date()
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

  // Co-reference merge fold (EN-101/Bug fix 2 of 2): a second pre-pass,
  // parallel to eclipsedEventIds above and following the exact same
  // precedent — read the WHOLE log up front so a confirmation can affect
  // how mentions resolve regardless of where in the log it falls, never a
  // row-moving/backfill step after the fact. See coReferenceMerge.ts.
  const coReferenceMerges = computeCoReferenceMerges(events);
  // pairingKey (placeholderStableKey) -> the canonical entity id actually
  // created for it THIS replay. Populated the first time EITHER side of a
  // confirmed pairing is reached in the main loop below; consulted on the
  // second. Never persisted — recomputed fresh every rebuild, same as
  // every other in-memory index here.
  const canonicalIdByCoReferencePairing = new Map<string, string>();

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

  /**
   * Co-reference merge fold, the shared creation-point check (Bug fix 2 of
   * 2): called from BOTH resolveName and resolveRoleWordName, before
   * either does anything else. If the CURRENT event's id is one of the two
   * stable keys a confirmed (and not retracted) pairing names, this either
   * creates the canonical entity now (first side reached — under the REAL
   * name, via the ordinary createEntity path, so name_kind/owner_entity_id
   * come out null exactly as an ordinary entity's would, no special-casing
   * needed) or returns the id already created for it (second side
   * reached). Either way, the caller's own normal cascade/owner-scoped
   * logic never runs for this call — the merge is authoritative.
   *
   * Alias-suppression is a per-pairing flag on the confirmation itself
   * (CoReferenceMergeInfo.aliasSuppressed), decided once at confirmation
   * time and never recomputed here. Suppressed (true — every pairing that
   * has ever actually run, and the only mode the role-word ask ever
   * produces): the losing side's exact string is deliberately never
   * registered as an alias below. When the role-word side is the FIRST
   * side reached, createEntity is called with the REAL name, never the
   * raw role-word string, so registerAlias(id, name, ...) inside
   * createEntity only ever aliases the real name; when it's the SECOND
   * side reached, this function's own explicit registerAlias call is
   * skipped. Either order, a role word like "husband" stays free to
   * resolve to some other, unrelated anchor elsewhere in the account.
   * Unsuppressed (a real-name-vs-real-name merge): this function
   * additionally registers whichever raw string it was just called with,
   * so the losing real name stays searchable on any later, independent
   * mention instead of silently re-splitting into a fresh duplicate.
   *
   * Checked against the full sourceEventIds provenance array (`[payload.
   * sourceEventId, event.id]` — the message event's own id AND the
   * extraction_completed event's id), never the bare `eventId` the
   * per-event mention cache uses: a stable key (circleBack.ts's own
   * convention, `sourceIds[0]` after sort) is always the MESSAGE event's
   * id, since it sorts lexicographically before the extraction event it
   * produced — but resolveName/resolveRoleWordName's own `eventId`
   * parameter is the EXTRACTION event's id. Checking only `eventId` here
   * would never match a stable key at all; checking the whole provenance
   * array matches correctly regardless of which of the two happens to be
   * the stable key convention elsewhere.
   *
   * ALSO checked against the raw name string being resolved, not just the
   * event id — a real bug caught by this fix's own FAST tests: a
   * stable-key event is a MESSAGE event id, and other, unrelated names are
   * routinely mentioned in that SAME message (the anchor itself, almost
   * always — "her husband is not well" mentions both "husband" and
   * "Annissa" in one message, sharing one stable-key event). Matching on
   * event id alone misfired on every co-mentioned name sharing that
   * event id with the placeholder/real side; the name check is what keeps
   * the merge scoped to the two specific names it's actually about.
   */
  function resolveCoReferenceMerge(rawName: string, extractorVersion: string, sourceEventIds: string[]): string | undefined {
    const matchedKey = sourceEventIds.find((id) => coReferenceMerges.has(id));
    const info = matchedKey ? coReferenceMerges.get(matchedKey) : undefined;
    if (!info) return undefined;
    const lower = normalize(rawName);
    if (lower !== normalize(info.placeholderName) && lower !== normalize(info.realName)) return undefined;
    const existing = canonicalIdByCoReferencePairing.get(info.placeholderStableKey);
    if (existing) {
      projections.touchEntity(existing, sourceEventIds, extractorVersion);
      // Alias-suppression fix: suppressed (role-word) mode stays exactly
      // as before — never alias the losing side's string, since a role
      // word must stay free to resolve to some other anchor elsewhere in
      // the account. Unsuppressed mode (a real-name-vs-real-name merge)
      // additionally aliases whichever string this call resolved — the
      // canonical name is already aliased via createEntity below on
      // whichever side was reached first, so this is what keeps the
      // LOSING real name searchable on any later, independent mention
      // instead of silently re-splitting into a fresh duplicate entity.
      if (!info.aliasSuppressed) registerAlias(existing, rawName, sourceEventIds);
      return existing;
    }
    const id = createEntity(info.canonicalName, extractorVersion, sourceEventIds);
    canonicalIdByCoReferencePairing.set(info.placeholderStableKey, id);
    if (!info.aliasSuppressed) registerAlias(id, rawName, sourceEventIds);
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

    const merged = resolveCoReferenceMerge(trimmed, extractorVersion, sourceEventIds);
    if (merged) {
      mentionResolution.set(cacheKey, merged);
      return merged;
    }

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

  /**
   * Role-word gender derivation (role-word disambiguation batch): writes an
   * INFERRED gender row for entityId when the role word being resolved
   * (already lowercased/normalized) implies one, via ROLE_WORD_GENDER.
   * Called at every point a role word resolves to an entity id that didn't
   * already have one BEFORE this call — both the co-reference-merge
   * canonical-creation path and the ordinary new-placeholder path, never on
   * a cache-hit/reuse path (the gender was already derived the first time).
   * No perception-log entry is written, matching EN-115's own precedent
   * (peopleView.ts): an inferred row has no real "the owner told me this"
   * moment to log, and resolveEntityAttribute's mutable-attribute
   * resolution works correctly without one (falls back to insertion order
   * when no event-dated perception log exists, same as any other undated
   * row). assertAttribute's own write-time validation (isPlausibleWriteTimeValue
   * -> isValidAttributeValue) still applies, so this can never write
   * anything outside GENDER_VALUES even if ROLE_WORD_GENDER is ever
   * miswritten by a future edit.
   */
  function deriveRoleWordGender(entityId: string, roleWordLower: string, sourceEventIds: string[]): void {
    const gender = ROLE_WORD_GENDER[roleWordLower];
    if (!gender) return;
    assertAttribute(projections, userId, entityId, "gender", gender, sourceEventIds, "inferred");
  }

  /**
   * Role-word disambiguation (Task 3): when a role word maps onto a gated
   * relation (ROLE_WORD_RELATION — parent_of or spouse_of) and the owner
   * already has REAL, named (never role_word) counterparties of that
   * relation on record, checks each one's CURRENT gender (stated or
   * derived, via resolveEntityAttribute — a stated value already wins over
   * an inferred one, so this never needs its own tie-break) against the
   * gender the role word implies. Resolves directly to that counterparty
   * ONLY when EXACTLY ONE matches — zero or multiple matches are both left
   * to the caller's existing placeholder-creation fallback, never guessed.
   * parent_of's owner is always the CHILD (to_entity_id); spouse_of is
   * symmetric, so the owner can be on either side and the counterparty is
   * whichever side isn't the owner. Placeholder (name_kind === 'role_word')
   * counterparties are excluded from the candidate pool — a role word
   * should never resolve onto ANOTHER unnamed placeholder, only onto an
   * already-identified real person; a role-word counterparty here always
   * means the earlier owner-scoped role-word search (this function's own
   * caller, just above where this runs) would already have caught the
   * exact-name case, so nothing eligible is ever skipped by excluding it.
   *
   * REAL LIMITATION, confirmed by direct testing, not theoretical: a
   * "stated" gender written via the `attributes` array is NEVER visible
   * here, in ANY rebuild, however the events are ordered — this function
   * runs during the structuralAtoms/socialBonds/entities loop (this file's
   * FIRST full pass over `events`), and `payload.attributes` is processed
   * in a SEPARATE, LATER full pass over `events` (this file's second
   * `for (const event of events)` loop, well below this one) that hasn't
   * run yet for ANY event, including earlier ones, while this loop is
   * still in progress. A stated gender from a prior, already-completed
   * rebuild does not help either — rebuild always drops projections and
   * replays from empty, so nothing persists across separate rebuild()
   * calls. The only gender this function can ever actually see is one
   * ALREADY written inline during THIS SAME structuralAtoms loop —
   * deriveRoleWordGender's own two call sites, both of which run
   * synchronously before any later mention's resolution. In practice this
   * means disambiguation only fires for counterparties that arrived via a
   * role-word derivation (a bare mention, or a co-reference merge) —
   * not one asserted through the `attributes` array in the same rebuild.
   * Not fixed here — reordering the two passes is a larger, separate
   * decision with its own tradeoffs for the rest of resolution, outside
   * this task's scope.
   */
  function findGenderDisambiguationMatch(ownerEntityId: string, roleWordLower: string): string | undefined {
    const relation = ROLE_WORD_RELATION[roleWordLower];
    const impliedGender = ROLE_WORD_GENDER[roleWordLower];
    if (!relation || !impliedGender) return undefined;

    const entityById = new Map(projections.listEntities(userId).map((e) => [e.id, e]));
    const counterpartyIds = new Set<string>();
    for (const atom of projections.listStructuralAtoms(userId, relation)) {
      if (atom.interval_end !== null) continue;
      if (relation === "parent_of") {
        if (atom.to_entity_id === ownerEntityId) counterpartyIds.add(atom.from_entity_id);
      } else {
        if (atom.from_entity_id === ownerEntityId) counterpartyIds.add(atom.to_entity_id);
        else if (atom.to_entity_id === ownerEntityId) counterpartyIds.add(atom.from_entity_id);
      }
    }

    const matches: string[] = [];
    for (const counterpartyId of counterpartyIds) {
      if (entityById.get(counterpartyId)?.name_kind === "role_word") continue;
      const gender = resolveEntityAttribute(projections, userId, counterpartyId, "gender")?.value;
      if (gender === impliedGender) matches.push(counterpartyId);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Role-word placeholder fix: resolves an UNNAMED kinship/role mention
   * ("father", "older sister") deliberately bypassing the ordinary alias
   * cascade above — that cascade matches on the bare string alone, which is
   * exactly what let two different people's unnamed relatives collide onto
   * one entity (the real bug: "her father" and a later, unrelated "father"
   * mention resolving to the same node purely because both wrote the
   * literal word "father"). Never calls registerAlias either, so a
   * role-word entity's bare name never enters the SHARED alias index the
   * ordinary cascade (and findEntityIdByExactAlias, used by chat-turn
   * mention matching) reads from — structurally, not just by convention,
   * this makes a future unscoped "father" mention unable to accidentally
   * match this entity via the normal path.
   *
   * Matching is scoped by ownerEntityId instead: reuses an existing
   * role-word entity only when both the normalized name AND the derived
   * owner match. A null ownerEntityId (owner undetermined — see the two
   * call sites below) always creates fresh rather than searching for a
   * match at all: an extra placeholder entity is the accepted cost, a
   * false merge across two different people's unnamed relatives is not.
   *
   * Role-word disambiguation (Task 3), inserted between the exact-name
   * reuse search above and placeholder creation below: when the exact-name
   * search misses (no placeholder under this word for this owner exists
   * yet — including the case where one existed but was later folded into a
   * real name by a co-reference merge, so this word can never find it by
   * name again), findGenderDisambiguationMatch gets a chance to resolve
   * straight to an already-identified real counterparty instead of
   * creating yet another placeholder. See that function's own comment for
   * exactly what "match" means.
   */
  function resolveRoleWordName(rawName: string, eventId: string, extractorVersion: string, sourceEventIds: string[], ownerEntityId: string | undefined): string {
    const trimmed = rawName.trim();
    const lower = normalize(trimmed);

    const cacheKey = `${eventId}|role:${lower}|${ownerEntityId ?? "none"}`;
    const cached = mentionResolution.get(cacheKey);
    if (cached) return cached;

    const merged = resolveCoReferenceMerge(trimmed, extractorVersion, sourceEventIds);
    if (merged) {
      deriveRoleWordGender(merged, lower, sourceEventIds);
      mentionResolution.set(cacheKey, merged);
      return merged;
    }

    if (ownerEntityId) {
      const existing = projections
        .listEntities(userId)
        .find((e) => e.name_kind === "role_word" && e.owner_entity_id === ownerEntityId && normalize(e.name) === lower);
      if (existing) {
        projections.touchEntity(existing.id, sourceEventIds, extractorVersion);
        mentionResolution.set(cacheKey, existing.id);
        return existing.id;
      }

      const disambiguated = findGenderDisambiguationMatch(ownerEntityId, lower);
      if (disambiguated) {
        projections.touchEntity(disambiguated, sourceEventIds, extractorVersion);
        mentionResolution.set(cacheKey, disambiguated);
        return disambiguated;
      }
    }

    const id = newId();
    projections.insertEntity({
      id,
      user_id: userId,
      name: trimmed,
      confirmed: 0,
      source_event_ids: JSON.stringify([...sourceEventIds].sort()),
      extractor_version: extractorVersion,
      pending_disambiguation: null,
      name_kind: "role_word",
      owner_entity_id: ownerEntityId ?? null,
      created_at: new Date().toISOString()
    });
    deriveRoleWordGender(id, lower, sourceEventIds);
    mentionResolution.set(cacheKey, id);
    return id;
  }

  /**
   * Resolves one fromName/toName pair for a structural atom or social bond,
   * routing each side through resolveName (ordinary cascade) or
   * resolveRoleWordName (owner-scoped, see above) depending on which side,
   * if either, the extractor flagged as a role word. Owner derivation is
   * purely structural (no new extraction field): whichever side is NOT the
   * role word, already resolved, IS the owner — for "her father" that's
   * toName ("Annissa"); for "me" + "older sister" it's fromName ("me").
   * When exactly one side is a role word, that side MUST resolve after the
   * other (its owner needs the other side's real id), which is why this
   * reorders resolution for that case only — the neither-role-word path
   * keeps the original fromId-then-toId order unchanged, so every existing
   * kinship-conflict/counterparty behavior is untouched.
   */
  function resolvePair(
    fromName: string,
    toName: string,
    fromIsRoleWord: boolean,
    toIsRoleWord: boolean,
    eventId: string,
    extractorVersion: string,
    sourceEventIds: string[],
    explicitlyNewPerson: boolean | undefined,
    conflictContext?: { structuralAtomType: string }
  ): { fromId: string; toId: string } {
    if (fromIsRoleWord && toIsRoleWord) {
      // Neither side has a real-name anchor to derive an owner from — the
      // named edge case where the owner cannot be determined at all.
      const fromId = resolveRoleWordName(fromName, eventId, extractorVersion, sourceEventIds, undefined);
      const toId = resolveRoleWordName(toName, eventId, extractorVersion, sourceEventIds, undefined);
      return { fromId, toId };
    }
    if (fromIsRoleWord) {
      const toId = resolveName(toName, eventId, extractorVersion, sourceEventIds, {
        explicitlyNewPerson,
        ...(conflictContext ? { structuralAtomType: conflictContext.structuralAtomType, counterpartyEntityId: plainLookup(fromName) } : {})
      });
      const fromId = resolveRoleWordName(fromName, eventId, extractorVersion, sourceEventIds, toId);
      return { fromId, toId };
    }
    if (toIsRoleWord) {
      const fromId = resolveName(fromName, eventId, extractorVersion, sourceEventIds, {
        explicitlyNewPerson,
        ...(conflictContext ? { structuralAtomType: conflictContext.structuralAtomType, counterpartyEntityId: plainLookup(toName) } : {})
      });
      const toId = resolveRoleWordName(toName, eventId, extractorVersion, sourceEventIds, fromId);
      return { fromId, toId };
    }
    // Neither side is a role word: unchanged, original behavior.
    const roughToId = plainLookup(toName);
    const fromId = resolveName(fromName, eventId, extractorVersion, sourceEventIds, {
      explicitlyNewPerson,
      ...(conflictContext ? { structuralAtomType: conflictContext.structuralAtomType, counterpartyEntityId: roughToId } : {})
    });
    const toId = resolveName(toName, eventId, extractorVersion, sourceEventIds, {
      explicitlyNewPerson,
      ...(conflictContext ? { structuralAtomType: conflictContext.structuralAtomType, counterpartyEntityId: fromId } : {})
    });
    return { fromId, toId };
  }

  let extractionsConsumed = 0;
  let structuralAtomsApplied = 0;
  let structuralAtomsRejected = 0;
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
      const { fromId, toId } = resolvePair(
        atom.fromName,
        atom.toName,
        atom.fromNameIsRoleWord ?? false,
        atom.toNameIsRoleWord ?? false,
        event.id,
        extractorVersion,
        provenance,
        atom.explicitlyNewPerson,
        isAssert ? { structuralAtomType: atom.type } : undefined
      );

      if (atom.type === "parent_of") {
        const written = assertParentOf(projections, userId, fromId, toId, provenance);
        if (written) structuralAtomsApplied++;
        else structuralAtomsRejected++;
      } else if (atom.type === "spouse_of") {
        if (isAssert) {
          const written = assertSpouseOf(projections, userId, fromId, toId, provenance);
          if (written) structuralAtomsApplied++;
          else structuralAtomsRejected++;
        } else {
          const existing = projections
            .listStructuralAtoms(userId, "spouse_of")
            .find((a) => (a.from_entity_id === fromId && a.to_entity_id === toId) || (a.from_entity_id === toId && a.to_entity_id === fromId));
          if (existing) closeSpouseOf(projections, existing.id, event.recordedAt, event.id);
          structuralAtomsApplied++;
        }
      } else {
        const written = assertSiblingOf(projections, userId, fromId, toId, provenance);
        if (written) structuralAtomsApplied++;
        else structuralAtomsRejected++;
      }
    }

    for (const bond of payload.socialBonds ?? []) {
      const { fromId, toId } = resolvePair(
        bond.fromName,
        bond.toName,
        bond.fromNameIsRoleWord ?? false,
        bond.toNameIsRoleWord ?? false,
        event.id,
        extractorVersion,
        provenance,
        bond.explicitlyNewPerson,
        undefined
      );
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
  let deprecatedAttributesSkipped = 0;
  for (const event of events) {
    if (event.type !== "extraction_completed") continue;
    if (eclipsedEventIds.has(event.id)) continue; // EN-065: same exclusion as above, kept consistent across both passes
    const payload = event.payload as ExtractionCompletedPayload;
    const extractorVersion = payload.extractorVersion ?? UNKNOWN_EXTRACTOR_VERSION;
    for (const attr of payload.attributes ?? []) {
      const entityId = resolveName(attr.entityName, event.id, extractorVersion, [payload.sourceEventId, event.id]);

      // Deprecated-attribute replay guard (post-EN-129 vocabulary
      // narrowing): a historical extraction_completed event can carry an
      // attribute type no longer in ATTRIBUTE_TYPES (sexual_orientation,
      // deprecated) — attr.attribute is a raw string from stored JSON, not
      // type-checked at runtime, so nothing else here would catch it
      // before it reached assertAttribute -> insertEntityAttribute's raw
      // SQL INSERT, which would throw a real, uncaught SQLite CHECK
      // constraint violation and crash the entire rebuild (confirmed
      // directly, not assumed, against a fresh-schema table). The entity
      // mention itself still resolves above — a person is still being
      // talked about even when a specific fact about them can no longer
      // be stored — mirroring assertAttribute's own existing precedent
      // for an implausible VALUE (entity resolves, only the write is
      // skipped). Logged loudly, never silent, same discipline as every
      // other rejected-write path in this file.
      if (!isAttributeType(attr.attribute)) {
        // eslint-disable-next-line no-console
        console.error(`rebuildProjections: skipped a deprecated attribute type ${JSON.stringify(attr.attribute)} on entity ${entityId} (event ${event.id}) — no longer in ATTRIBUTE_TYPES, never written.`);
        deprecatedAttributesSkipped++;
        continue;
      }

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
  let relationshipRetractionsApplied = 0;
  for (const event of events) {
    if (event.type !== "fact_corrected") continue;
    // Co-reference retraction (Bug fix 2 of 2): handled entirely by the
    // computeCoReferenceMerges pre-pass above, never here — this loop runs
    // AFTER the main resolution loop has already finished, far too late
    // for a fold that needs entities to be "born correct." Explicit `kind`
    // discriminator, checked before anything else touches the payload:
    // this variant carries no `entityName` at all, and the ordinary
    // resolveCorrectionTargetEntity(payload.targetEventId, payload.entityName)
    // call below would call .trim() on undefined and throw if it ever
    // reached a coReferenceRetraction payload unguarded.
    if ((event.payload as { kind?: string }).kind === "coReferenceRetraction") continue;
    if ((event.payload as { kind?: string }).kind === "relationshipRetraction") {
      // Closes a standing relationship fact, never a mention — bound to
      // the atom/bond's OWN founding stable key (findRetractionTarget),
      // not to an extraction event via mentionResolution the way the
      // rename/attribute-correction shapes below are. This makes the fold
      // independent of replay order and of the correction landing in the
      // same rebuild pass as the original assertion — deterministic on
      // every future rebuild regardless of how many times the log has
      // been replayed since. Idempotent by construction: findRetractionTarget
      // only ever matches an OPEN row, so a retraction already applied on
      // an earlier rebuild (or a duplicate retraction event) finds nothing
      // and is a silent no-op, never a second close.
      const payload = event.payload as RelationshipRetractionPayload;
      const primary = primaryEntityId(userId);
      const entities = projections.listEntities(userId);
      if (payload.store === "structuralAtom") {
        const atom = findRetractionTarget(projections.listStructuralAtoms(userId), entities, primary, payload);
        if (atom) {
          projections.closeStructuralAtom(atom.id, event.recordedAt, event.id);
          relationshipRetractionsApplied++;
        }
      } else {
        const bond = findRetractionTarget(projections.listSocialBonds(userId), entities, primary, payload);
        if (bond) {
          projections.closeSocialBond(bond.id, event.recordedAt, event.id);
          relationshipRetractionsApplied++;
        }
      }
      continue;
    }
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
    // Co-reference confirmation (Bug fix 2 of 2): same reasoning as the
    // coReferenceRetraction guard above — handled entirely by the
    // pre-pass, never by this post-loop handler, and this variant carries
    // no `entityName` at all either.
    if ((event.payload as { kind?: string }).kind === "coReference") continue;
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

  // Bug fix 3 of 3, change 2: plain observability over the final parent_of
  // shape — computed once, after every write this rebuild will ever make
  // to parent_of (deriveSiblingsFromParents, run earlier, only writes
  // sibling_of and never changes parent_of). See RebuildResult's own doc
  // comment on maxOpenParentsForAnyChild for why this exists instead of a cap.
  let maxOpenParentsForAnyChild = 0;
  {
    const openParentCountByChild = new Map<string, number>();
    for (const atom of projections.listStructuralAtoms(userId, "parent_of")) {
      if (atom.interval_end !== null) continue;
      openParentCountByChild.set(atom.to_entity_id, (openParentCountByChild.get(atom.to_entity_id) ?? 0) + 1);
    }
    for (const count of openParentCountByChild.values()) {
      if (count > maxOpenParentsForAnyChild) maxOpenParentsForAnyChild = count;
    }
  }

  // Unnamed-entity purge (30-day rule): the FINAL pass, after every other
  // fold above has run. Can never be a decline-to-materialize check
  // inside resolveName/resolveRoleWordName — "last mention" isn't
  // knowable until the entire log has been walked, so a correct decision
  // needs each entity's real, final source_event_ids, which only exists
  // once the main loop and every post-pass (corrections, confirmations,
  // episodes) have finished. A real cascade, not a soft delete:
  // projections.purgeEntity removes every atom/bond/attribute/alias
  // referencing the entity in the same transaction as the entity row
  // itself, so nothing is left orphaned for a later pass to clean up.
  // referenceDate (EN-057) is what keeps this a pure function of
  // (events, referenceDate) rather than the system clock — two rebuilds
  // with the same referenceDate must purge exactly the same entities.
  const PURGE_THRESHOLD_DAYS = 30;
  const recordedAtByMessageId = new Map(events.filter((e) => e.type === "message_sent").map((e) => [e.id, e.recordedAt]));
  let entitiesPurged = 0;
  for (const entity of projections.listEntities(userId)) {
    if (!hasNoRealName(entity.name, entity.name_kind)) continue;
    // Exemption (confirmed against the real corpus before building this):
    // a real name learned at some point — never the entity's own role-word
    // string self-aliased by ordinary creation — exempts permanently.
    if (hasNonRoleWordAlias(projections.listEntityAliases(userId, entity.id))) continue;
    const { lastMentionAt } = resolveMentionDates(entity, recordedAtByMessageId);
    if (!lastMentionAt) continue; // no resolvable message mention to measure against — never guess, leave it
    const daysSinceLastMention = (referenceDate.getTime() - new Date(lastMentionAt).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceLastMention < PURGE_THRESHOLD_DAYS) continue;
    projections.purgeEntity(entity.id);
    entitiesPurged++;
  }

  return {
    entitiesWritten: projections.listEntities(userId).length,
    extractionsConsumed,
    messagesCurrentlyFailed,
    correctionsApplied,
    attributeCorrectionsApplied,
    relationshipRetractionsApplied,
    confirmationsApplied,
    structuralAtomsApplied,
    structuralAtomsRejected,
    maxOpenParentsForAnyChild,
    socialBondsApplied,
    attributesApplied,
    deprecatedAttributesSkipped,
    pendingDisambiguations,
    entitiesPurged,
    episodesBuilt: episodeRows.length
  };
}
