import type { ProjectionsDb } from "../projections/db.js";

export type RetrievalMode = "hybrid" | "entity" | "recency";

export interface RetrievalInvocation {
  mode: RetrievalMode;
  /** The search query actually used — derived from the subject being recalled, never the user's literal phrasing verbatim when a better query is available (EN-035's "searched for the word 'messages'" defect). */
  query: string;
  /** Set only when mode is "entity". */
  entityId?: string;
  /** Set only when mode is "recency" — how many recent messages to return. */
  n?: number;
  /** Set only when mode is "hybrid" — w_t(q), same override hybridSearch already accepts. Phase 6's router populates this; the Phase 4/5 local heuristic (computeTemporalWeightHeuristic) still runs inside hybridSearch itself when omitted. */
  temporalWeight?: number;
}

export interface RetrievalInvocationOptions {
  /**
   * Override the heuristic's decision outright — the same shape as
   * hybridSearch's `temporalWeight` option (see hybridSearch.ts): when
   * present, the heuristic below never runs at all. This is the seam Phase
   * 6's intent router plugs into with zero change to any caller of
   * decideRetrievalInvocation.
   */
  override?: RetrievalInvocation;
}

const RECENCY_PHRASES = /\b(read (me |back )?(my|our) (messages|conversation)|what (have|did) we (talk|talked) about|catch me up|recap)\b/i;
const DEFAULT_RECENCY_N = 10;

/** Shared by both mention-finding functions below — never re-derived, so they can't disagree on what counts as a "word" to check. */
const MENTIONABLE_WORD_PATTERN = /\b[A-Za-z][A-Za-z'-]*\b/g;

function mentionableWords(message: string): string[] {
  const words = message.match(MENTIONABLE_WORD_PATTERN) ?? [];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(word);
  }
  return deduped;
}

/**
 * Finds an entity whose exact alias (a real name, not a role/kinship term —
 * see entity_aliases, which only ever stores names extraction actually
 * resolved) appears as a standalone word in the message. Deliberately
 * simple: resolving a bare role reference ("my mother") to a specific
 * entity with no name in the text at all is exactly the judgment call left
 * to Phase 6's router (via the override above) — hybrid mode's FTS+vector
 * fusion is this heuristic's honest fallback for that case, not a fake
 * entity-resolution attempt.
 */
function findMentionedEntityId(message: string, projectionsDb: ProjectionsDb, userId: string): string | undefined {
  for (const word of mentionableWords(message)) {
    const entityId = projectionsDb.findEntityIdByExactAlias(userId, word);
    if (entityId) return entityId;
  }
  return undefined;
}

/**
 * Part D: the SAME name-resolution primitive as findMentionedEntityId above
 * (findEntityIdByExactAlias — never a second name matcher), but collecting
 * every distinct entity mentioned instead of stopping at the first, for the
 * entity-dossier feature (chatPipeline.ts) to inject a structured record
 * for each one directly, no search or ranking involved. Capped at
 * `maxEntities` — a message naming many people at once still only dossiers
 * the first few encountered, left-to-right.
 */
export function findAllMentionedEntityIds(message: string, projectionsDb: ProjectionsDb, userId: string, maxEntities: number): string[] {
  const found: string[] = [];
  const seenEntityIds = new Set<string>();
  for (const word of mentionableWords(message)) {
    if (found.length >= maxEntities) break;
    const entityId = projectionsDb.findEntityIdByExactAlias(userId, word);
    if (!entityId || seenEntityIds.has(entityId)) continue;
    seenEntityIds.add(entityId);
    found.push(entityId);
  }
  return found;
}

/**
 * The cheap local heuristic (EN-035, Part 1): hybrid is the default mode,
 * matching the spec's default weighting — recency and entity modes only
 * activate on a clear signal a message actually asked for one specifically.
 */
export function decideRetrievalInvocation(message: string, projectionsDb: ProjectionsDb, userId: string, options: RetrievalInvocationOptions = {}): RetrievalInvocation {
  if (options.override) return options.override;

  if (RECENCY_PHRASES.test(message)) {
    return { mode: "recency", query: message, n: DEFAULT_RECENCY_N };
  }

  const entityId = findMentionedEntityId(message, projectionsDb, userId);
  if (entityId) {
    return { mode: "entity", query: message, entityId };
  }

  return { mode: "hybrid", query: message };
}
