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
  entityId: string;
  name: string;
}

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
  /** Circle-back-eligible candidates from the cheap local heuristic (circleBack.ts) — the router may only ever fire on an id from this list. */
  circleBackCandidates: CircleBackCandidate[];
  /** Attribute claims recently on the table that this turn could be affirming — the router may only ever confirm one already in this list. */
  recentAttributeClaims: RecentAttributeClaim[];
}

export type RetrievalModeDecision = "hybrid" | "entity" | "recency";

export interface RouterDecision {
  retrieval: {
    mode: RetrievalModeDecision;
    entityId: string | null;
    temporalWeight: number;
    n: number | null;
  };
  circleBack: {
    fire: boolean;
    entityId: string | null;
  };
  attestation: {
    isAffirmation: boolean;
    entityName: string | null;
    attribute: "birthdate" | "location" | "occupation" | null;
    value: string | null;
  };
}

export interface RouterCallResult {
  provider: "openai" | "gemini";
  model: string;
  decision: RouterDecision;
  usage: { inputTokens: number; outputTokens: number };
}

/** EN-075's fail-safe: hybrid retrieval, no temporal weighting, no gate actions — used on router error/timeout/malformed JSON, and on EN-083's uncertified-failover-tier bypass. Never blocks the reply either way. */
export const SAFE_DEFAULT_DECISION: RouterDecision = {
  retrieval: { mode: "hybrid", entityId: null, temporalWeight: 0, n: null },
  circleBack: { fire: false, entityId: null },
  attestation: { isAffirmation: false, entityName: null, attribute: null, value: null }
};
