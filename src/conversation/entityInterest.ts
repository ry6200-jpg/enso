import type { EventRecord } from "../events/schema.js";

/**
 * Shared entity-interest scoring, used by circleBack.ts's third-party
 * candidate ordering and elicitation.ts's Layer 3 anchor ordering — same
 * two failures, same fix, one module rather than two copies.
 *
 * Live-caught (breadth-before-depth batch): Enso asked how the owner met
 * a childhood friend across six turns in six phrasings, monopolizing the
 * whole session on one anchor while passing over three genuine openings
 * elsewhere (a significant personal disclosure, "nobody, I am very
 * independent," "that is why I created you"). R44 fixed the mechanical
 * duplicate-attempt bug; this fixes the underlying RANKING problem R44
 * alone doesn't touch: even correctly capped per (probeType, anchor), the
 * SAME anchor stayed most-recently-mentioned turn after turn and so kept
 * winning every selection, exhausting all six Layer 3 probe types on one
 * person before any other anchor ever got a turn.
 *
 * Two changes, both derived from data that already exists — no new
 * schema, no new event type:
 *
 * WEIGHTING — prefer entities the owner RETURNED TO on their own (repeat
 * mentions across distinct turns — an entity's own accumulated
 * source_event_ids already record every mention) and entities they
 * ELABORATED on unprompted (more said about them in a turn, per-word) over
 * entities that only ever arrived bundled in a list with others — a
 * roster is intake, not interest, so a mention's word-count contribution
 * is divided by how many distinct entities shared that same message (a
 * message naming five people at once contributes a fifth as much
 * "elaboration" per name as a message naming one person alone).
 *
 * Deliberately NOT ranked by kinship distance or structural relation type:
 * social_bonds records genealogy, not closeness — people are often
 * closest to a cousin and estranged from a sibling. Ranking family above
 * friends by relation type would have pressed this exact owner about
 * exactly the person he least wants pressed on. Same reasoning that
 * rejected age-gating for reminiscence elsewhere in this project.
 *
 * ROTATION — orthogonal to weighting, and robust even when the ranking is
 * wrong: whatever the score says, an entity that was JUST the subject of
 * an ask yields the floor for the next few selections rather than
 * immediately winning again. A correctly top-ranked thread (the
 * childhood friend genuinely was the live thread) can still monopolize
 * every turn on score alone — rotation is the mechanical, score-
 * independent guard against that, not a correction to the ranking itself.
 */

/** "The next few selections" — small enough that a genuinely single-person session (nothing else to rotate to) still gets back to that person soon, large enough that six back-to-back probes about one anchor (the live failure) cannot happen again. */
export const ROTATION_WINDOW = 3;

export interface InterestScored {
  stableKey: string;
  returnScore: number;
  elaborationScore: number;
}

/**
 * Builds a message-id -> distinct-entity-count map from every entity's own
 * source_event_ids — the density signal ("many entities in one message is
 * intake; a single entity raised alone is a subject"). Callers pass the
 * FULL entity list (not just the candidates being scored) so a candidate's
 * density penalty reflects everyone who was actually named in that
 * message, not just whichever subset happens to be under consideration
 * this turn.
 */
export function buildEntityDensityByMessageId(allEntitySourceEventIds: string[][]): Map<string, number> {
  const density = new Map<string, number>();
  for (const sourceIds of allEntitySourceEventIds) {
    for (const id of new Set(sourceIds)) {
      density.set(id, (density.get(id) ?? 0) + 1);
    }
  }
  return density;
}

/**
 * RETURN: the number of DISTINCT user turns this entity was mentioned in —
 * 1 means it surfaced once (whether alone or in a list), 2+ means the
 * owner genuinely brought it up again later, unprompted, the strongest
 * signal this ranking has. ELABORATION: total word count across every
 * mention, each mention's contribution divided by that message's entity
 * density — a dedicated sentence about one person counts fully; a name
 * dropped into a five-person roster counts a fifth as much.
 */
export function computeInterestScore(
  stableKey: string,
  sourceEventIds: string[],
  turnIndexByMessageId: Map<string, number>,
  messageTextById: Map<string, string>,
  entityDensityByMessageId: Map<string, number>
): InterestScored {
  const distinctTurns = new Set<number>();
  let elaborationScore = 0;
  for (const id of sourceEventIds) {
    const turnIndex = turnIndexByMessageId.get(id);
    if (turnIndex !== undefined) distinctTurns.add(turnIndex);
    const text = messageTextById.get(id);
    if (text === undefined) continue;
    const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    const density = entityDensityByMessageId.get(id) ?? 1;
    elaborationScore += wordCount / Math.max(density, 1);
  }
  return { stableKey, returnScore: distinctTurns.size, elaborationScore };
}

/** Convenience: message text keyed by event id, from a list of user-turn EventRecords (each payload already has `text`). */
export function buildMessageTextById(userTurns: EventRecord[]): Map<string, string> {
  return new Map(userTurns.map((t) => [t.id, (t.payload as { text: string }).text]));
}

/**
 * Orders candidates by interest score (return first, elaboration as the
 * tiebreak — both descending), then moves any candidate whose stableKey
 * fired within the last ROTATION_WINDOW selections of THIS SAME mechanism
 * to the back, regardless of score. Rotation overrides ranking, never the
 * reverse: a recently-asked entity is never re-promoted to the front no
 * matter how high its score is, and a not-recently-asked entity is never
 * held back for one that was.
 */
export function rankByInterestWithRotation<T extends InterestScored>(candidates: T[], recentlyFiredStableKeys: ReadonlySet<string>): T[] {
  const byInterest = (a: T, b: T) => b.returnScore - a.returnScore || b.elaborationScore - a.elaborationScore;
  const notRecent = candidates.filter((c) => !recentlyFiredStableKeys.has(c.stableKey)).sort(byInterest);
  const recent = candidates.filter((c) => recentlyFiredStableKeys.has(c.stableKey)).sort(byInterest);
  return [...notRecent, ...recent];
}

/** The last ROTATION_WINDOW fires' subject stableKeys, most-recent-first history already available to the caller (turnIndex descending) — a small, shared helper so both circleBack.ts and elicitation.ts compute "recently fired" identically. */
export function recentlyFiredStableKeys(history: { stableKey: string; turnIndex: number }[], windowSize: number = ROTATION_WINDOW): Set<string> {
  const sorted = [...history].sort((a, b) => b.turnIndex - a.turnIndex);
  return new Set(sorted.slice(0, windowSize).map((h) => h.stableKey));
}
