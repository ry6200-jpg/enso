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

export interface ExtractionTaxonomy {
  entities: ExtractedEntity[];
  statedFeelings: StatedFeeling[];
  episodeMarkers: EpisodeMarker[];
}

export type ExtractionKind = "message" | "document";

export interface ExtractionRequest {
  kind: ExtractionKind;
  /** The bounded text actually sent to the model (EN-063 for documents). */
  text: string;
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
