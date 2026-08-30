import { ATTRIBUTE_TYPES } from "../projections/attributeVocabulary.js";

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
          explicitlyNewPerson: { type: "boolean" },
          fromNameIsRoleWord: { type: "boolean" },
          toNameIsRoleWord: { type: "boolean" }
        },
        required: ["type", "fromName", "toName", "action", "explicitlyNewPerson", "fromNameIsRoleWord", "toNameIsRoleWord"],
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
          explicitlyNewPerson: { type: "boolean" },
          fromNameIsRoleWord: { type: "boolean" },
          toNameIsRoleWord: { type: "boolean" }
        },
        required: ["type", "fromName", "toName", "qualifier", "basis", "action", "explicitlyNewPerson", "fromNameIsRoleWord", "toNameIsRoleWord"],
        additionalProperties: false
      }
    },
    attributes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entityName: { type: "string" },
          attribute: { type: "string", enum: [...ATTRIBUTE_TYPES] },
          value: { type: "string" },
          eventDate: { type: ["string", "null"] },
          action: { type: "string", enum: ["open", "close"] }
        },
        required: ["entityName", "attribute", "value", "eventDate", "action"],
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
    ? `\nImmediately before this message, Enso itself said: "${precedingReplyText}" — the message you're extracting from may be a short, elliptical answer that only makes sense in light of that (a bare word, number, or phrase that only means something as an answer to whatever Enso's line actually asked). Read Enso's line above to find out what the fragment is actually answering — never assume from the fragment's shape alone what kind of question it must be answering (a bare year could be a birthdate, an age, a graduation year, or something else entirely; go by what was actually asked, not by pattern-matching the fragment itself). ONE EXCEPTION: the author's own bare name (see the entities rule below for the same case) is never a birthdate, location, or occupation, even in reply to a question about one of those. Use the preceding line ONLY to understand what THIS message refers to; extract exclusively from what THIS message itself asserts, never from Enso's line, and never invent a value the user didn't actually state.\n`
    : "";
  return `You extract structured facts from a personal journal entry. Today's date (the date this message was sent) is ${referenceDate} — use it to resolve any relative date phrases.${knownPeopleBlock}${precedingReplyBlock}Follow these rules exactly:
- ASSERTION GUARD (applies to statedFeelings, structuralAtoms, socialBonds, and attributes alike — read this before those sections below): only extract a proposition the user is ASSERTING as true, in their own voice, right now. A question ("Didn't Elena move to Portland last year?", "Is Diego my cousin?", "How's my mom these days?"), a hypothetical or conditional ("If Diego moved away, I'd miss him"), or someone else's reported belief or claim ("Marcus thinks Elena moved to Portland") does NOT assert the proposition embedded inside it — extract nothing from that embedded proposition for the category it would otherwise touch, even though it names real people and reads like a fact. This never suppresses a genuine declarative: "Elena moved to Portland last year." IS an assertion and extracts exactly as it would without this rule. A question merely asking to recall or confirm something ALREADY on record is likewise not a new assertion of anything — that's a retrieval question, not new information to extract.
- entities: every person mentioned by name (not the author/narrator — this excludes the author stating their OWN name, e.g. answering "what should I call you?" with "Richard": that names the author, not a third party, so it gets NO entity entry; use the preceding-reply context above to recognize this). DISAMBIGUATION RULE: you strictly extract HUMAN entities only. You must NEVER extract businesses, venues, restaurants, or locations as people, even if they share a human name (e.g. "The Abby", "Trader Joe's", "Wendy's"). Pay strict attention to spatial and grammatical context clues (such as "at", "went to", "the") to differentiate a place from a person — a name that follows a preposition or verb of location ("at The Abby", "went to Wendy's") or is preceded by "the" is a place, not a person, no matter how human the name itself sounds. type is always "person".
- statedFeelings: only feelings the author explicitly states about themselves or others in their own words (e.g. "I was furious", "she seemed relieved"), subject to the assertion guard above — a question about a feeling ("is she still furious?") or a hypothetical one states nothing. Do not infer feelings that weren't stated.
- episodeMarkers: short markers for incidents or narrative boundaries — "incident_reference" for a specific event described, "boundary_start"/"boundary_end" only when the text explicitly signals an incident beginning or concluding.
- structuralAtoms: family relationships, subject to the assertion guard above — a question about a relationship ("is Elena my mother?", "how's my mom these days?") asserts nothing and gets no entry, even when a kinship term in the question resolves to a known name. Use the literal name "me" for the author/narrator. parent_of: fromName is the PARENT, toName is the CHILD ("my mom" -> {type:"parent_of", fromName:"mom's name or 'mom' if unnamed", toName:"me"}). spouse_of and sibling_of are symmetric (order doesn't matter). action is "assert" for every asserted mention EXCEPT: emit "close" for spouse_of ONLY when the text explicitly states the marriage ended (divorce, death) — never for sibling_of or parent_of, and never merely because someone wasn't mentioned. Never write "child_of" — always express it as parent_of the other direction.
- socialBonds: friend/colleague/mentor_of/neighbor/classmate/romantic bonds, subject to the assertion guard above — a question about whether a bond exists or ended ("Is Diego my cousin?", "did Priya and I stop talking?") asserts nothing, opens nothing, and closes nothing. basis is "inferred" when the bond is implied but not directly stated (e.g. "my coworker Priya" -> colleague, inferred), "stated" when the text directly asserts the bond (e.g. "we became friends"). action is "open" for every asserted mention that isn't a closure, and "close" when the text explicitly STATES that a relationship with that person ended — never infer closure from a person simply not being mentioned, and never from a question asking whether it ended (EN-013's stated-basis rule extends to this: a question is not a stated closure any more than silence is). A general statement that a relationship ended ("we had a falling out and don't talk anymore", "we're not close anymore", "we broke up", "we don't really talk anymore") is closure evidence even if it doesn't name a specific bond type by word: emit a "close" entry with type "friend" for it (the most general non-family bond) UNLESS the text names a more specific type ("we're not coworkers anymore" -> close colleague; "we broke up" about a partner -> close romantic). When in doubt about which type a general falling-out closes, still emit at least one close entry rather than emitting nothing — a closure mention that produces no entries silently fails EN-013's close-on-stated-evidence guarantee. qualifier is short free-text context if present (e.g. "the bowling league"), else null. Never use "peer_of" — it is not a valid type.
- explicitlyNewPerson (on both structuralAtoms and socialBonds entries): flag ONLY an explicit signal that a name refers to a DIFFERENT person sharing a name with someone already known. By default, a later mention of an already-known name is the SAME person, even when how their relationship is described changes (e.g. a coworker later described as a friend — relationships naturally deepen over time; that alone is never a sign of a different person). Set this to true ONLY when the text gives an ACTUAL, explicit signal that this mention is about a DIFFERENT person who happens to share a name with someone already on record — e.g. "a different Sarah," "another Amy I know from the gym," "my other friend named Marcus," or a clearly conflicting distinguishing detail attached to the mention (a different workplace, last name, or city than what's already known about the existing person with that name). This is rare — leave it false on nearly every message.
- fromNameIsRoleWord / toNameIsRoleWord (on both structuralAtoms and socialBonds entries): you already decide, for every fromName/toName you write, whether it is the person's actual name or a fallback kinship/role word used only because no name was given ("mom's name or 'mom' if unnamed" in the structuralAtoms rule below is exactly this choice). Report that same decision here: true when the corresponding fromName/toName is a role or relationship word standing in for an unnamed person ("father", "my boss", "her sister", "a friend of mine"), false when it is an actual given name, nickname, or the literal "me". This is a judgment about the text as given, not a lookup against any fixed list of words — the same role word can be true in one message and irrelevant in another if a real name is used instead, and a name unfamiliar to you is still false here as long as it reads as an actual name rather than a role standing in for one.
- attributes: facts stated about a NAMED person's birthdate, location, or occupation — including the author using entityName "me" — subject to the assertion guard above: a question ("didn't Elena move to Portland last year?"), a hypothetical, or someone else's reported claim about the fact gets no entry, no matter how specific or plausible the embedded value sounds. GUARD, confirmed live failing: the author stating their OWN NAME in reply (e.g. "Richard," answering a birthday question) is never a birthdate/location/occupation — same self-reference already excluded from entities above, a name is not an attribute value no matter what was asked. value is the fact as literally asserted. eventDate is an ISO 8601 date (YYYY-MM-DD) ONLY if the text lets you determine when the fact became true or was dated, resolved relative to today's date above (e.g. "she moved to Seattle last year" said today -> eventDate is one year before today) — otherwise null. Never guess eventDate when the text doesn't support one; a birthdate itself is not an eventDate. ATTRIBUTE INTERVAL RULE — action, for location/occupation/gender/sexual_orientation/life_stage (birthdate has no closed state; always use "open" for it): "open" is the default, for a value describing the person's CURRENT, still-active state (an ordinary present-tense statement — "I live in Seattle," "I'm a nurse now" — and every ordinary update, "I moved to Seattle last year," is still "open": a ordinary NEW current value, not a closure of whatever came before it). "close" is ONLY for a value the text explicitly frames as HISTORICAL or ENDED — a past location moved away from, a former job, a life stage no longer current ("I grew up in Toledo, moved away in 1995," "I used to work at a bakery before switching careers"). Same stated-basis discipline as socialBonds' own action above: never infer "close" merely because a value sounds old, is far in the past, or simply wasn't the most recent thing said — only the text's own explicit historical framing (moved away, former, used to, no longer, back then, that ended) decides it, never silence, recency, or a guess.
If none apply for a category, return an empty array for it. Never invent facts not present in the text, and never extract a fact from a question, hypothetical, or someone else's reported belief as if the user had asserted it themselves.`;
}
