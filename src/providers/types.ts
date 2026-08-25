import type { AttributeType } from "../projections/attributeVocabulary.js";

/**
 * Provider-agnostic extraction interface (EN-080). No provider-specific
 * types leak out of the adapter layer — the router and everything above it
 * only ever sees these shapes.
 */

/** The extraction taxonomy stored in extraction_completed payloads (Section 2,
 * Part 4 of the Phase 2 build prompt): populated by extraction from day one,
 * consumed by nothing until episode clustering / emotion (Phase 8.5). */
export interface ExtractedEntity {
  name: string;
  type: "person";
}

export interface StatedFeeling {
  /** Verbatim or near-verbatim text of the stated feeling (Track A, EN-038). */
  text: string;
}

export interface EpisodeMarker {
  /** Minimal boundary-relevant categories — real clustering is Phase 8.5. */
  kind: "incident_reference" | "boundary_start" | "boundary_end";
  text: string;
}

/**
 * Class A structural atom mentions (EN-013), extracted by name — resolution
 * from name to entity id happens after extraction (Phase 3 Part 2). "me" is
 * the reserved name for the author/narrator. `action: "close"` is only ever
 * emitted for spouse_of, and only when the text explicitly states closure
 * (divorce, passing) — never inferred from absence, since there is no
 * "this wasn't mentioned" signal available to an extractor working from one
 * message at a time in the first place.
 */
export interface StructuralAtomMention {
  type: "parent_of" | "spouse_of" | "sibling_of";
  fromName: string;
  toName: string;
  action: "assert" | "close";
  /** EN-012, ported from old Enso: true ONLY on an explicit signal this name refers to a different person than one already known — rare, default false. */
  explicitlyNewPerson: boolean;
}

/**
 * Class B social bond mentions (EN-013). `basis` records whether the text
 * directly stated the bond ("we became friends") or merely implied it
 * ("my coworker Priya" implies colleague) — opening is allowed on either;
 * `action: "close"` must only be emitted when the text explicitly states
 * the bond ended ("we don't talk anymore"), never inferred from silence.
 */
export interface SocialBondMention {
  type: "friend" | "colleague" | "mentor_of" | "neighbor" | "classmate" | "romantic";
  fromName: string;
  toName: string;
  qualifier: string | null;
  basis: "inferred" | "stated";
  action: "open" | "close";
  /** EN-012, ported from old Enso: true ONLY on an explicit signal this name refers to a different person than one already known — rare, default false. */
  explicitlyNewPerson: boolean;
}

/**
 * Third-party attribute mentions (EN-015): attributes stated about *other
 * people*, which must persist to that person's entity — R2 is the
 * regression this exists to prevent forever. "me" is the reserved name for
 * the author. `eventDate` is dual-time (EN-016): an ISO date if the text
 * lets you determine when the fact became true/dated relative to the
 * message's own told-time ("she moved last year"), else null — never
 * guessed.
 */
export interface AttributeMention {
  entityName: string;
  attribute: AttributeType;
  value: string;
  eventDate: string | null;
}

export interface ExtractionTaxonomy {
  entities: ExtractedEntity[];
  statedFeelings: StatedFeeling[];
  episodeMarkers: EpisodeMarker[];
  structuralAtoms: StructuralAtomMention[];
  socialBonds: SocialBondMention[];
  attributes: AttributeMention[];
}

export type ExtractionKind = "message" | "document";

export interface ExtractionRequest {
  kind: ExtractionKind;
  /** The bounded text actually sent to the model (EN-063 for documents). */
  text: string;
  /** The message's own told-time (ISO date), so relative dates ("last year") resolve against when it was actually said, not whenever extraction happens to run (EN-016). Defaults to today if omitted. */
  referenceDate?: string;
  /**
   * Names of people already on record (EN-012, ported from old Enso's
   * buildKnownPeopleBlock) — lets the model use an already-established
   * person's real name instead of a bare kinship term or role when both
   * appear in context ("my mom" -> "Elena", if Elena is already known),
   * which is what lets structural-atom/social-bond mentions of the same
   * person link up across separate messages at all. Per-message
   * extraction has no memory of its own; this is how continuity is passed
   * in. Callers decide how fresh this list needs to be — the entities
   * projection as of the last rebuild is a reasonable source.
   */
  knownPeopleNames?: string[];
  /**
   * Batch 2, item 7's root cause: per-message extraction previously saw
   * ONLY the current message's bare text, with zero conversational
   * context — a real bug found live where the user answered Enso's own
   * "When is it?" (about their birthday) with the bare text "4/24/1970",
   * and extraction correctly-by-its-own-narrow-view produced an empty
   * attributes array, because nothing in "4/24/1970" alone says what the
   * date IS. Enso's own immediately-preceding reply, when present, is now
   * passed through so the model can resolve what a short, elliptical
   * answer refers to before deciding what (if anything) to extract from
   * it — this is read-only context for INTERPRETATION, never a second
   * source of facts to extract from.
   */
  precedingReplyText?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderCallResult {
  provider: "openai" | "gemini";
  model: string;
  taxonomy: ExtractionTaxonomy;
  usage: TokenUsage;
}

/** A provider adapter is just an async function with this shape — this is
 * what makes the router testable without any network calls (FAST suite):
 * tests substitute fakes conforming to this type. */
export type ProviderAdapter = (request: ExtractionRequest) => Promise<ProviderCallResult>;
