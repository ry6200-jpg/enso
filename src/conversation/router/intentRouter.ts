import { ClientRequestError } from "../../providers/errors.js";
import { runWithFallback } from "../../providers/fallback.js";
import type { CostTracker } from "../../providers/costTracker.js";
import { createGeminiRouterAdapter, createOpenAiRouterAdapter, type RouterAdapter } from "./routerAdapters.js";
import { SAFE_DEFAULT_DECISION, type RouterDecision, type RouterRequest } from "./routerTypes.js";

export interface RouterResult {
  decision: RouterDecision;
  /** null only when both tiers failed outright — decision is then SAFE_DEFAULT_DECISION. */
  provider: "openai" | "gemini" | null;
  model: string | null;
  /** True only when the decision came from a certified tier AND passed validation untouched. Round-trip-recorded on reply_sent (EN-070's "never silently absorbed" / EN-085). */
  certified: boolean;
  /** Non-null whenever anything was overridden or defaulted: total failure, malformed output, an invented id caught by validation, or an uncertified-tier gate bypass (EN-083). Never thrown — the caller always gets a usable decision. */
  failureReason: string | null;
}

export interface IntentRouter {
  route(request: RouterRequest): Promise<RouterResult>;
}

/**
 * Validates the raw model decision against the candidate lists actually
 * handed in, per-axis (never all-or-nothing) — an invented entityId on one
 * axis degrades only that axis to its safe default, not the whole
 * decision. This is what makes "never invent facts not present in the
 * text" (the extraction prompt's closing line) hold for routing
 * decisions too: the model proposes, the candidate lists it was actually
 * given dispose.
 */
