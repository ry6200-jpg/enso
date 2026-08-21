import type { TokenUsage } from "./types.js";

/**
 * Provider-agnostic chat-reply interface (EN-020 through EN-046 need real
 * conversational text back, not the extraction taxonomy ExtractionRequest/
 * ProviderAdapter above is shaped for) — a deliberately separate type from
 * ExtractionRequest/ProviderCallResult rather than overloading them, since a
 * reply has no taxonomy and extraction has no conversation history.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatRequest {
  /** The static persona block + retrieved-memory block + recent window (EN-035/040). */
  system: string;
  /** Prior turns NOT already folded into `system`'s recent-window block — kept empty for Phase 5's single-window design; present so a provider-native "messages" shape is available without an interface change later. */
  history: ChatTurn[];
  /** The user's current message. */
  latestMessage: string;
}

export interface ChatCallResult {
  provider: "openai" | "gemini";
  model: string;
  text: string;
  usage: TokenUsage;
}

export type ChatAdapter = (request: ChatRequest) => Promise<ChatCallResult>;
