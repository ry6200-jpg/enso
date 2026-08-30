/**
 * The intent router (EN-070/071/074/075, Phase 6): one structured-JSON call
 * per user turn, after the cheap local heuristics have already computed the
 * candidate pools/signals below — the router's job is judgment over those
 * candidates, never independent discovery of them (it can never fire a
 * circle-back on an entity it wasn't handed, and never point retrieval's
 * entity mode at an id it wasn't handed — both are validated against the
 * candidate lists after the call returns, never trusted blindly).
 */

/** Ambient context batch, item 1: canonical definition lives in ambientCandidates.ts (which builds this pool from ProjectionsDb) — imported and re-exported here rather than duplicated, so there is exactly one definition. */
import type { AmbientLocationCandidate } from "../ambientCandidates.js";
export type { AmbientLocationCandidate };
import type { AttributeType } from "../../projections/attributeVocabulary.js";
import type { CoReferenceCandidate, CoReferenceConfirmedPairing } from "../coReference.js";
export type { CoReferenceCandidate, CoReferenceConfirmedPairing };
import type { PendingMergeProposal } from "../../relationships/ownerInitiatedMerge.js";
export type { PendingMergeProposal };
import type { TypoMergeCandidate, TypoMergePendingPairing } from "../../relationships/typoMerge.js";
export type { TypoMergeCandidate, TypoMergePendingPairing };
import type { RetractableRelationType } from "../../relationships/relationshipRetraction.js";
export type { RetractableRelationType };

export interface CircleBackCandidate {
  /** The entity's CURRENT projection id — valid for this turn's router selection only. Never persisted for cross-turn matching (see stableKey): entity ids are reassigned on every rebuild (EN-054), a real bug found live in Phase 7 when attempt-tracking briefly keyed off this instead. */
  entityId: string;
  name: string;
  /** Which attempt this would be if it fires (1 or 2 — EN-030's hard cap). */
  attemptNumber: 1 | 2;
  /** Human-readable bucketed gap since the entity's earliest mention, for retry phrasing to bridge ("The other day you mentioned..."). Present on every candidate for uniformity; only meaningfully used by the persona on a retry (attemptNumber 2). */
  mentionAgeLabel: string;
  /** The entity's earliest provenance event ULID — stable across rebuilds (unlike entityId), so this is what cross-turn attempt-history matching actually keys on. */
  stableKey: string;
}

/** EN-097 Layer 1 (name generators) — the answer is a NAME, not a feeling; see elicitation.ts's own doc comment for the full rationale and the fixed subtype list. */
export type ElicitationLayer1ProbeType = "goodNews" | "call2am" | "seeVsMatter" | "lostTouch" | "dependsOnThem" | "knownLongest";

/** EN-097 Layer 3 (key scenes) — unlocked only once an anchor entity exists; see elicitation.ts. */
export type ElicitationLayer3ProbeType = "howMet" | "earliestMemory" | "highPoint" | "lowPoint" | "turningPoint" | "wantRemembered";

/**
 * EN-097: an elicitation probe candidate — Layer 1 (no anchor needed,
 * "primary opener") or Layer 3 (requires an already-established anchor
 * entity to deepen on). Layer 2 (life-domain coverage) is deliberately NOT
 * a candidate kind at all — it's a hidden ranking signal used by
 * elicitation.ts to decide priority/eligibility, never spoken and never
 * exposed to the router as a choice of its own (see elicitation.ts).
 */
export type ElicitationCandidate =
  | { kind: "elicitation"; layer: 1; probeType: ElicitationLayer1ProbeType }
  | {
      kind: "elicitation";
      layer: 3;
      probeType: ElicitationLayer3ProbeType;
      /** The entity's CURRENT projection id — valid for this turn's router selection only, same caveat as CircleBackCandidate.entityId above. Never persisted for cross-turn matching. */
      anchorEntityId: string;
      anchorName: string;
      /** The anchor entity's earliest provenance event ULID — stable across rebuilds (unlike anchorEntityId), so this is what cross-turn (probeType, anchor) attempt-history actually keys on (R44: elicitation.ts previously keyed on anchorEntityId directly and silently lost its own attempt cap across rebuilds). */
      anchorStableKey: string;
    };

