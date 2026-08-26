import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { classifyProviderError } from "./errors.js";
import { buildExtractionSystemPrompt, TAXONOMY_JSON_SCHEMA } from "./taxonomySchema.js";
import type { ExtractionRequest, ExtractionTaxonomy, ProviderAdapter, ProviderCallResult } from "./types.js";

export const GEMINI_EXTRACTION_MODEL = "gemini-3.7-flash";

/**
 * Gemini adapter (EN-080/081/082). Verified live on 2026-08-21:
 * gemini-3.7-flash + responseSchema returns schema-conformant JSON.
 *
 * Cost note (EN-086), verified live: `thinkingConfig.thinkingBudget: 0` is
 * a no-op on this model generation — it still spent ~94 thought tokens on
 * a trivial prompt. Only `thinkingConfig.thinkingLevel: "low"` actually
 * reduces it (down to ~60 in the same test). Thinking tokens are billed at
 * the output rate, so this is a real, irreducible-below-"low" cost floor
 * per call, not a knob that goes to zero — budget accordingly.
 *
 * Also verified live: this model returned a genuine 503 "high demand" on
 * one attempt during Phase 2 verification — the exact reliability failure
 * mode EN-081's rationale for OpenAI-primary is built around, observed
 * directly rather than assumed.
 */
export function createGeminiAdapter(apiKey: string): ProviderAdapter {
  const client = new GoogleGenAI({ apiKey });

  return async function geminiExtract(request: ExtractionRequest): Promise<ProviderCallResult> {
    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_EXTRACTION_MODEL,
        contents: request.text,
        config: {
          systemInstruction: buildExtractionSystemPrompt(request.referenceDate ?? new Date().toISOString().slice(0, 10), request.knownPeopleNames ?? [], request.precedingReplyText),
          responseMimeType: "application/json",
          responseSchema: TAXONOMY_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    if (!response.text) {
      throw classifyProviderError(new Error("Gemini returned no text in the response"));
    }
    const taxonomy = JSON.parse(response.text) as ExtractionTaxonomy;

    return {
      provider: "gemini",
      model: GEMINI_EXTRACTION_MODEL,
      taxonomy,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        // Gemini bills thinking tokens at the output rate ("response
        // pricing is the sum of output tokens and thinking tokens" —
        // verified against ai.google.dev/gemini-api/docs/thinking), so both
        // must be included here or cost tracking silently undercounts.
        outputTokens:
          (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
        cachedInputTokens: 0
      }
    };
  };
}
