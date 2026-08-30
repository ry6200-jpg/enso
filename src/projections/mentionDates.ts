/**
 * An entity's first/last mention dates, resolved from its own accumulated
 * `source_event_ids` (touchEntity unions every mention into this array,
 * sorted, on every re-mention — see rebuild.ts) against a caller-supplied
 * message-id -> recordedAt map. Never decoded from a ULID directly; the
 * event's own recorded_at is the field of record, the same discipline
 * networkMarkers.ts already established. `source_event_ids` mixes MESSAGE
 * ids with the extraction_completed ids each one produced; only message
 * ids resolve against this map, so extraction ids fall out silently via
 * the filter below, leaving exactly the message-mention timestamps, in
 * chronological order (the ids are already ULID-sorted, which is
 * chronological).
 *
 * Extracted from entityDirectory.ts's own original inline computation —
 * one shared implementation, called from both entityDirectory.ts (the
 * admin view) and rebuild.ts (the unnamed-entity purge), rather than two
 * independent copies of the same logic. Lives here, in the projections
 * layer, rather than in admin/entityDirectory.ts, since rebuild.ts is the
 * lower-level module and already the thing entityDirectory.ts depends on
 * (it imports primaryEntityId from here) — the reverse dependency would
 * invert that layering.
 */
export function resolveMentionDates(entity: { source_event_ids: string }, recordedAtByMessageId: ReadonlyMap<string, string>): { firstMentionAt: string | null; lastMentionAt: string | null } {
  const ids = (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
  const resolved = ids.map((id) => recordedAtByMessageId.get(id)).filter((t): t is string => t !== undefined);
  return {
    firstMentionAt: resolved[0] ?? null,
    lastMentionAt: resolved[resolved.length - 1] ?? null
  };
}
