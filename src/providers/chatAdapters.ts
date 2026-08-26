import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import type { ChatAdapter, ChatCallResult, ChatRequest } from "./chatTypes.js";
import { classifyProviderError } from "./errors.js";

export const OPENAI_CHAT_MODEL = "gpt-5.6-sol";
export const GEMINI_CHAT_MODEL = "gemini-3.7-flash";

/**
 * OpenAI chat adapter (EN-081/082) — gpt-5.6-sol, OpenAI's top conversational
 * tier (verified live against developers.openai.com/api/docs/models on
 * 2026-08-21: "frontier model for complex professional work," $5/$30 per M —
 * see pricing.ts), not gpt-5.6-terra (the extraction adapter's model):
 * persona/voice quality is the entire point of this call, where extraction's
 * structured-output correctness is not. Free-text output, no schema.
 */
export function createOpenAiChatAdapter(apiKey: string): ChatAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiChat(request: ChatRequest): Promise<ChatCallResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_CHAT_MODEL,
        instructions: request.system,
        input: [
          ...request.history.map((turn) => ({
            role: (turn.role === "user" ? "user" : "assistant") as "user" | "assistant",
            content: turn.text
          })),
          { role: "user" as const, content: request.latestMessage }
        ]
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    return {
      provider: "openai",
      model: OPENAI_CHAT_MODEL,
      text: response.output_text,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0
      }
    };
  };
}

/**
 * Gemini chat adapter (EN-081/082) — gemini-3.7-flash, the same model
 * already verified live as the extraction fallback tier (see
 * geminiAdapter.ts's cost/reliability notes, which apply identically here).
 * Free-text output, no responseSchema.
 */
export function createGeminiChatAdapter(apiKey: string): ChatAdapter {
  const client = new GoogleGenAI({ apiKey });

  return async function geminiChat(request: ChatRequest): Promise<ChatCallResult> {
    const contents = [
      ...request.history.map((turn) => ({
        role: turn.role === "user" ? ("user" as const) : ("model" as const),
        parts: [{ text: turn.text }]
      })),
      { role: "user" as const, parts: [{ text: request.latestMessage }] }
    ];

    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_CHAT_MODEL,
        contents,
        config: {
          systemInstruction: request.system,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    if (!response.text) {
      throw classifyProviderError(new Error("Gemini returned no text in the response"));
    }

    return {
      provider: "gemini",
      model: GEMINI_CHAT_MODEL,
      text: response.text,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
        // No prompt-caching field in Gemini's usageMetadata shape — always a real 0, never estimated.
        cachedInputTokens: 0
      }
    };
  };
}
