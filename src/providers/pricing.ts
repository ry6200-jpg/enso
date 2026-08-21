/**
 * Pricing verified live against official docs on 2026-08-21 (EN-082) —
 * developers.openai.com/api/docs/models and ai.google.dev/gemini-api/docs/pricing.
 * Re-verify before trusting these numbers in a later session; prices change
 * quarter to quarter and this file pins today's answer, not a fact.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "gpt-5.6-terra": { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "gemini-3.7-flash": { inputPerMillion: 0.75, outputPerMillion: 3.75 }
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) {
    throw new Error(`No pricing entry for model "${model}" — add one to PRICING before using it.`);
  }
  return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}
