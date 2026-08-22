/**
 * The intent router (EN-070/071/074/075, Phase 6): one structured-JSON call
 * per user turn, after the cheap local heuristics have already computed the
 * candidate pools/signals below — the router's job is judgment over those
 * candidates, never independent discovery of them (it can never fire a
 * circle-back on an entity it wasn't handed, and never point retrieval's
 * entity mode at an id it wasn't handed — both are validated against the
 * candidate lists after the call returns, never trusted blindly).
 */

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
 */
export type CuriosityAskCandidate = { kind: "thirdParty"; candidate: CircleBackCandidate } | { kind: "selfFact"; attribute: "location" | "occupation" };

/** A specific attribute claim recently surfaced (in the retrieved-memory block or the prior reply) that this turn might be explicitly affirming or correcting (EN-066). */
export interface RecentAttributeClaim {
  entityName: string;
  attribute: "birthdate" | "location" | "occupation";
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
    kind: "selfFact" | "thirdParty" | "connectDot" | null;
    /** Set only when kind is "thirdParty" — must match a curiosityCandidates entry's entityId. */
    entityId: string | null;
    /** Set only when kind is "selfFact" — must match a curiosityCandidates entry's attribute. */
    attribute: "location" | "occupation" | null;
  };
  attestation: {
    isAffirmation: boolean;
    entityName: string | null;
    attribute: "birthdate" | "location" | "occupation" | null;
    value: string | null;
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
}

export interface RouterCallResult {
  provider: "openai" | "gemini";
  model: string;
  decision: RouterDecision;
  usage: { inputTokens: number; outputTokens: number };
}

/** EN-075's fail-safe: hybrid retrieval, no temporal weighting, no gate actions, natural register (never zen) — used on router error/timeout/malformed JSON, and on EN-083's uncertified-failover-tier bypass. Never blocks the reply either way. */
export const SAFE_DEFAULT_DECISION: RouterDecision = {
  retrieval: { mode: "hybrid", entityId: null, temporalWeight: 0, n: null },
  curiosityTurn: { fire: false, kind: null, entityId: null, attribute: null },
  attestation: { isAffirmation: false, entityName: null, attribute: null, value: null },
  register: { mode: "natural" }
};
