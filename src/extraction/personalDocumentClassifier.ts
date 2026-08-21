/**
 * The personal-vs-document classifier (EN-060). Scoped to entity extraction
 * ONLY — it never determines whether content is stored, indexed, or
 * acknowledged (that's EN-061: every upload and every message is always
 * stored, unconditionally, regardless of what this returns). It fails open
 * toward extracting, and its decision + reason are recorded as part of the
 * extraction event, never silently applied.
 *
 * Implemented as a cheap local heuristic rather than an LLM call: this gate
 * is not listed among EN-072's gated behaviors (circle-back, maps,
 * history-search), and spending a model call just to decide whether to
 * spend a bigger model call on entity extraction would usually cost more
 * than it saves for short personal messages, which is the common case.
 */
export interface ClassifierDecision {
  isPersonal: boolean;
  reason: string;
}

const FIRST_PERSON_PATTERN = /\b(I|I'm|I've|I'll|I'd|me|my|mine|we|we're|us|our|ours)\b/gi;
// {2,} on an alternation group only matches the SAME alternative repeating
// consecutively at one position — it can't count "2+ different lines
// anywhere in the text" across a multiline string. Count matching lines
// instead of trying to express the threshold inside one regex.
const STRUCTURAL_LINE_PATTERN = /^\s*(#+\s|\d+(\.\d+)+\s+[A-Z]|chapter\s+\d+|[-*•]\s)/gim;
const TABLE_OF_CONTENTS_PATTERN = /table of contents/i;
const MIN_STRUCTURAL_LINES = 2;
const MIN_WORDS_FOR_DOCUMENT_SIGNAL = 80;

export function classifyPersonalVsDocument(text: string): ClassifierDecision {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { isPersonal: true, reason: "empty content — failing open toward extraction" };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const pronounMatches = trimmed.match(FIRST_PERSON_PATTERN) ?? [];
  const pronounDensity = pronounMatches.length / words.length;
  const structuralLineMatches = trimmed.match(STRUCTURAL_LINE_PATTERN) ?? [];
  const hasStructuralMarkers = TABLE_OF_CONTENTS_PATTERN.test(trimmed) || structuralLineMatches.length >= MIN_STRUCTURAL_LINES;

  if (words.length >= MIN_WORDS_FOR_DOCUMENT_SIGNAL && pronounDensity < 0.01 && hasStructuralMarkers) {
    return {
      isPersonal: false,
      reason: `low first-person pronoun density (${(pronounDensity * 100).toFixed(1)}% over ${words.length} words) combined with structured/reference formatting (headings or lists) — reads as reference material, not personal narrative`
    };
  }

  if (pronounDensity > 0) {
    return {
      isPersonal: true,
      reason: `first-person pronoun density ${(pronounDensity * 100).toFixed(1)}% over ${words.length} words suggests personal narrative`
    };
  }

  return { isPersonal: true, reason: "no strong document-like signal — failing open toward extraction" };
}
