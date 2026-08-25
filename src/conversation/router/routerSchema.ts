import type { RouterRequest } from "./routerTypes.js";
import { ATTRIBUTE_TYPES } from "../../projections/attributeVocabulary.js";

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
        kind: { type: ["string", "null"], enum: ["selfFact", "thirdParty", "connectDot", "elicitation", null] },
        entityId: { type: ["string", "null"] },
        // Deliberately NOT derived from ATTRIBUTE_TYPES — a curated subset,
        // same reason as circleBack.ts's SELF_FACT_ATTRIBUTES (see
        // attributeVocabulary.ts's header comment): proactive curiosity-
        // asking about gender/sexual_orientation/life_stage is a real
        // product/wording decision this schema-and-plumbing batch does not
        // make.
        attribute: { type: ["string", "null"], enum: ["location", "occupation", null] },
        probeType: { type: ["string", "null"] }
      },
      required: ["fire", "kind", "entityId", "attribute", "probeType"],
      additionalProperties: false
    },
    attestation: {
      type: "object",
      properties: {
        isAffirmation: { type: "boolean" },
        entityName: { type: ["string", "null"] },
        attribute: { type: ["string", "null"], enum: [...ATTRIBUTE_TYPES, null] },
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
    },
    ambientContext: {
      type: "object",
      properties: {
        relevant: { type: "boolean" },
        ownSituation: { type: "boolean" },
        thirdPartyEntityId: { type: ["string", "null"] },
        namedPlaceForDistance: { type: ["string", "null"] }
      },
      required: ["relevant", "ownSituation", "thirdPartyEntityId", "namedPlaceForDistance"],
      additionalProperties: false
    },
    travelContext: {
      type: "object",
      properties: {
        relevant: { type: "boolean" },
        destinationHint: { type: ["string", "null"] }
      },
      required: ["relevant", "destinationHint"],
      additionalProperties: false
    }
  },
  required: ["retrieval", "curiosityTurn", "attestation", "register", "ambientContext", "travelContext"],
  additionalProperties: false
} as const;

