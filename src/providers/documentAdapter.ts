import OpenAI from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { DOCUMENT_EXTRACTION_JSON_SCHEMA, DOCUMENT_EXTRACTION_PROMPT } from "./attachmentSchemas.js";
import type { DocumentContentAdapter, DocumentContentResult } from "./attachmentTypes.js";
import { classifyProviderError } from "./errors.js";

export const OPENAI_DOCUMENT_MODEL = "gpt-5.6-terra";
export const GEMINI_DOCUMENT_MODEL = "gemini-3.7-flash";

interface DocumentExtractionOutput {
  fullText: string;
  entities: { name: string; type: "person" }[];
}

/** Verified live 2026-08-21: input_file + data: URI, combined with strict json_schema output. */
export function createOpenAiDocumentAdapter(apiKey: string): DocumentContentAdapter {
  const client = new OpenAI({ apiKey });

  return async function openAiExtractDocument(request): Promise<DocumentContentResult> {
    let response;
    try {
      response = await client.responses.create({
        model: OPENAI_DOCUMENT_MODEL,
        reasoning: { effort: "low" },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: DOCUMENT_EXTRACTION_PROMPT },
              {
                type: "input_file",
                filename: request.filename,
                file_data: `data:${request.mimeType};base64,${request.bytes.toString("base64")}`
              }
            ]
          }
        ],
        text: {
          format: { type: "json_schema", name: "document_extraction", schema: DOCUMENT_EXTRACTION_JSON_SCHEMA, strict: true }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    const output = JSON.parse(response.output_text) as DocumentExtractionOutput;
    return {
      provider: "openai",
      model: OPENAI_DOCUMENT_MODEL,
      fullText: output.fullText,
      entities: output.entities,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0
      }
    };
  };
}

/** Verified live 2026-08-21: inlineData (base64) + responseSchema. */
export function createGeminiDocumentAdapter(apiKey: string): DocumentContentAdapter {
  const client = new GoogleGenAI({ apiKey });

  return async function geminiExtractDocument(request): Promise<DocumentContentResult> {
    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_DOCUMENT_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { text: DOCUMENT_EXTRACTION_PROMPT },
              { inlineData: { mimeType: request.mimeType, data: request.bytes.toString("base64") } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: DOCUMENT_EXTRACTION_JSON_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    if (!response.text) {
      throw classifyProviderError(new Error("Gemini returned no text for document extraction"));
    }
    const output = JSON.parse(response.text) as DocumentExtractionOutput;
    return {
      provider: "gemini",
      model: GEMINI_DOCUMENT_MODEL,
      fullText: output.fullText,
      entities: output.entities,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0)
      }
    };
  };
}
