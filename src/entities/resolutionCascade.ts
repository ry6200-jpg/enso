import { doubleMetaphone } from "double-metaphone";
import { distance as levenshteinDistance } from "fastest-levenshtein";

/**
 * Entity resolution cascade (EN-012). Ported from old Enso's
 * lib/entityResolver.ts as a specification, not reimplemented from
 * scratch — these rules encode fixed bugs found live (see the comments
 * throughout, carried over almost verbatim where they explain a real
 * incident, since they're the most expensive artifacts this cascade
 * carries). Kept here as pure functions, independent of storage, so
 * rebuild.ts can drive them against Enso's own accumulator state without
 * this module needing to know about SQLite, events, or ULIDs at all.
 */

/** Strips apostrophes/dashes and collapses whitespace so "Hugo's" and "Hugos" compare equal. */
export function normalizeForMatching(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nameWords(name: string): string[] {
  return name.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** True if `shorter` is a strict word-prefix of `longer` — e.g. ["irene"] prefixes ["irene", "yap"]. */
function isNameWordPrefixOf(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  return shorter.every((word, i) => word === longer[i]);
}

export interface NameCandidate {
  id: string;
  name: string;
}

/**
 * An existing entity whose name is a word-prefix of `trimmed`, or vice
 * versa (e.g. "Irene" against an already-known "Irene Yap"). Only returns
 * a match when EXACTLY ONE candidate qualifies — with two candidates that
 * both prefix-match (an "Irene Yap" and an "Irene Chen"), merging on a
 * bare "Irene" risks silently conflating two different people, so this
 * backs off and lets a new entity be created instead.
 */
export function findUnambiguousPartialNameMatch(trimmed: string, candidates: NameCandidate[]): NameCandidate | undefined {
  const words = nameWords(trimmed);
  const matches = candidates.filter((c) => {
    const otherWords = nameWords(c.name);
    return isNameWordPrefixOf(words, otherWords) || isNameWordPrefixOf(otherWords, words);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

// Below this length, edit-distance/phonetic comparisons produce too many
// coincidental near-misses to be meaningful (e.g. "Al" vs "Ed" is 2 edits
// apart on a 2-letter string, which says nothing).
const MIN_FUZZY_NAME_LENGTH = 4;

/**
 * True when `a` and `b` (already lowercased/trimmed) are a plausible
 * respelling of the same name. Two independent signals, either sufficient:
 * (1) Levenshtein distance within a conservative, length-scaled bound;
 * (2) the same Double Metaphone phonetic code, within a looser secondary
 * distance bound. Deliberately conservative in both directions — a false
 * positive here is worse than a missed variant.
 */
export function isPlausibleNameVariant(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length < MIN_FUZZY_NAME_LENGTH || b.length < MIN_FUZZY_NAME_LENGTH) return false;

  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  const editDistanceThreshold = maxLen <= 6 ? 2 : 3;
  if (dist <= editDistanceThreshold) return true;

  if (dist <= editDistanceThreshold + 2) {
    const [primaryA, secondaryA] = doubleMetaphone(a);
    const [primaryB, secondaryB] = doubleMetaphone(b);
    if (primaryA && (primaryA === primaryB || primaryA === secondaryB)) return true;
    if (secondaryA && (secondaryA === primaryB || secondaryA === secondaryB)) return true;
  }
  return false;
}

/**
 * The lowest-confidence match in the whole cascade — only reached when
 * nothing else matched at all. Only returns a match when EXACTLY ONE
 * existing entity qualifies, same "never guess among multiple candidates"
 * principle as findUnambiguousPartialNameMatch.
 */
export function findFuzzyNameMatch(trimmed: string, candidates: NameCandidate[]): NameCandidate | undefined {
  const normalized = trimmed.trim().toLowerCase();
  if (normalized.length < MIN_FUZZY_NAME_LENGTH) return undefined;
  const matches = candidates.filter((c) => isPlausibleNameVariant(normalized, c.name.trim().toLowerCase()));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Counterparty-scoped structural-atom conflict check — Enso's adaptation
 * of old Enso's classifyRelationshipTypeChangeForPair. Old Enso's
 * relationship_type is free text ("mother"/"mom"/"daughter" all describing
 * one relationship), so it needed kinship-word clusters to recognize
 * compatible phrasings. Enso's structural atom type is already a CLOSED
 * enum (parent_of/spouse_of/sibling_of) fixed by the extraction taxonomy
 * itself — the "which word means what" problem is solved at extraction
 * time, not at disambiguation time — so the comparison simplifies to: the
 * SAME type toward the same counterparty is a match (nothing to compare,
 * or a reconfirmation); a DIFFERENT type toward the SAME counterparty is a
 * conflict (a real person can't be simultaneously your parent and your
 * sibling), a high-confidence signal this name match is actually a
 * different person. Scoped to one counterparty for the same reason old
 * Enso's is (see getCurrentRelationshipTypesForCounterparty there): a
 * person can truly be a sibling to one person and a parent to another,
 * all at once — comparing across unrelated counterparties would treat
 * every one of those as a false conflict.
 */
export function hasConflictingStructuralAtom(existingTypesTowardCounterparty: string[], newType: string): boolean {
  return existingTypesTowardCounterparty.length > 0 && !existingTypesTowardCounterparty.includes(newType);
}
