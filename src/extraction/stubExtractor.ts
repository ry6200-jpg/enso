import type { ExtractionStructure } from "./types.js";

/**
 * Deterministic, no-LLM, no-API-keys stand-in for a real extractor. It exists
 * purely to exercise the projection/rebuild/cache machinery (Phase 1 scope)
 * — not to do real entity extraction (Phase 3 scope, EN-011/012). Given the
 * same text it always returns the same structure.
 *
 * Heuristic: capitalized words, minus a small stopword list of common
 * capitalized non-names (sentence-initial "I", "The", etc). This is
 * intentionally crude — a real extractor is not in scope here.
 */
export const STUB_EXTRACTOR_VERSION = "stub-v1";
export const STUB_MODEL_ID = "stub-model";

const STOPWORDS = new Set(["I", "The", "A", "An", "My", "Today", "Yesterday", "We", "It"]);

export function stubExtract(text: string): ExtractionStructure {
  const matches = text.match(/\b[A-Z][a-zA-Z]*\b/g) ?? [];
  const seen = new Set<string>();
  const entities: ExtractionStructure["entities"] = [];

  for (const word of matches) {
    if (STOPWORDS.has(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ name: word, type: "person" });
  }

  return { entities, relationships: [], dates: [] };
}
