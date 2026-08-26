import OpenAI from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { IMAGE_DESCRIPTION_JSON_SCHEMA, IMAGE_DESCRIPTION_PROMPT } from "./attachmentSchemas.js";
import type { ImageContentAdapter, ImageContentResult } from "./attachmentTypes.js";
import { classifyProviderError } from "./errors.js";

export const OPENAI_IMAGE_MODEL = "gpt-5.6-terra";
export const GEMINI_IMAGE_MODEL = "gemini-3.7-flash";

interface ImageDescriptionOutput {
  description: string;
}

/**
 * Verified live 2026-08-21: input_image + data: URI, combined with strict
 * json_schema output. Cost note (EN-086): `detail: "low"` keeps images
 * cheap (~15 input tokens observed vs Gemini's ~1089-token floor for the
 * same image), but on a degenerate 1x1-pixel test image it occasionally
 * (1 of 4 live attempts) claimed no image was visible rather than
 * describing it — genuine model uncertainty at the extreme low end, not a
 * request-shape bug (retrying the identical request succeeded). Real
 * uploads won't be 1x1 pixels; noted here since it's exactly the kind of
 * live finding EN-082 exists to surface rather than assume away.
 */
export function createOpenAiImageAdapter(apiKey: string): ImageContentAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiDescribeImage(request): Promise<ImageContentResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_IMAGE_MODEL,
        reasoning: { effort: "low" },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: IMAGE_DESCRIPTION_PROMPT },
              {
                type: "input_image",
                image_url: `data:${request.mimeType};base64,${request.bytes.toString("base64")}`,
                detail: "low"
              }
            ]
          }
        ],
        text: {
          format: { type: "json_schema", name: "image_description", schema: IMAGE_DESCRIPTION_JSON_SCHEMA, strict: true }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    const output = JSON.parse(response.output_text) as ImageDescriptionOutput;
    return {
      provider: "openai",
      model: OPENAI_IMAGE_MODEL,
      description: output.description,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0
      }
    };
  };
}

/** Verified live 2026-08-21: inlineData (base64) + responseSchema. */
export function createGeminiImageAdapter(apiKey: string): ImageContentAdapter {
  const client = new GoogleGenAI({ apiKey });

  return async function geminiDescribeImage(request): Promise<ImageContentResult> {
    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { text: IMAGE_DESCRIPTION_PROMPT },
              { inlineData: { mimeType: request.mimeType, data: request.bytes.toString("base64") } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: IMAGE_DESCRIPTION_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    if (!response.text) {
      throw classifyProviderError(new Error("Gemini returned no text for image description"));
    }
    const output = JSON.parse(response.text) as ImageDescriptionOutput;
    return {
      provider: "gemini",
      model: GEMINI_IMAGE_MODEL,
      description: output.description,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
        cachedInputTokens: 0
      }
    };
  };
}
