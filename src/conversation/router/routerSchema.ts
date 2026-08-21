import type { RouterRequest } from "./routerTypes.js";

/** Structured-output JSON Schema for the router call — same strict-mode shape as taxonomySchema.ts's TAXONOMY_JSON_SCHEMA (every property required, additionalProperties false at every level). */
export const ROUTER_JSON_SCHEMA = {
  type: "object",
  properties: {
    retrieval: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["hybrid", "entity", "recency"] },
        entityId: { type: ["string", "null"] },
        temporalWeight: { type: "number" },
        n: { type: ["number", "null"] }
      },
      required: ["mode", "entityId", "temporalWeight", "n"],
      additionalProperties: false
    },
    circleBack: {
      type: "object",
      properties: {
        fire: { type: "boolean" },
        entityId: { type: ["string", "null"] }
      },
      required: ["fire", "entityId"],
      additionalProperties: false
    },
    attestation: {
      type: "object",
      properties: {
        isAffirmation: { type: "boolean" },
        entityName: { type: ["string", "null"] },
        attribute: { type: ["string", "null"], enum: ["birthdate", "location", "occupation", null] },
        value: { type: ["string", "null"] }
      },
      required: ["isAffirmation", "entityName", "attribute", "value"],
      additionalProperties: false
    }
  },
  required: ["retrieval", "circleBack", "attestation"],
  additionalProperties: false
} as const;

/**
 * Builds the router's system prompt. All three judgment axes in one call
 * (EN-075: latency/cost over three separate calls) — each section names
 * its own hard constraints so a strict-schema-compliant but semantically
 * wrong answer (e.g. an invented entityId) is still caught by the caller's
 * post-call validation against the candidate lists actually handed in.
 */
export function buildRouterSystemPrompt(request: RouterRequest): string {
  const knownEntitiesBlock =
    request.knownEntities.length > 0
      ? request.knownEntities.map((e) => `- ${e.name} (id: ${e.entityId})`).join("\n")
      : "(none on record yet)";
  const circleBackBlock =
    request.circleBackCandidates.length > 0
      ? request.circleBackCandidates
          .map((c) => `- ${c.name} (id: ${c.entityId}) — attempt ${c.attemptNumber}${c.attemptNumber === 2 ? `, first asked ${c.mentionAgeLabel} and unanswered; this would be the final attempt` : ""}`)
          .join("\n")
      : "(no eligible candidates this turn)";
  const claimsBlock =
    request.recentAttributeClaims.length > 0
      ? request.recentAttributeClaims.map((c) => `- ${c.entityName}'s ${c.attribute}: "${c.value}" (extraction event: ${c.extractionEventId})`).join("\n")
      : "(nothing recently surfaced that could be confirmed)";
  const recentWindowBlock =
    request.recentTurns.length > 0
      ? request.recentTurns.map((t) => `${t.role === "user" ? "Owner" : "Enso"}: ${t.text}`).join("\n")
      : "(first message of the conversation)";

  return `You are a routing judgment layer for a personal journaling assistant, deciding three things about the CURRENT user message below. Return ONLY the JSON the schema requires — no prose.

CURRENT MESSAGE: ${JSON.stringify(request.message)}

RECENT CONVERSATION (for context only):
${recentWindowBlock}

1. RETRIEVAL — how should the assistant search the owner's own history to answer this turn?
- mode "recency": the message asks to read back/recap recent messages generically, with no specific topic ("what have we talked about," "catch me up"). n is how many recent messages (10 is a reasonable default); entityId is null; temporalWeight is 0.
- mode "entity": the message clearly refers to ONE specific person already on record below (by name OR by a role/kinship term that resolves to exactly one of them, e.g. "my mom" when only one mother-figure is on record) — entityId MUST be one of the ids listed below, never invented, never a person not in this list. n is null.
- mode "hybrid" (the default): everything else — semantic + keyword search. entityId and n are null.
- temporalWeight: 1 if the message emphasizes recency ("lately," "these days," "recently"), -1 if it emphasizes the earliest/first instance of something ("the first time," "originally"), 0 otherwise.

People already on record (for entity-mode retrieval ONLY — entityId must come from here or be null):
${knownEntitiesBlock}

2. CIRCLE-BACK — should this reply also gently ask who one of the people below is? Only ever fire on an id from the exact candidate list (never invent one, never fire on someone not listed). DEFAULT TO FIRING whenever the list below is non-empty and the current message is an ordinary, low-stakes moment — a routine update, a plan, small talk, anything without real emotional weight: that is exactly the right kind of turn to slip in a brief, natural "by the way, who's [name]?", and it is the common, EXPECTED outcome when a candidate is eligible, not a rare exception to reach for cautiously. Only decline (fire=false) when firing would genuinely be bad timing: the CURRENT message is itself a direct question that needs a real answer, or the user is sharing something emotionally weighty that a circle-back would interrupt or trivialize. If the candidate list below is empty, fire is always false — there's nothing to ask about.

Circle-back-eligible candidates this turn (already filtered by cooldown/attempt limits — you only ever pick ONE of these, or none):
${circleBackBlock}

3. ATTESTATION — is the CURRENT message the owner EXPLICITLY affirming one specific value listed below as correct (e.g. "yes, that's right," "May 12 exactly")? A bare continuer ("yeah," "ok," "mm," "sure," "sounds right" with no specific value re-addressed) is NEVER an affirmation — isAffirmation must be false for those. It must also be false if the message corrects or contradicts the value, or addresses something not in this list at all. Only set isAffirmation true when the message specifically and unambiguously affirms one of these exact values; entityName/attribute/value must then exactly match one entry below (copy it verbatim), never a paraphrase.

Recently surfaced claims this turn could affirm:
${claimsBlock}
`;
}
