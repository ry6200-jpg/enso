import type { ChatCallResult } from "./chatTypes.js";
import { estimateCostUsd } from "./pricing.js";
import type { ProviderCallResult } from "./types.js";

/** record() only ever reads provider/model/usage — this union lets one tracker serve both extraction calls (ProviderCallResult) and chat replies (ChatCallResult) without either result type depending on the other. */
type CostableResult = ProviderCallResult | ChatCallResult;

export interface CostRecord {
  provider: "openai" | "gemini";
  model: string;
  inputTokens: number;
  outputTokens: number;
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
