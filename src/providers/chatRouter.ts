import type { ChatAdapter, ChatCallResult, ChatRequest } from "./chatTypes.js";
import { createGeminiChatAdapter, createOpenAiChatAdapter } from "./chatAdapters.js";
import type { CostTracker } from "./costTracker.js";
import { runWithFallback } from "./fallback.js";

export interface ChatRouter {
  reply(request: ChatRequest): Promise<ChatCallResult>;
}

/**
 * The chat-reply counterpart to createExtractionRouter (EN-081/083):
 * adapters injected rather than constructed inside, mirroring router.ts's
 * split between the generic/testable constructor and its production wiring
 * below — without this split, fallback semantics (unconditional retry on
 * availability errors, no retry on client errors) could only be exercised
 * against real network calls.
 */
export function createChatRouter(primary: ChatAdapter, fallback: ChatAdapter, costTracker?: CostTracker): ChatRouter {
  return {
    async reply(request: ChatRequest): Promise<ChatCallResult> {
      const result = await runWithFallback(primary, fallback, request);
      costTracker?.record(result);
      return result;
    }
  };
}

/**
 * Production wiring (EN-081): OpenAI (gpt-5.6-sol) primary, Gemini
 * (gemini-3.7-flash) fallback.
 */
export function createDefaultChatRouter(apiKeys: { openai: string; gemini: string }, costTracker?: CostTracker): ChatRouter {
  const openai = createOpenAiChatAdapter(apiKeys.openai);
  const gemini = createGeminiChatAdapter(apiKeys.gemini);
  return createChatRouter(openai, gemini, costTracker);
}
