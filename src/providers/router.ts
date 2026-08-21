import type { CostTracker } from "./costTracker.js";
import { BothTiersFailedError, ClientRequestError } from "./errors.js";
import { createGeminiAdapter } from "./geminiAdapter.js";
import { createOpenAiAdapter } from "./openaiAdapter.js";
import type { ExtractionKind, ExtractionRequest, ProviderAdapter, ProviderCallResult } from "./types.js";

export interface RouterTierConfig {
  primary: ProviderAdapter;
  fallback: ProviderAdapter;
}

export interface ExtractionRouter {
  extract(request: ExtractionRequest): Promise<ProviderCallResult>;
}

/**
 * EN-081/083 routing and fallback, exactly: one tier per ExtractionKind, one
 * unconditional retry on the fallback tier for availability errors only.
 * A ClientRequestError from the primary is re-thrown immediately without
 * touching the fallback — EN-083's "who is Sarah?" lesson: a malformed
 * request fails identically on any provider, so burning the fallback on it
 * wastes a call and hides the real bug.
 *
 * This is the fallback layer only. Retry-with-backoff on a single tier
 * (EN-059) is the extraction orchestrator's job (Part 4), wrapping calls to
 * `extract` — client errors here should never be retried by that loop
 * either, since they're re-thrown as ClientRequestError specifically so the
 * caller can tell the two failure modes apart.
 */
export function createExtractionRouter(
  config: Record<ExtractionKind, RouterTierConfig>,
  costTracker?: CostTracker
): ExtractionRouter {
  async function extract(request: ExtractionRequest): Promise<ProviderCallResult> {
    const tiers = config[request.kind];

    try {
      const result = await tiers.primary(request);
      costTracker?.record(result);
      return result;
    } catch (primaryErr) {
      if (primaryErr instanceof ClientRequestError) {
        throw primaryErr;
      }
      try {
        const result = await tiers.fallback(request);
        costTracker?.record(result);
        return result;
      } catch (fallbackErr) {
        const primary = primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr));
        const fallback = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
        throw new BothTiersFailedError(primary, fallback);
      }
    }
  }

  return { extract };
}

/**
 * Production wiring (EN-081): OpenAI primary / Gemini fallback for ordinary
 * messages; Gemini primary / OpenAI fallback for large documents, where
 * Gemini's long context is the advantage.
 */
export function createDefaultRouter(
  apiKeys: { openai: string; gemini: string },
  costTracker?: CostTracker
): ExtractionRouter {
  const openai = createOpenAiAdapter(apiKeys.openai);
  const gemini = createGeminiAdapter(apiKeys.gemini);

  return createExtractionRouter(
    {
      message: { primary: openai, fallback: gemini },
      document: { primary: gemini, fallback: openai }
    },
    costTracker
  );
}
