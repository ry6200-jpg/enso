import OpenAI from "openai";
import { classifyProviderError } from "./errors.js";
import { buildExtractionSystemPrompt, TAXONOMY_JSON_SCHEMA } from "./taxonomySchema.js";
import type { ExtractionRequest, ExtractionTaxonomy, ProviderAdapter, ProviderCallResult } from "./types.js";

// EN-075 budget-tier validation: switched from "gpt-5.6-terra" to the
// cheapest configured OpenAI tier after the live N=20 bank
// (tests/validationBank.live.test.ts) passed all 8 assertion-guard
// extraction cases at >=19/20 on gpt-5.6-luna (280-call combined run,
// actual spend $0.2374). Unlike the router model (reverted to terra after
// failing the B1 circle-back case), extraction's judgment held up cleanly.
export const OPENAI_EXTRACTION_MODEL = "gpt-5.6-luna";

/**
 * OpenAI adapter (EN-080/081/082/EN-075). Structured Outputs (json_schema,
 * strict) verified live to return schema-conformant JSON on both
 * gpt-5.6-terra (2026-08-21) and gpt-5.6-luna (EN-075 bank, see above).
 * `reasoning.effort: "low"` keeps cost down for extraction, which needs
 * light judgment but not deep reasoning (EN-086) — verified live that
 * "none" is also available if this proves unnecessary once real usage
 * data exists.
 */
export function createOpenAiAdapter(apiKey: string): ProviderAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiExtract(request: ExtractionRequest): Promise<ProviderCallResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_EXTRACTION_MODEL,
        reasoning: { effort: "low" },
        instructions: buildExtractionSystemPrompt(request.referenceDate ?? new Date().toISOString().slice(0, 10), request.knownPeopleNames ?? [], request.precedingReplyText),
        input: request.text,
        text: {
          format: {
            type: "json_schema",
            name: "extraction_taxonomy",
            schema: TAXONOMY_JSON_SCHEMA,
            strict: true
          }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    const taxonomy = JSON.parse(response.output_text) as ExtractionTaxonomy;

    return {
      provider: "openai",
      model: OPENAI_EXTRACTION_MODEL,
      taxonomy,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0
      }
    };
  };
}
