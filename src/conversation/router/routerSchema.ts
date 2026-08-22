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
    curiosityTurn: {
      type: "object",
      properties: {
        fire: { type: "boolean" },
        kind: { type: ["string", "null"], enum: ["selfFact", "thirdParty", "connectDot", null] },
        entityId: { type: ["string", "null"] },
        attribute: { type: ["string", "null"], enum: ["location", "occupation", null] }
      },
      required: ["fire", "kind", "entityId", "attribute"],
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
    },
    register: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["natural", "zen"] }
      },
      required: ["mode"],
      additionalProperties: false
    }
  },
  required: ["retrieval", "curiosityTurn", "attestation", "register"],
  additionalProperties: false
} as const;

/**
 * Builds the router's system prompt. All four judgment axes in one call
 * (EN-075: latency/cost over separate calls — EN-048 added the fourth,
 * register, at zero extra API cost since it's just one more property on
 * the same structured-output call) — each section names its own hard
 * constraints so a strict-schema-compliant but semantically wrong answer
 * (e.g. an invented entityId) is still caught by the caller's post-call
 * validation against the candidate lists actually handed in.
 */
export function buildRouterSystemPrompt(request: RouterRequest): string {
  const knownEntitiesBlock =
    request.knownEntities.length > 0
      ? request.knownEntities.map((e) => `- ${e.name} (id: ${e.entityId})`).join("\n")
      : "(none on record yet)";
  const curiosityCandidatesBlock =
    request.curiosityCandidates.length > 0
      ? request.curiosityCandidates
          .map((c) =>
            c.kind === "selfFact"
              ? `- [selfFact] attribute="${c.attribute}" — you don't have the owner's ${c.attribute} on record yet`
              : `- [thirdParty] ${c.candidate.name} (id: ${c.candidate.entityId}) — attempt ${c.candidate.attemptNumber}${c.candidate.attemptNumber === 2 ? `, first asked ${c.candidate.mentionAgeLabel} and unanswered; this would be the final attempt` : ""}`
          )
          .join("\n")
      : "(no eligible ask-candidates this turn)";
  const claimsBlock =
    request.recentAttributeClaims.length > 0
      ? request.recentAttributeClaims.map((c) => `- ${c.entityName}'s ${c.attribute}: "${c.value}" (extraction event: ${c.extractionEventId})`).join("\n")
      : "(nothing recently surfaced that could be confirmed)";
  const recentWindowBlock =
    request.recentTurns.length > 0
      ? request.recentTurns.map((t) => `${t.role === "user" ? "Owner" : "Enso"}: ${t.text}`).join("\n")
      : "(first message of the conversation)";

  return `You are a routing judgment layer for a personal journaling assistant, deciding four things about the CURRENT user message below. Return ONLY the JSON the schema requires — no prose.

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

2. CURIOSITY TURN — should this reply proactively take a turn, either by asking about ONE specific missing piece of information or by connecting an observation across what you already know? This is never about filling silence with a generic question — only fire when there is genuine, specific content below to offer.

curiosityTurnEligible this turn: ${request.curiosityTurnEligible ? "true" : "false"}. If this is false, fire MUST be false and kind MUST be null, no matter what you notice — the timing itself has already been screened out in code (your own last reply left something open, or recent turns show the person winding down rather than staying engaged), and nothing below can override that.

Ask-candidates this turn (already filtered by cooldown/attempt limits and priority — you only ever pick ONE, or none):
${curiosityCandidatesBlock}
- kind="selfFact": attribute MUST exactly match one tagged [selfFact] above.
- kind="thirdParty": entityId MUST exactly match one tagged [thirdParty] above.

You may instead choose kind="connectDot" (entityId and attribute both null) when curiosityTurnEligible is true and making a connecting observation — noticing a real pattern from what you already know about this person — would serve this moment better than asking something new. Only choose this when a genuine pattern actually exists; never invent one to fill the slot.

If curiosityTurnEligible is true but the ask-candidate list above is empty AND no genuine connecting observation exists, fire MUST still be false — there is nothing to say yet, and that is the correct outcome, not a gap to paper over. Separately, even when otherwise eligible, decline (fire=false) if the CURRENT message is itself a direct question needing a real answer, or shares something emotionally weighty enough that even a brief aside would interrupt or trivialize it.

3. ATTESTATION — is the CURRENT message the owner EXPLICITLY affirming one specific value listed below as correct (e.g. "yes, that's right," "May 12 exactly")? A bare continuer ("yeah," "ok," "mm," "sure," "sounds right" with no specific value re-addressed) is NEVER an affirmation — isAffirmation must be false for those. It must also be false if the message corrects or contradicts the value, or addresses something not in this list at all. Only set isAffirmation true when the message specifically and unambiguously affirms one of these exact values; entityName/attribute/value must then exactly match one entry below (copy it verbatim), never a paraphrase.

Recently surfaced claims this turn could affirm:
${claimsBlock}

4. REGISTER — should the reply use the quieter, more restrained "zen" register instead of the ordinary conversational one? Default to "natural" — this is the overwhelming majority case. Choose "zen" only when the CURRENT message shows genuine overwhelm, the owner visibly looping on the same problem without new ground being covered across recent turns, or an explicit ask to zoom out or step back — judge this from the actual content and tone of the message and recent conversation, not from whether it contains a specific trigger word: someone genuinely overwhelmed frequently does NOT use that word at all. Do not choose "zen" for an ordinary emotional moment that a warm, plain reply already handles well, and do not choose it for a technical or practical exchange with no emotional weight at all.
`;
}
