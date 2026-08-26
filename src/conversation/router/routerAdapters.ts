import OpenAI from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { classifyProviderError } from "../../providers/errors.js";
import { ROUTER_JSON_SCHEMA, buildRouterSystemPrompt } from "./routerSchema.js";
import type { RouterCallResult, RouterDecision, RouterRequest } from "./routerTypes.js";

export const OPENAI_ROUTER_MODEL = "gpt-5.6-terra";
export const GEMINI_ROUTER_MODEL = "gemini-3.7-flash";

export type RouterAdapter = (request: RouterRequest) => Promise<RouterCallResult>;

/**
 * OpenAI router adapter (EN-074/075/080): gpt-5.6-terra — the same
 * mid-tier model already used for extraction, reused here rather than a
 * third model tier, and the tier this phase's N=20 bank certifies.
 * `reasoning.effort: "low"` mirrors the extraction adapter's cost note
 * (EN-086): light judgment, not deep reasoning, for a routing decision.
 */
export function createOpenAiRouterAdapter(apiKey: string): RouterAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiRoute(request: RouterRequest): Promise<RouterCallResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_ROUTER_MODEL,
        reasoning: { effort: "low" },
        instructions: buildRouterSystemPrompt(request),
        input: "Decide.",
        text: {
          format: {
            type: "json_schema",
            name: "router_decision",
            schema: ROUTER_JSON_SCHEMA,
            strict: true
          }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    const decision = JSON.parse(response.output_text) as RouterDecision;
    return {
      provider: "openai",
      model: OPENAI_ROUTER_MODEL,
      decision,
      usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0 }
    };
  };
}

/** Gemini router adapter (EN-074/075/080/081): gemini-3.7-flash fallback tier, same model already used as the chat/extraction fallback. */
export function createGeminiRouterAdapter(apiKey: string): RouterAdapter {
  const client = new GoogleGenAI({ apiKey });

  return async function geminiRoute(request: RouterRequest): Promise<RouterCallResult> {
    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_ROUTER_MODEL,
        contents: "Decide.",
        config: {
          systemInstruction: buildRouterSystemPrompt(request),
          responseMimeType: "application/json",
          responseSchema: ROUTER_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    if (!response.text) {
      throw classifyProviderError(new Error("Gemini returned no text in the router response"));
    }
    const decision = JSON.parse(response.text) as RouterDecision;
    return {
      provider: "gemini",
      model: GEMINI_ROUTER_MODEL,
      decision,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
        cachedInputTokens: 0
      }
    };
  };
}