/**
 * EN-030 item A: the self-initiated-curiosity candidate pool, generalized
 * beyond third-party names to also cover gaps in Enso's picture of the
 * OWNER — currently location and occupation, the two entity_attributes
 * types (db.ts's CHECK constraint) not already covered by
 * selfBirthdateGate.ts's own separate, unconditional, higher-priority
 * mechanism (birthdate stays exactly as it is — untouched by this
 * generalization). A self-fact candidate always outranks a thirdParty one
 * — enforced in circleBack.ts's findCuriosityAskCandidates by never
 * including both kinds in the same list, never by ranking within one.
 *
 * EN-097 extends this same pool with ElicitationCandidate (Layer 1/3) —
 * elicitation.ts's own priority order (selfFact > thirdParty > Layer 1 >
 * Layer 3) is enforced the identical way: only the winning kind's
 * candidates ever populate this list for a given turn.
 */
// attribute here is deliberately the curated "location" | "occupation"
// subset, not AttributeType — see attributeVocabulary.ts's header comment
// and circleBack.ts's SELF_FACT_ATTRIBUTES, which this must stay in sync
// with by hand: proactive curiosity-asking is a product/wording decision,
// not vocabulary fan-out.
export type CuriosityAskCandidate =
  | { kind: "thirdParty"; candidate: CircleBackCandidate }
  | { kind: "selfFact"; attribute: "location" | "occupation" }
  | ElicitationCandidate;

/** A specific attribute claim recently surfaced (in the retrieved-memory block or the prior reply) that this turn might be explicitly affirming or correcting (EN-066). Full vocabulary, not a curated subset: any attribute already on record can be affirmed or corrected reactively, regardless of whether Enso would ever proactively ASK about it (contrast CuriosityAskCandidate's "selfFact" branch below). */
export interface RecentAttributeClaim {
  entityName: string;
  attribute: AttributeType;
  value: string;
  /** The extraction_completed event ULID that asserted this claim — resolved by the caller (never the model) into fact_confirmed's targetEventId (EN-055). */
  extractionEventId: string;
}


export interface RouterRequest {
  /** The user's current message, verbatim. */
  message: string;
  /** Prior turns already in the recent-window (same shape chatPipeline already assembles) — gives the router context for attestation judgment without a second retrieval pass. */
  recentTurns: { role: "user" | "enso"; text: string }[];
  /** Known entity names+ids this user has on record (for entity-mode retrieval) — the router may only ever return an id from this list. */
  knownEntities: { entityId: string; name: string }[];
  /**
   * EN-030 condition B: whether the code-level open-loop / winding-down
   * precondition passed this turn (circleBack.ts's isCuriosityTurnEligible
   * — a deterministic, FAST-testable check, never left to model judgment).
   * When false, curiosityTurn.fire must come back false and kind null
   * regardless of anything else the model might otherwise notice — the
   * router is never the one deciding timing eligibility, only what to do
   * with it once granted.
   */
  curiosityTurnEligible: boolean;
  /** The ranked ask-candidate pool from the cheap local heuristic (circleBack.ts) — the router may only ever fire "selfFact"/"thirdParty" on an entry actually in this list; empty whenever curiosityTurnEligible is false. */
  curiosityCandidates: CuriosityAskCandidate[];
  /** Attribute claims recently on the table that this turn could be affirming — the router may only ever confirm one already in this list. */
  recentAttributeClaims: RecentAttributeClaim[];
  /** Ambient context batch, item 1: third parties with a known location, eligible for weather/local-time context this turn — see ambientCandidates.ts. */
  ambientLocationCandidates: AmbientLocationCandidate[];
  /** Whether the owner's own coordinates are actually available this turn (client sent them). When false, ownSituation must come back false regardless of what the router might otherwise judge relevant — there's nothing to fetch. */
  ownLocationAvailable: boolean;
  /** Part 4 (ambient travel context): whether the owner has a stated home/residence on record at all (entity_attributes.location for the primary user) — the fallback destination when no specific place was named this turn. When false AND no place is named in the message, travelContext.relevant should come back false — there is nothing to route to. */
  primaryResidenceKnown: boolean;
  /**
   * EN-101/Bug fix 2 of 2: co-reference pairings the CURRENT message could
   * be answering (confirming) — the router may only ever confirm a
   * placeholderStableKey already in this list. Distinct from
   * coReferenceAskCandidates below: that pool is for whether to ASK the
   * question this turn; this one is for recognizing an ANSWER to a
   * question already asked in a prior turn.
   */
  coReferencePendingCandidates: CoReferenceConfirmedPairing[];
  /** Confirmed-but-not-yet-retracted co-reference pairings the CURRENT message could be disputing — the router may only ever retract a placeholderStableKey already in this list. */
  coReferenceConfirmedPairings: CoReferenceConfirmedPairing[];
  /**
   * Removed from the curiosity-turn pool (was findCuriosityAskCandidates'
   * "coReference" kind) — live-tested starvation: findCuriosityAskCandidates
   * is a strict fallthrough, and thirdParty regenerates continuously in an
   * active account, so the coReference branch beneath it was effectively
   * unreachable. Computed unconditionally every turn now (never gated
   * behind curiosityTurnEligible, never waiting on the shared cooldown) —
   * the router may only ever ask about a placeholderStableKey already in
   * this list, validated the same per-axis way every other candidate list
   * here is.
   */
  coReferenceAskCandidates: CoReferenceCandidate[];
  /**
   * Owner-initiated merge: the latest merge proposal still awaiting an
   * answer, if any — the router needs to SEE this to correctly recognize a
   * plain "yes" or a correction as an answer, since neither restates the
   * two names on its own. Null whenever no proposal is pending.
   */
  mergePendingProposal: PendingMergeProposal | null;
  /** Enso-initiated typo detection: pairs eligible to ASK about this turn — the router may only ever ask about a pairKey already in this list. */
  typoMergeAskCandidates: TypoMergeCandidate[];
  /** Typo-merge questions already asked, awaiting an answer — the router may only ever confirm/dismiss a pairKey already in this list. */
  typoMergePendingCandidates: TypoMergePendingPairing[];
}

