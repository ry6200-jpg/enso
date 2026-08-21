import type { CostTracker } from "./costTracker.js";
import { runWithFallback } from "./fallback.js";
import { createGeminiDocumentAdapter, createOpenAiDocumentAdapter } from "./documentAdapter.js";
import { createGeminiImageAdapter, createOpenAiImageAdapter } from "./imageAdapter.js";
import type {
  DocumentContentAdapter,
  DocumentContentRequest,
  DocumentContentResult,
  ImageContentAdapter,
  ImageContentRequest,
  ImageContentResult
} from "./attachmentTypes.js";
function recordAttachmentCost(
  costTracker: CostTracker | undefined,
  result: { provider: "openai" | "gemini"; model: string; usage: { inputTokens: number; outputTokens: number } }
) {
  if (!costTracker) return;
  // Attachment adapters return fullText/description rather than a taxonomy;
  // CostTracker.record only needs provider/model/usage to price the call,
  // so an empty taxonomy stand-in is enough to reuse it here.
  costTracker.record({
    provider: result.provider,
    model: result.model,
    taxonomy: { entities: [], statedFeelings: [], episodeMarkers: [], structuralAtoms: [], socialBonds: [] },
    usage: result.usage
  });
}

/**
 * Document content router (EN-081): Gemini primary (long-context advantage
 * for large documents), OpenAI fallback. Same EN-083 fallback semantics as
 * the taxonomy router, via the same runWithFallback helper.
 */
export function createDocumentRouter(
  apiKeys: { openai: string; gemini: string },
  costTracker?: CostTracker
): { extract: DocumentContentAdapter } {
  const openai = createOpenAiDocumentAdapter(apiKeys.openai);
  const gemini = createGeminiDocumentAdapter(apiKeys.gemini);

  return {
    extract: async (request: DocumentContentRequest): Promise<DocumentContentResult> => {
      const result = await runWithFallback(gemini, openai, request);
      recordAttachmentCost(costTracker, result);
      return result;
    }
  };
}

/**
 * Image description router: OpenAI primary (cheap at low detail for
 * ordinary photos), Gemini fallback.
 */
export function createImageRouter(
  apiKeys: { openai: string; gemini: string },
  costTracker?: CostTracker
): { extract: ImageContentAdapter } {
  const openai = createOpenAiImageAdapter(apiKeys.openai);
  const gemini = createGeminiImageAdapter(apiKeys.gemini);

  return {
    extract: async (request: ImageContentRequest): Promise<ImageContentResult> => {
      const result = await runWithFallback(openai, gemini, request);
      recordAttachmentCost(costTracker, result);
      return result;
    }
  };
}
