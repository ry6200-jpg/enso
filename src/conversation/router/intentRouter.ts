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

  if (decision.circleBack.fire) {
    const known = request.circleBackCandidates.some((c) => c.entityId === decision.circleBack.entityId);
    if (!known) {
      reasons.push(`circleBack.entityId ${JSON.stringify(decision.circleBack.entityId)} is not an eligible candidate — suppressed`);
      decision.circleBack = { fire: false, entityId: null };
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
 * (circleBack, attestation, and EN-048's register — zen forced back to
 * natural, the same no-action treatment as the other two) forced to
 * no-action (EN-083); retrieval mode is not a gate in this sense (it has
 * its own safe fallback already, and a wrong retrieval mode degrades
 * search quality, never fabricates an
 * authoritative event) and is used as decided either way.
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
      if (!isCertified && (decision.circleBack.fire || decision.attestation.isAffirmation || decision.register.mode === "zen")) {
        reasons.push(`gates bypassed to no-action: decision served by uncertified tier "${raw.provider}" (EN-083)`);
        decision = {
          ...decision,
          circleBack: { fire: false, entityId: null },
          attestation: { isAffirmation: false, entityName: null, attribute: null, value: null },
          register: { mode: "natural" }
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
