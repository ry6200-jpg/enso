import type { ChatCallResult } from "./chatTypes.js";
import { estimateCostUsd } from "./pricing.js";
import type { ProviderCallResult, TokenUsage } from "./types.js";

/** record() only ever reads provider/model/usage — a minimal structural shape lets one tracker serve extraction calls, chat replies, and router decisions alike without any of those result types depending on each other. */
type CostableResult = ProviderCallResult | ChatCallResult | { provider: "openai" | "gemini"; model: string; usage: TokenUsage };

export interface CostRecord {
  provider: "openai" | "gemini";
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * How many of inputTokens OpenAI actually served from its prompt cache —
   * read from response.usage.input_tokens_details.cached_tokens, always 0
   * for Gemini (no equivalent field). Not currently used by costUsd below
   * — estimateCostUsd still charges every input token at the flat,
   * uncached rate (pricing.ts has no discounted cached-token tier defined
   * or verified yet), so costUsd remains a real overestimate whenever
   * caching is active. Left that way deliberately: applying a discount
   * rate would need the actual cached-input pricing verified live first
   * (EN-082 discipline — never assumed from memory), which is a separate
   * decision from capturing the raw figure this field exists to make
   * possible.
   */
  cachedInputTokens: number;
  costUsd: number;
  recordedAt: string;
}

/**
 * Basic per-call cost tracking (EN-086). In-memory ledger is enough for
 * Phase 2 — this is infrastructure to make spend visible (per the live
 * verification requirement "report total API spend"), not a budgeting
 * system with alerts, which is a later concern.
 */
export class CostTracker {
  private readonly records: CostRecord[] = [];

  record(result: CostableResult): CostRecord {
    const entry: CostRecord = {
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      costUsd: estimateCostUsd(result.model, result.usage.inputTokens, result.usage.outputTokens),
      recordedAt: new Date().toISOString()
    };
    this.records.push(entry);
    return entry;
  }

  totalUsd(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  all(): readonly CostRecord[] {
    return this.records;
  }
}
