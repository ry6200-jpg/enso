import OpenAI from "openai";
import { classifyProviderError } from "./errors.js";
import type { FabricationCheckInput, FabricationJudgeAdapter, FabricationLabel } from "../persona/fabricationCheck.js";

const DECOMPOSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    details: { type: "array", items: { type: "string" } }
  },
  required: ["details"],
  additionalProperties: false
} as const;

const CLASSIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: ["ENTAILED", "USER_STATED", "ADDED", "SOFT_ADDED"] },
    rationale: { type: "string" },
    offendingSpan: { type: ["string", "null"] }
  },
  required: ["label", "rationale", "offendingSpan"],
  additionalProperties: false
} as const;

function factsBlock(contextFacts: string[]): string {
  return contextFacts.length > 0 ? contextFacts.map((f) => `- ${f}`).join("\n") : "(no context facts were available for this turn)";
}

function buildDecomposeInstructions(input: FabricationCheckInput): string {
  return `You are auditing a reply for fabricated detail. You will be shown CONTEXT FACTS (the only things the reply-writer actually knew), the USER'S CURRENT MESSAGE, and the REPLY.

Extract every concrete detail the REPLY asserts about the user's world, history, or inner state. A detail embedded inside a question counts (e.g. a reply that asks "was it the fact that he looked different?" is asserting the candidate detail "he looked different," even though it's phrased as a question). Exclude generic statements that name no specific about this user -- ordinary warmth, generic advice, or a generic observation with no named specific is not a detail to extract.

Return each detail as a short, self-contained span of text (your own words are fine, but preserve the actual claim exactly -- never soften or embellish it beyond what the reply said).

CONTEXT FACTS:
${factsBlock(input.contextFacts)}

USER'S CURRENT MESSAGE: ${JSON.stringify(input.userTurn)}

REPLY: ${JSON.stringify(input.reply)}`;
}

function buildClassifyInstructions(input: FabricationCheckInput, detailSpan: string): string {
  return `You are auditing one specific detail from a reply for fabrication. You will be shown CONTEXT FACTS (the only things the reply-writer actually knew), the USER'S CURRENT MESSAGE, the REPLY, and the ONE DETAIL to classify.

Classify the detail into exactly one of:
- ENTAILED: the detail follows from a context fact with no addition (this includes a plain statement that something is not known/on record -- declining to state a fact adds nothing and is ENTAILED, never ADDED).
- USER_STATED: the detail is present in the user's own message this turn.
- ADDED: the detail is a specific present in neither the context facts nor the user's current message -- an invented location, physical detail, duration, cause, or an attributed feeling/motive for someone that nothing supports.
- SOFT_ADDED: the detail is added (same as ADDED), but the reply hedges it or offers it explicitly as one candidate among several, rather than asserting it as established fact.

You MUST name the offendingSpan (the exact words in the REPLY that add the unsupported specific) whenever the label is ADDED or SOFT_ADDED. Set offendingSpan to null for ENTAILED or USER_STATED.

CONTEXT FACTS:
${factsBlock(input.contextFacts)}

USER'S CURRENT MESSAGE: ${JSON.stringify(input.userTurn)}

REPLY: ${JSON.stringify(input.reply)}

DETAIL TO CLASSIFY: ${JSON.stringify(detailSpan)}`;
}

/**
 * Real OpenAI-backed judge adapter (EN-075 fabrication check). Structured
 * Outputs (json_schema, strict), same convention as the router/extraction
 * adapters. `reasoning.effort: "low"` matches those adapters' own
 * cost/latency note -- this is a judgment call, not deep reasoning.
 */
export function createOpenAiFabricationJudgeAdapter(apiKey: string, model: string): FabricationJudgeAdapter {
  const client = new OpenAI({ apiKey });

  return {
    async decompose(input: FabricationCheckInput): Promise<string[]> {
      let response;
      try {
        response = await client.responses.create({
          model,
          reasoning: { effort: "low" },
          instructions: buildDecomposeInstructions(input),
          input: "Extract the details.",
          text: { format: { type: "json_schema", name: "fabrication_decompose", schema: DECOMPOSE_JSON_SCHEMA, strict: true } }
        });
      } catch (err) {
        throw classifyProviderError(err);
      }
      const parsed = JSON.parse(response.output_text) as { details: string[] };
      return parsed.details;
    },

    async classify(input: FabricationCheckInput, detailSpan: string): Promise<{ label: FabricationLabel; rationale: string; offendingSpan: string | null }> {
      let response;
      try {
        response = await client.responses.create({
          model,
          reasoning: { effort: "low" },
          instructions: buildClassifyInstructions(input, detailSpan),
          input: "Classify the detail.",
          text: { format: { type: "json_schema", name: "fabrication_classify", schema: CLASSIFY_JSON_SCHEMA, strict: true } }
        });
      } catch (err) {
        throw classifyProviderError(err);
      }
      return JSON.parse(response.output_text) as { label: FabricationLabel; rationale: string; offendingSpan: string | null };
    }
  };
}
