import type { ProjectionsDb } from "../projections/db.js";
import type { ContentChunkRow, RetrievalDb } from "./retrievalDb.js";

/**
 * Entity retrieval mode (EN-035): every message linked to a person via
 * provenance — serves "what did I tell you about my mother" even when her
 * name isn't the literal text of any message. This works by reusing Phase
 * 3's entity resolution machinery rather than re-deriving anything: an
 * entity's `source_event_ids` (accumulated by rebuild every time a mention
 * — by name OR by a kinship term the known-people injection resolved to
 * that entity, EN-012) resolves to it, already IS the provenance link this
 * mode needs. "My mom" resolving to Elena's entity means Elena's
 * source_event_ids already includes that message's id, with no literal
 * name match required anywhere in this function.
 */
export function entityMode(projectionsDb: ProjectionsDb, retrievalDb: RetrievalDb, userId: string, entityId: string): ContentChunkRow[] {
  const entity = projectionsDb.getEntityById(entityId);
  if (!entity || entity.user_id !== userId) return [];

  const sourceEventIds = JSON.parse(entity.source_event_ids) as string[];
  const seen = new Set<string>();
  const chunks: ContentChunkRow[] = [];

  for (const eventId of sourceEventIds) {
    for (const chunk of retrievalDb.getChunksBySourceEventId(eventId)) {
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      chunks.push(chunk);
    }
  }

  return chunks.sort((a, b) => (a.occurred_at ?? a.recorded_at).localeCompare(b.occurred_at ?? b.recorded_at));
}