function validateDecision(raw: RouterDecision, request: RouterRequest): { decision: RouterDecision; reasons: string[] } {
  const reasons: string[] = [];
  const decision: RouterDecision = structuredClone(raw);

  if (decision.retrieval.mode === "entity") {
    const known = request.knownEntities.some((e) => e.entityId === decision.retrieval.entityId);
    if (!known) {
      reasons.push(`retrieval.entityId ${JSON.stringify(decision.retrieval.entityId)} is not a known entity — degraded to hybrid`);
      decision.retrieval = { mode: "hybrid", entityId: null, temporalWeight: decision.retrieval.temporalWeight, n: null };
    }
  }
  if (decision.retrieval.mode === "recency" && decision.retrieval.n === null) {
    decision.retrieval.n = 10;
  }

  const NO_ACTION_CURIOSITY_TURN = { fire: false, kind: null, entityId: null, attribute: null, probeType: null } as const;

  if (decision.curiosityTurn.fire) {
    if (!request.curiosityTurnEligible) {
      reasons.push("curiosityTurn.fire=true but curiosityTurnEligible was false this turn — suppressed (EN-030 condition B precondition)");
      decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
    } else if (decision.curiosityTurn.kind === "thirdParty") {
      const known = request.curiosityCandidates.some((c) => c.kind === "thirdParty" && c.candidate.entityId === decision.curiosityTurn.entityId);
      if (!known) {
        reasons.push(`curiosityTurn.entityId ${JSON.stringify(decision.curiosityTurn.entityId)} is not an eligible thirdParty candidate — suppressed`);
        decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
      }
    } else if (decision.curiosityTurn.kind === "selfFact") {
      const known = request.curiosityCandidates.some((c) => c.kind === "selfFact" && c.attribute === decision.curiosityTurn.attribute);
      if (!known) {
        reasons.push(`curiosityTurn.attribute ${JSON.stringify(decision.curiosityTurn.attribute)} is not an eligible selfFact candidate — suppressed`);
        decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
      }
    } else if (decision.curiosityTurn.kind === "coReference") {
      const known = request.curiosityCandidates.some((c) => c.kind === "coReference" && c.candidate.placeholderStableKey === decision.curiosityTurn.probeType);
      if (!known) {
        reasons.push(`curiosityTurn.probeType ${JSON.stringify(decision.curiosityTurn.probeType)} is not an eligible coReference candidate — suppressed`);
        decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
      }
    } else if (decision.curiosityTurn.kind === "elicitation") {
      const known = request.curiosityCandidates.some(
        (c) =>
          c.kind === "elicitation" &&
          c.probeType === decision.curiosityTurn.probeType &&
          (c.layer === 1 || (c.layer === 3 && c.anchorEntityId === decision.curiosityTurn.entityId))
      );
      if (!known) {
        reasons.push(`curiosityTurn.probeType ${JSON.stringify(decision.curiosityTurn.probeType)} is not an eligible elicitation candidate — suppressed`);
        decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
      }
    } else if (decision.curiosityTurn.kind !== "connectDot") {
      reasons.push(`curiosityTurn.kind ${JSON.stringify(decision.curiosityTurn.kind)} is not a recognized kind — suppressed`);
      decision.curiosityTurn = NO_ACTION_CURIOSITY_TURN;
    }
  }

  if (decision.attestation.isAffirmation) {
    const matches = request.recentAttributeClaims.some(
      (c) => c.entityName === decision.attestation.entityName && c.attribute === decision.attestation.attribute && c.value === decision.attestation.value
    );
    if (!matches) {
      reasons.push("attestation does not exactly match a recently surfaced claim — suppressed");
      decision.attestation = { isAffirmation: false, entityName: null, attribute: null, value: null };
    }
  }

  const NO_ACTION_CO_REFERENCE = { fire: false, direction: null, pendingStableKey: null } as const;

  if (decision.coReference.fire) {
    if (decision.coReference.direction === "confirm") {
      const known = request.coReferencePendingCandidates.some((c) => c.placeholderStableKey === decision.coReference.pendingStableKey);
      if (!known) {
        reasons.push(`coReference.pendingStableKey ${JSON.stringify(decision.coReference.pendingStableKey)} is not an eligible pending co-reference candidate — suppressed`);
        decision.coReference = NO_ACTION_CO_REFERENCE;
      }
    } else if (decision.coReference.direction === "retract") {
      const known = request.coReferenceConfirmedPairings.some((c) => c.placeholderStableKey === decision.coReference.pendingStableKey);
      if (!known) {
        reasons.push(`coReference.pendingStableKey ${JSON.stringify(decision.coReference.pendingStableKey)} is not a confirmed co-reference pairing — suppressed`);
        decision.coReference = NO_ACTION_CO_REFERENCE;
      }
    } else {
      reasons.push(`coReference.direction ${JSON.stringify(decision.coReference.direction)} is not a recognized direction — suppressed`);
      decision.coReference = NO_ACTION_CO_REFERENCE;
    }
  } else if (decision.coReference.direction !== null || decision.coReference.pendingStableKey !== null) {
    reasons.push("coReference had a sub-field set while fire=false — suppressed entirely");
    decision.coReference = NO_ACTION_CO_REFERENCE;
  }

  const NO_ACTION_AMBIENT_CONTEXT = { relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null } as const;

  if (decision.ambientContext.relevant) {
    if (decision.ambientContext.ownSituation && !request.ownLocationAvailable) {
      reasons.push("ambientContext.ownSituation=true but ownLocationAvailable was false this turn — suppressed, nothing to fetch");
      decision.ambientContext = { ...decision.ambientContext, ownSituation: false };
    }
    if (decision.ambientContext.thirdPartyEntityId !== null) {
      const known = request.ambientLocationCandidates.some((c) => c.entityId === decision.ambientContext.thirdPartyEntityId);
      if (!known) {
        reasons.push(`ambientContext.thirdPartyEntityId ${JSON.stringify(decision.ambientContext.thirdPartyEntityId)} is not an eligible ambient-location candidate — suppressed`);
        decision.ambientContext = { ...decision.ambientContext, thirdPartyEntityId: null };
      }
    }
    // Downgrade relevant=true to false if, after the checks above, nothing is actually left to fetch — an
    // uninformative "relevant" flag with every sub-field cleared is functionally the same as never having fired.
    if (!decision.ambientContext.ownSituation && decision.ambientContext.thirdPartyEntityId === null && decision.ambientContext.namedPlaceForDistance === null) {
      decision.ambientContext = NO_ACTION_AMBIENT_CONTEXT;
    }
  } else if (decision.ambientContext.ownSituation || decision.ambientContext.thirdPartyEntityId !== null || decision.ambientContext.namedPlaceForDistance !== null) {
    reasons.push("ambientContext had a sub-field set while relevant=false — suppressed entirely");
    decision.ambientContext = NO_ACTION_AMBIENT_CONTEXT;
  }

  // Part 4: destinationHint is free text, same treatment as ambientContext.namedPlaceForDistance —
  // resolved via a real geocode afterward, never validated against a candidate list. The only
  // structural check here is the same "never a sub-field set while relevant=false" discipline
  // every other axis already gets; destinationHint=null WITH relevant=true is a valid state (the
  // fetch layer falls back to the owner's own stated residence — see ambientTravelFetch.ts).
  const NO_ACTION_TRAVEL_CONTEXT = { relevant: false, destinationHint: null } as const;
  if (!decision.travelContext.relevant && decision.travelContext.destinationHint !== null) {
    reasons.push("travelContext had destinationHint set while relevant=false — suppressed entirely");
    decision.travelContext = NO_ACTION_TRAVEL_CONTEXT;
  }

  return { decision, reasons };
}

