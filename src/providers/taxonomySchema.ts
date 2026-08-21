/**
 * Shared JSON Schema for the extraction taxonomy (ExtractionTaxonomy in
 * types.ts), used to constrain both providers' structured-output modes.
 * OpenAI's Structured Outputs requires every property listed in `required`
 * and `additionalProperties: false` at every level — Gemini's schema
 * support is a looser subset of JSON Schema, but tolerates this shape too.
 */
export const TAXONOMY_JSON_SCHEMA = {
  type: "object",
  properties: {
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
    },
    statedFeelings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    episodeMarkers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["incident_reference", "boundary_start", "boundary_end"] },
          text: { type: "string" }
        },
        required: ["kind", "text"],
        additionalProperties: false
      }
    }
  },
  required: ["entities", "statedFeelings", "episodeMarkers"],
  additionalProperties: false
} as const;

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts from a personal journal entry. Follow these rules exactly:
- entities: every person mentioned by name (not the author/narrator). type is always "person".
- statedFeelings: only feelings the author explicitly states about themselves or others in their own words (e.g. "I was furious", "she seemed relieved"). Do not infer feelings that weren't stated.
- episodeMarkers: short markers for incidents or narrative boundaries — "incident_reference" for a specific event described, "boundary_start"/"boundary_end" only when the text explicitly signals an incident beginning or concluding.
If none apply for a category, return an empty array for it. Never invent facts not present in the text.`;
