import OpenAI from "openai";
import { classifyProviderError } from "./errors.js";
import { EXTRACTION_SYSTEM_PROMPT, TAXONOMY_JSON_SCHEMA } from "./taxonomySchema.js";
import type { ExtractionRequest, ExtractionTaxonomy, ProviderAdapter, ProviderCallResult } from "./types.js";

export const OPENAI_EXTRACTION_MODEL = "gpt-5.6-terra";

/**
 * OpenAI adapter (EN-080/081/082). Verified live against the Responses API
 * on 2026-08-21: gpt-5.6-terra + Structured Outputs (json_schema, strict)
 * returns schema-conformant JSON. `reasoning.effort: "low"` keeps cost down
 * for extraction, which needs light judgment but not deep reasoning
 * (EN-086) — verified live that "none" is also available if this proves
 * unnecessary once real usage data exists.
 */
export function createOpenAiAdapter(apiKey: string): ProviderAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiExtract(request: ExtractionRequest): Promise<ProviderCallResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_EXTRACTION_MODEL,
        reasoning: { effort: "low" },
        instructions: EXTRACTION_SYSTEM_PROMPT,
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
        outputTokens: response.usage?.output_tokens ?? 0
      }
    };
  };
}
