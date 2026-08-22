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
          action: { type: "string", enum: ["assert", "close"] },
          explicitlyNewPerson: { type: "boolean" }
        },
        required: ["type", "fromName", "toName", "action", "explicitlyNewPerson"],
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
          action: { type: "string", enum: ["open", "close"] },
          explicitlyNewPerson: { type: "boolean" }
        },
        required: ["type", "fromName", "toName", "qualifier", "basis", "action", "explicitlyNewPerson"],
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
export function buildExtractionSystemPrompt(referenceDate: string, knownPeopleNames: string[] = [], precedingReplyText?: string): string {
  const knownPeopleBlock =
    knownPeopleNames.length > 0
      ? `\nPeople already on record: ${knownPeopleNames.join(", ")}. When the text refers to one of them — even via a kinship term or role instead of their name ("my mom" when Elena is already on record as the mother) — use their EXACT established name from this list in fromName/toName/entityName, not the kinship term or role, so mentions of the same person link up across messages. Only use a bare kinship term or role when the text gives no name at all and no name is already on record for that person.\n`
      : "";
  const precedingReplyBlock = precedingReplyText
    ? `\nImmediately before this message, Enso itself said: "${precedingReplyText}" — the message you're extracting from may be a short, elliptical answer that only makes sense in light of that (a bare date answering a question about a birthday, a bare "yes" confirming something Enso asked). Use it ONLY to understand what the message refers to; extract exclusively from what THIS message itself asserts, never from Enso's line, and never invent a value the user didn't actually state.\n`
    : "";
  return `You extract structured facts from a personal journal entry. Today's date (the date this message was sent) is ${referenceDate} — use it to resolve any relative date phrases.${knownPeopleBlock}${precedingReplyBlock}Follow these rules exactly:
- ASSERTION GUARD (applies to statedFeelings, structuralAtoms, socialBonds, and attributes alike — read this before those sections below): only extract a proposition the user is ASSERTING as true, in their own voice, right now. A question ("Didn't Elena move to Portland last year?", "Is Diego my cousin?", "How's my mom these days?"), a hypothetical or conditional ("If Diego moved away, I'd miss him"), or someone else's reported belief or claim ("Marcus thinks Elena moved to Portland") does NOT assert the proposition embedded inside it — extract nothing from that embedded proposition for the category it would otherwise touch, even though it names real people and reads like a fact. This never suppresses a genuine declarative: "Elena moved to Portland last year." IS an assertion and extracts exactly as it would without this rule. A question merely asking to recall or confirm something ALREADY on record is likewise not a new assertion of anything — that's a retrieval question, not new information to extract.
- entities: every person mentioned by name (not the author/narrator — this excludes the author stating their OWN name, e.g. answering "what should I call you?" with "Richard": that names the author, not a third party, so it gets NO entity entry; use the preceding-reply context above to recognize this). type is always "person".
- statedFeelings: only feelings the author explicitly states about themselves or others in their own words (e.g. "I was furious", "she seemed relieved"), subject to the assertion guard above — a question about a feeling ("is she still furious?") or a hypothetical one states nothing. Do not infer feelings that weren't stated.
- episodeMarkers: short markers for incidents or narrative boundaries — "incident_reference" for a specific event described, "boundary_start"/"boundary_end" only when the text explicitly signals an incident beginning or concluding.
- structuralAtoms: family relationships, subject to the assertion guard above — a question about a relationship ("is Elena my mother?", "how's my mom these days?") asserts nothing and gets no entry, even when a kinship term in the question resolves to a known name. Use the literal name "me" for the author/narrator. parent_of: fromName is the PARENT, toName is the CHILD ("my mom" -> {type:"parent_of", fromName:"mom's name or 'mom' if unnamed", toName:"me"}). spouse_of and sibling_of are symmetric (order doesn't matter). action is "assert" for every asserted mention EXCEPT: emit "close" for spouse_of ONLY when the text explicitly states the marriage ended (divorce, death) — never for sibling_of or parent_of, and never merely because someone wasn't mentioned. Never write "child_of" — always express it as parent_of the other direction.
- socialBonds: friend/colleague/mentor_of/neighbor/classmate/romantic bonds, subject to the assertion guard above — a question about whether a bond exists or ended ("Is Diego my cousin?", "did Priya and I stop talking?") asserts nothing, opens nothing, and closes nothing. basis is "inferred" when the bond is implied but not directly stated (e.g. "my coworker Priya" -> colleague, inferred), "stated" when the text directly asserts the bond (e.g. "we became friends"). action is "open" for every asserted mention that isn't a closure, and "close" when the text explicitly STATES that a relationship with that person ended — never infer closure from a person simply not being mentioned, and never from a question asking whether it ended (EN-013's stated-basis rule extends to this: a question is not a stated closure any more than silence is). A general statement that a relationship ended ("we had a falling out and don't talk anymore", "we're not close anymore", "we broke up", "we don't really talk anymore") is closure evidence even if it doesn't name a specific bond type by word: emit a "close" entry with type "friend" for it (the most general non-family bond) UNLESS the text names a more specific type ("we're not coworkers anymore" -> close colleague; "we broke up" about a partner -> close romantic). When in doubt about which type a general falling-out closes, still emit at least one close entry rather than emitting nothing — a closure mention that produces no entries silently fails EN-013's close-on-stated-evidence guarantee. qualifier is short free-text context if present (e.g. "the bowling league"), else null. Never use "peer_of" — it is not a valid type.
- explicitlyNewPerson (on both structuralAtoms and socialBonds entries): flag ONLY an explicit signal that a name refers to a DIFFERENT person sharing a name with someone already known. By default, a later mention of an already-known name is the SAME person, even when how their relationship is described changes (e.g. a coworker later described as a friend — relationships naturally deepen over time; that alone is never a sign of a different person). Set this to true ONLY when the text gives an ACTUAL, explicit signal that this mention is about a DIFFERENT person who happens to share a name with someone already on record — e.g. "a different Sarah," "another Amy I know from the gym," "my other friend named Marcus," or a clearly conflicting distinguishing detail attached to the mention (a different workplace, last name, or city than what's already known about the existing person with that name). This is rare — leave it false on nearly every message.
- attributes: facts stated about a NAMED person's birthdate, location, or occupation — including the author using entityName "me" — subject to the assertion guard above: a question ("didn't Elena move to Portland last year?"), a hypothetical, or someone else's reported claim about the fact gets no entry, no matter how specific or plausible the embedded value sounds. value is the fact as literally asserted. eventDate is an ISO 8601 date (YYYY-MM-DD) ONLY if the text lets you determine when the fact became true or was dated, resolved relative to today's date above (e.g. "she moved to Seattle last year" said today -> eventDate is one year before today) — otherwise null. Never guess eventDate when the text doesn't support one; a birthdate itself is not an eventDate.
If none apply for a category, return an empty array for it. Never invent facts not present in the text, and never extract a fact from a question, hypothetical, or someone else's reported belief as if the user had asserted it themselves.`;
}
