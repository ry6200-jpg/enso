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
    },
    structuralAtoms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["parent_of", "spouse_of", "sibling_of"] },
          fromName: { type: "string" },
          toName: { type: "string" },
          action: { type: "string", enum: ["assert", "close"] }
        },
        required: ["type", "fromName", "toName", "action"],
        additionalProperties: false
      }
    },
    socialBonds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["friend", "colleague", "mentor_of", "neighbor", "classmate", "romantic"] },
          fromName: { type: "string" },
          toName: { type: "string" },
          qualifier: { type: ["string", "null"] },
          basis: { type: "string", enum: ["inferred", "stated"] },
          action: { type: "string", enum: ["open", "close"] }
        },
        required: ["type", "fromName", "toName", "qualifier", "basis", "action"],
        additionalProperties: false
      }
    },
    attributes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entityName: { type: "string" },
          attribute: { type: "string", enum: ["birthdate", "location", "occupation"] },
          value: { type: "string" },
          eventDate: { type: ["string", "null"] }
        },
        required: ["entityName", "attribute", "value", "eventDate"],
        additionalProperties: false
      }
    }
  },
  required: ["entities", "statedFeelings", "episodeMarkers", "structuralAtoms", "socialBonds", "attributes"],
  additionalProperties: false
} as const;

/**
 * A function of the message's own told-time (EN-016 dual time): relative
 * date phrases ("last year") must resolve against when the message was
 * actually sent, not whenever extraction happens to run — otherwise a
 * reprocess months later would silently shift every relative date.
 */
export function buildExtractionSystemPrompt(referenceDate: string): string {
  return `You extract structured facts from a personal journal entry. Today's date (the date this message was sent) is ${referenceDate} — use it to resolve any relative date phrases. Follow these rules exactly:
- entities: every person mentioned by name (not the author/narrator). type is always "person".
- statedFeelings: only feelings the author explicitly states about themselves or others in their own words (e.g. "I was furious", "she seemed relieved"). Do not infer feelings that weren't stated.
- episodeMarkers: short markers for incidents or narrative boundaries — "incident_reference" for a specific event described, "boundary_start"/"boundary_end" only when the text explicitly signals an incident beginning or concluding.
- structuralAtoms: family relationships. Use the literal name "me" for the author/narrator. parent_of: fromName is the PARENT, toName is the CHILD ("my mom" -> {type:"parent_of", fromName:"mom's name or 'mom' if unnamed", toName:"me"}). spouse_of and sibling_of are symmetric (order doesn't matter). action is "assert" for every mention EXCEPT: emit "close" for spouse_of ONLY when the text explicitly states the marriage ended (divorce, death) — never for sibling_of or parent_of, and never merely because someone wasn't mentioned. Never write "child_of" — always express it as parent_of the other direction.
- socialBonds: friend/colleague/mentor_of/neighbor/classmate/romantic bonds. basis is "inferred" when the bond is implied but not directly stated (e.g. "my coworker Priya" -> colleague, inferred), "stated" when the text directly asserts the bond (e.g. "we became friends"). action is "open" for every mention that isn't a closure, and "close" when the text explicitly states a relationship with that person ended — never infer closure from a person simply not being mentioned. A general statement that a relationship ended ("we had a falling out and don't talk anymore", "we're not close anymore", "we broke up", "we don't really talk anymore") is closure evidence even if it doesn't name a specific bond type by word: emit a "close" entry with type "friend" for it (the most general non-family bond) UNLESS the text names a more specific type ("we're not coworkers anymore" -> close colleague; "we broke up" about a partner -> close romantic). When in doubt about which type a general falling-out closes, still emit at least one close entry rather than emitting nothing — a closure mention that produces no entries silently fails EN-013's close-on-stated-evidence guarantee. qualifier is short free-text context if present (e.g. "the bowling league"), else null. Never use "peer_of" — it is not a valid type.
- attributes: facts stated about a NAMED person's birthdate, location, or occupation — including the author using entityName "me". value is the fact as literally stated. eventDate is an ISO 8601 date (YYYY-MM-DD) ONLY if the text lets you determine when the fact became true or was dated, resolved relative to today's date above (e.g. "she moved to Seattle last year" said today -> eventDate is one year before today) — otherwise null. Never guess eventDate when the text doesn't support one; a birthdate itself is not an eventDate.
If none apply for a category, return an empty array for it. Never invent facts not present in the text.`;
}