export type RetrievalModeDecision = "hybrid" | "entity" | "recency";

export type RegisterMode = "natural" | "zen";

export interface RouterDecision {
  retrieval: {
    mode: RetrievalModeDecision;
    entityId: string | null;
    temporalWeight: number;
    n: number | null;
  };
  /**
   * EN-030: whether this reply should proactively take a turn — asking
   * about one specific missing piece (kind "selfFact"/"thirdParty") or
   * making a connecting observation instead of asking (kind "connectDot",
   * EN-041's "BE ANALYTICAL, NOT JUST RECEPTIVE" made a first-class,
   * competing alternative rather than a stylistic fallback). Content is
   * never invented by the model: entityId/attribute must come from
   * curiosityCandidates, and fire is forced false whenever
   * curiosityTurnEligible was false (see RouterRequest) — silence grants
   * permission to take a turn, it never supplies what to say.
   */
  curiosityTurn: {
    fire: boolean;
    kind: "selfFact" | "thirdParty" | "connectDot" | "elicitation" | null;
    /** Set only when kind is "thirdParty" — must match a curiosityCandidates entry's entityId. Also set for a Layer 3 "elicitation" candidate (the anchor entity) — same field, same validation shape, never ambiguous since kind disambiguates which meaning applies. */
    entityId: string | null;
    /** Set only when kind is "selfFact" — must match a curiosityCandidates entry's attribute. Same deliberate curated subset as CuriosityAskCandidate above, not AttributeType. */
    attribute: "location" | "occupation" | null;
    /**
     * Set only when kind is "elicitation" — must match a curiosityCandidates
     * entry's probeType (EN-097). No longer reused for co-reference (see
     * the coReference axis below, which now covers ask/confirm/retract
     * together — removed from curiosity entirely, live-tested starvation).
     */
    probeType: string | null;
  };
  attestation: {
    isAffirmation: boolean;
    entityName: string | null;
    attribute: AttributeType | null;
    value: string | null;
  };
  /**
   * EN-101/Bug fix 2 of 2, widened: the co-reference axis now covers the
   * ASK side too, not just recognizing the OWNER's own answer — moved off
   * curiosityTurn.kind entirely (see that field's comment) since it is not
   * curiosity and must not compete for curiosityTurn's single slot or wait
   * on its shared cooldown. Keyed by placeholderStableKey throughout, never
   * an entity id or entity name (ids are reassigned every rebuild, EN-054).
   * "ask" must match an entry in coReferenceAskCandidates; "confirm" must
   * match an entry in coReferencePendingCandidates; "retract" must match an
   * entry in coReferenceConfirmedPairings — validated the same per-axis way
   * attestation is, never trusted blindly. "ask" may fire in the same turn
   * as a curiosityTurn ask (EN-041's "occasionally more, two genuinely
   * distinct gaps" — a correction and a curiosity gap are about as distinct
   * as two gaps get); nothing here forces mutual exclusion with curiosityTurn.
   */
  coReference: {
    fire: boolean;
    direction: "confirm" | "retract" | "ask" | null;
    pendingStableKey: string | null;
  };
  /**
   * Owner-initiated merge. Open-world by design (see the design report):
   * firstName/secondName are verbatim spans from the CURRENT message, not
   * validated against a rendered candidate list the way coReference's
   * pendingStableKey is — resolution against the real roster happens
   * afterward, entirely in code (resolveMergeRequest). Two shapes this can
   * recognize:
   * - a FRESH statement that two people on record are the same person
   *   (survivingName set only if the owner also said which name to keep);
   * - an ANSWER to mergePendingProposal (a plain agreement or a
   *   correction) — firstName/secondName copied from the pending proposal,
   *   survivingName set to whichever name is now confirmed.
   * fire MUST be false, every other field null, whenever neither applies.
   */
  mergeRequest: {
    fire: boolean;
    firstName: string | null;
    secondName: string | null;
    survivingName: string | null;
  };
  /**
   * Enso-initiated typo detection. Unlike coReference (neither side is a
   * role-word placeholder to answer FOR) or mergeRequest (the owner never
   * said anything — Enso is the one raising the suspicion), this axis's
   * own ask IS the survivor proposal, so there is no separate propose turn
   * the way mergeRequest needs one. pendingStableKey is a PAIR key (both
   * sides' stable keys, sorted and joined — see typoMerge.ts's pairKey),
   * never a single side's, since neither side is more "the identity" than
   * the other.
   * - direction="ask": pendingStableKey MUST match a typoMergeAskCandidates
   *   entry. survivingName MUST be null (nothing to confirm yet).
   * - direction="confirm": the CURRENT message agrees with the proposed
   *   survivor OR names the other one instead. pendingStableKey MUST match
   *   a typoMergePendingCandidates entry; survivingName is the explicit
   *   name if the owner named one, null to accept whatever was proposed.
   * - direction="dismiss": the CURRENT message clearly says these are
   *   different people. pendingStableKey MUST match a
   *   typoMergePendingCandidates entry; survivingName MUST be null.
   * fire MUST be false, every other field null, whenever none applies.
   */
  typoMerge: {
    fire: boolean;
    direction: "ask" | "confirm" | "dismiss" | null;
    pendingStableKey: string | null;
    survivingName: string | null;
  };
  /**
   * Relationship retraction: "Annissa is not my sister" closes the
   * sibling_of atom between Annissa and the owner. Shaped like
   * mergeRequest, not coReference/typoMerge — open-world, free-text name
   * spans, no candidate list to validate pendingStableKey against, since
   * this recognizes what the OWNER says the same way mergeRequest does.
   * Its own axis rather than a widened mergeRequest: the two names here
   * refer to DIFFERENT people (never the same person), and relationType
   * has no home in mergeRequest's schema. relationType comes from the
   * closed enum directly (structural-atom types plus social-bond types)
   * — the model names it from its own reading of the sentence, no
   * synonym table; the schema's own enum constraint is the only
   * validation needed.
   *
   * Single retraction per turn, consistent with every other axis here —
   * deliberately NOT array-shaped. A message naming two retractions
   * ("Alice is not a friend. Annissa is not my sister.") catches one;
   * the owner repeats the other on a later turn. Resolution (does the
   * name resolve, is it ambiguous, does the relationship even exist)
   * happens entirely downstream, in code, against the live roster —
   * resolveRelationshipRetraction, never trusted from the model.
   *
   * fire MUST be false, every other field null, whenever the current
   * message isn't the owner retracting a specific relationship.
   */
  relationshipRetraction: {
    fire: boolean;
    firstName: string | null;
    secondName: string | null;
    relationType: RetractableRelationType | null;
  };
  /**
   * EN-048's "real layer": the router's own semantic judgment on whether
   * THIS turn calls for the conditional zen register, independent of the
   * cheap literal-trigger-phrase check (src/conversation/voiceMode.ts) —
   * needed because someone genuinely overwhelmed rarely types the literal
   * word "overwhelmed" (the exact literal-phrase failure class already in
   * the regression ledger, R9). No new candidate list needed for this
   * axis — message + recentTurns (already in RouterRequest) are enough for
   * the model to judge tone, unlike circleBack/attestation which need an
   * externally-supplied candidate to validate against.
   */
  register: {
    mode: RegisterMode;
  };
  /**
   * Ambient context batch, item 1: the relevance gate, folded into this
   * same call rather than a new one (EN-075's own pattern — see
   * attestation.ts). GOVERNING RULE: relevant is true only when a live
   * decision or concern is already on the table — never "location is
   * known, so mention it." When relevant is false, every other field
   * here must be false/null and NO ambient API call happens at all this
   * turn, not even for the owner's own situation.
   */
  ambientContext: {
    relevant: boolean;
    /** The owner's own weather/local time — silent calibration (case a) or something they can't know about their own situation from where they are. Must be false whenever RouterRequest.ownLocationAvailable was false. */
    ownSituation: boolean;
    /** A third party's weather/local time (case b) — must match an ambientLocationCandidates entry's entityId, or null. */
    thirdPartyEntityId: string | null;
    /** A place the owner named this turn that a walking-distance/nearby lookup would resolve (case c) — free text (e.g. "the pharmacy she mentioned", "the Pantages"), never validated against a candidate list the way entity ids are: this is resolved via Places lookup, never stored, never treated as a fact in its own right, so an unresolvable or slightly-off name just yields no distance data this turn rather than any real corruption. */
    namedPlaceForDistance: string | null;
  };
  /**
   * Part 4: the fifth axis, ported from the old app's decideLocationToolUse
   * judgment (whether a real, current drive-time/traffic number would
   * concretely change the advice or observation about to be given right
   * now) into this router's existing structured-decision shape, rather
   * than a separate tool-calling mechanism. GOVERNING RULE, same
   * discipline as ambientContext above: relevant is true only when the
   * owner is actually facing a timing/attendance decision this turn — an
   * upcoming drive, whether to leave now, how much time to allow — never
   * "a destination is knowable, so check it."
   */
  travelContext: {
    relevant: boolean;
    /**
     * Free text for a SPECIFIC destination named this turn (e.g. "my
     * mom's place", "the office"), never validated against a candidate
     * list — resolved via geocoding, same treatment as
     * ambientContext.namedPlaceForDistance. Null means no specific place
     * was named; the fetch layer falls back to the owner's own stated
     * residence (entity_attributes.location) when this is null AND
     * RouterRequest.primaryResidenceKnown is true. If neither resolves,
     * no call is made this turn.
     */
    destinationHint: string | null;
  };
}

export interface RouterCallResult {
  provider: "openai" | "gemini";
  model: string;
  decision: RouterDecision;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

/** EN-075's fail-safe: hybrid retrieval, no temporal weighting, no gate actions, natural register (never zen) — used on router error/timeout/malformed JSON, and on EN-083's uncertified-failover-tier bypass. Never blocks the reply either way. */
export const SAFE_DEFAULT_DECISION: RouterDecision = {
  retrieval: { mode: "hybrid", entityId: null, temporalWeight: 0, n: null },
  curiosityTurn: { fire: false, kind: null, entityId: null, attribute: null, probeType: null },
  attestation: { isAffirmation: false, entityName: null, attribute: null, value: null },
  coReference: { fire: false, direction: null, pendingStableKey: null },
  mergeRequest: { fire: false, firstName: null, secondName: null, survivingName: null },
  typoMerge: { fire: false, direction: null, pendingStableKey: null, survivingName: null },
  relationshipRetraction: { fire: false, firstName: null, secondName: null, relationType: null },
  register: { mode: "natural" },
  ambientContext: { relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null },
  travelContext: { relevant: false, destinationHint: null }
};