/**
 * Builds the router's system prompt. All six judgment axes in one call
 * (EN-075: latency/cost over separate calls — EN-048 added the fourth,
 * register, the ambient-context batch added the fifth, ambientContext,
 * and part 4 (this batch) added the sixth, travelContext — the ported
 * equivalent of the old app's decideLocationToolUse judgment, folded into
 * this same structured-output call at zero extra API cost rather than a
 * separate tool-calling mechanism) — each section names its own hard
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
              : c.kind === "thirdParty"
                ? `- [thirdParty] ${c.candidate.name} (id: ${c.candidate.entityId}) — attempt ${c.candidate.attemptNumber}${c.candidate.attemptNumber === 2 ? `, first asked ${c.candidate.mentionAgeLabel} and unanswered; this would be the final attempt` : ""}`
                : c.layer === 1
                  ? `- [elicitation layer=1] probeType="${c.probeType}" — a name-generator prompt; helping the owner talk about someone in their life, the answer is a name`
                  : `- [elicitation layer=3] probeType="${c.probeType}" anchor="${c.anchorName}" (id: ${c.anchorEntityId}) — a scene-deepening prompt about someone already established`
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
  const ambientCandidatesBlock =
    request.ambientLocationCandidates.length > 0
      ? request.ambientLocationCandidates.map((c) => `- ${c.name} (id: ${c.entityId}) — location on record: ${c.location}`).join("\n")
      : "(no one on record has a known location)";

  return `You are a routing judgment layer for a personal journaling assistant, deciding six things about the CURRENT user message below. Return ONLY the JSON the schema requires — no prose.

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
- kind="elicitation": probeType MUST exactly match one tagged [elicitation] above (and entityId MUST match its anchor id, for a layer=3 candidate only). Elicitation probes actively help the owner talk about themselves and the people in their life — this is not filling silence, it's opening a door; a thin or quiet thread is itself a good reason to offer one of these when nothing else fits, never a hollow generic question invented on the spot.

You may instead choose kind="connectDot" (entityId, attribute, and probeType all null) when curiosityTurnEligible is true and making a connecting observation — noticing a real pattern from what you already know about this person — would serve this moment better than asking something new. Only choose this when a genuine pattern actually exists; never invent one to fill the slot.

If curiosityTurnEligible is true but the ask-candidate list above is empty AND no genuine connecting observation exists, fire MUST still be false — there is nothing to say yet, and that is the correct outcome, not a gap to paper over. Separately, even when otherwise eligible, decline (fire=false) if the CURRENT message is itself a direct question needing a real answer, or shares something emotionally weighty enough that even a brief aside would interrupt or trivialize it.

3. ATTESTATION — is the CURRENT message the owner EXPLICITLY affirming one specific value listed below as correct (e.g. "yes, that's right," "May 12 exactly")? A bare continuer ("yeah," "ok," "mm," "sure," "sounds right" with no specific value re-addressed) is NEVER an affirmation — isAffirmation must be false for those. It must also be false if the message corrects or contradicts the value, or addresses something not in this list at all. Only set isAffirmation true when the message specifically and unambiguously affirms one of these exact values; entityName/attribute/value must then exactly match one entry below (copy it verbatim), never a paraphrase.

Recently surfaced claims this turn could affirm:
${claimsBlock}

4. REGISTER — should the reply use the quieter, more restrained "zen" register instead of the ordinary conversational one? Default to "natural" — this is the overwhelming majority case. Choose "zen" only when the CURRENT message shows genuine overwhelm, the owner visibly looping on the same problem without new ground being covered across recent turns, or an explicit ask to zoom out or step back — judge this from the actual content and tone of the message and recent conversation, not from whether it contains a specific trigger word: someone genuinely overwhelmed frequently does NOT use that word at all. Do not choose "zen" for an ordinary emotional moment that a warm, plain reply already handles well, and do not choose it for a technical or practical exchange with no emotional weight at all.

5. AMBIENT CONTEXT — is a real weather/local-time/walking-distance lookup worth making for THIS turn? Default to relevant=false — this is the overwhelming majority case, and it costs real API calls, so only fire it when there's real value. GOVERNING RULE, the ONLY question that matters: is there a live decision or concern already on the table that this data would actually inform? Location being merely KNOWN is never enough on its own — that produces an assistant appending a helpful fact to every turn, which is exactly the failure this gate exists to prevent.

Owner's own coordinates available this turn: ${request.ownLocationAvailable ? "yes" : "no"}. If "no", ownSituation MUST be false no matter what — there is nothing to fetch.

- ownSituation: true when the OWNER's own weather or local time would shape how you read what they're telling you (silent calibration — e.g. they mention being tired at an odd hour, or something that only makes sense knowing it's the middle of the night for them) or when they've asked something that needs it directly. This is rarely worth reciting as a fact back to them — see the ambient-context persona instruction for how it actually gets used once fetched.
- thirdPartyEntityId: set ONLY when a specific person or place already on record below is relevant to a live concern this turn (e.g. the owner mentions their mother and something about her situation) — MUST exactly match one entry below, never invented, null otherwise.

People/places on record with a known location:
${ambientCandidatesBlock}

- namedPlaceForDistance: set ONLY when the owner has raised something that a real walking-distance or nearby-place lookup would concretely resolve (e.g. deciding whether to go somewhere, wondering if a specific place is close) — free text naming the place AS THE OWNER DESCRIBED IT (e.g. "the pharmacy she mentioned," "the show tonight"), never a made-up business name; null when nothing like that came up. This is resolved by a real place lookup afterward, not validated against a list the way entity ids are — an unresolvable name just means no distance data surfaces this turn, so there is no harm in leaving it null when you're not sure it will resolve to something real.

If none of the above genuinely applies, relevant MUST be false and every other field null/false — do not set relevant=true "just in case" one of the fields might end up useful.

6. TRAVEL CONTEXT — is a real, live-traffic drive-time/distance lookup worth making for THIS turn? Default to relevant=false — this costs a real API call and, like ambient context above, is worth almost nothing on most turns. GOVERNING RULE, the same shape as ambient context's: the owner must be facing an actual timing or attendance decision right now — whether to leave, how much time to allow, whether a drive is worth it — never "a destination is knowable, so check it." This is never for idle travel trivia and never volunteered into a reply as an ETA — see the ambient-travel persona instruction for how the data (once fetched) is actually allowed to shape a reply.

Owner's own home/residence on record: ${request.primaryResidenceKnown ? "yes" : "no"}.

- destinationHint: free text for a SPECIFIC, findable place named this turn (e.g. "the airport," "downtown Seattle," a named venue or address) — AS THE OWNER DESCRIBED IT, never invented — only when relevant is true and a real destination came up. This is resolved by a real place lookup afterward, not validated against a list: a vague relational reference with nothing findable behind it (e.g. "my mom's place" with no address or venue attached) simply won't resolve, and that's fine — no harm in leaving it null when you're not sure it will resolve to something real, or in setting it and having the lookup come back empty. Leave destinationHint null ONLY when relevant is true AND the moment specifically implies the owner heading to their OWN home — nothing vaguer than that. A general timing/attendance decision with no sense of WHERE ("I should get going before it gets late," with no place named and nothing pointing at home specifically) is NOT enough on its own to leave destinationHint null: if you can't tell whether this is genuinely about heading home or about somewhere else entirely unnamed, set relevant=false instead of guessing at a destination that was never actually there.
- If relevant is true, destinationHint is null (the moment specifically implied heading home), AND the owner's home is NOT on record (see above), there is nothing to route to — but that's a fetch-layer concern, not yours: still set relevant=true, leaving destinationHint null.
`;
}
