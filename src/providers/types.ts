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
  attribute: "birthdate" | "location" | "occupation";
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