/**
 * Injectable constructor (mirrors createChatRouter/createExtractionRouter):
 * primary/fallback adapters passed in, so fail-safe and EN-083 bypass
 * behavior is FAST-testable without network calls.
 *
 * certifiedProviders: which provider(s) this phase's N=20 bank (EN-074/075)
 * has actually validated for gate judgment — only openai/gpt-5.6-terra by
 * default. A decision served by any other provider gets its gates
 * (curiosityTurn, attestation, EN-048's register — zen forced back to
 * natural, and this batch's ambientContext — real, billed API calls are
 * exactly the kind of consequence an uncertified tier's judgment
 * shouldn't authorize) forced to no-action (EN-083); retrieval mode is
 * not a gate in this sense (it has its own safe fallback already, and a
 * wrong retrieval mode degrades search quality, never fabricates an
 * authoritative event or spends real money) and is used as decided
 * either way.
 */
export function createIntentRouter(
  primary: RouterAdapter,
  fallback: RouterAdapter,
  certifiedProviders: ReadonlySet<"openai" | "gemini"> = new Set(["openai"]),
  costTracker?: CostTracker
): IntentRouter {
  return {
    async route(request: RouterRequest): Promise<RouterResult> {
      let raw;
      try {
        raw = await runWithFallback(primary, fallback, request);
      } catch (err) {
        const reason =
          err instanceof ClientRequestError
            ? `router call rejected as a malformed client request (never falls back — EN-083): ${err.message}`
            : `router call failed on both tiers: ${err instanceof Error ? err.message : String(err)}`;
        return { decision: SAFE_DEFAULT_DECISION, provider: null, model: null, certified: false, failureReason: reason };
      }
      costTracker?.record(raw);

      let decision: RouterDecision;
      let reasons: string[] = [];
      try {
        const validated = validateDecision(raw.decision, request);
        decision = validated.decision;
        reasons = validated.reasons;
      } catch (err) {
        return {
          decision: SAFE_DEFAULT_DECISION,
          provider: raw.provider,
          model: raw.model,
          certified: false,
          failureReason: `router returned malformed output: ${err instanceof Error ? err.message : String(err)}`
        };
      }

      const isCertified = certifiedProviders.has(raw.provider);
      if (
        !isCertified &&
        (decision.curiosityTurn.fire ||
          decision.attestation.isAffirmation ||
          decision.coReference.fire ||
          decision.register.mode === "zen" ||
          decision.ambientContext.relevant ||
          decision.travelContext.relevant)
      ) {
        reasons.push(`gates bypassed to no-action: decision served by uncertified tier "${raw.provider}" (EN-083)`);
        decision = {
          ...decision,
          curiosityTurn: { fire: false, kind: null, entityId: null, attribute: null, probeType: null },
          attestation: { isAffirmation: false, entityName: null, attribute: null, value: null },
          coReference: { fire: false, direction: null, pendingStableKey: null },
          register: { mode: "natural" },
          ambientContext: { relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null },
          travelContext: { relevant: false, destinationHint: null }
        };
      }

      return {
        decision,
        provider: raw.provider,
        model: raw.model,
        certified: isCertified && reasons.length === 0,
        failureReason: reasons.length > 0 ? reasons.join("; ") : null
      };
    }
  };
}

/** Production wiring (EN-081): OpenAI (gpt-5.6-terra) primary, Gemini (gemini-3.7-flash) fallback. */
export function createDefaultIntentRouter(apiKeys: { openai: string; gemini: string }, costTracker?: CostTracker): IntentRouter {
  const openai = createOpenAiRouterAdapter(apiKeys.openai);
  const gemini = createGeminiRouterAdapter(apiKeys.gemini);
  return createIntentRouter(openai, gemini, new Set(["openai"]), costTracker);
}
