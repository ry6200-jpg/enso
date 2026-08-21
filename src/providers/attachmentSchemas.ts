/**
 * Structured-output schemas for attachment content extraction (EN-062),
 * verified live against both providers combined with real file/image input
 * on 2026-08-21. Documents get a combined call (full text + entity
 * taxonomy) rather than two separate calls — full text is mandatory
 * regardless of the classifier (EN-060/061), and combining avoids doubling
 * API cost for every upload.
 */
export const DOCUMENT_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    fullText: { type: "string" },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["person"] }
        },
        required: ["name", "type"],
        additionalProperties: false
      }
    }
  },
  required: ["fullText", "entities"],
  additionalProperties: false
} as const;

export const DOCUMENT_EXTRACTION_PROMPT =
  "Transcribe the COMPLETE text of this document verbatim into fullText — every page, in order, " +
  "preserving line breaks between pages with a blank line. Do not summarize, paraphrase, or omit " +
  "any content. Separately, list every named person mentioned in entities.";

export const IMAGE_DESCRIPTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" }
  },
  required: ["description"],
  additionalProperties: false
} as const;

export const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image in 1-3 sentences: what it shows, any visible people (without guessing identity), " +
  "setting, and notable details. This description will stand in for the image in a personal journal search index.";
