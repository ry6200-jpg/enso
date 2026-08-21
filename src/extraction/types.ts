/**
 * Shape produced by any extractor (stub today, an LLM-backed one later).
 * Kept generic across entities/relationships/dates now so the structural
 * comparator (EN-057) doesn't need to change shape when relationships and
 * dates extraction land in later phases — they're just empty arrays here.
 */
export interface ExtractedEntity {
  name: string;
  type: "person";
}

export interface ExtractedRelationship {
  from: string;
  to: string;
  kind: string;
}

export interface ExtractionStructure {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  dates: string[];
}
