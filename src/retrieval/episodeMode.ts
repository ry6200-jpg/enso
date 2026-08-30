import type { ProjectionsDb } from "../projections/db.js";
import type { ContentChunkRow, RetrievalDb } from "./retrievalDb.js";

/**
 * Episode retrieval mode (EN-037) — the fourth retrieval mode, now wired to
 * the real EN-037 Phase 8.5 clustering projection (src/projections/
 * episodes.ts, rebuild.ts) instead of the stubbed-interface-only version
 * this file used to be (that comment, and the call signature it settled,
 * are why this rewrite required no signature change beyond adding the two
 * DB handles the real implementation actually needs — mirrors entityMode's
 * own (projectionsDb, retrievalDb, userId, id) shape exactly). An episode
 * match returns the bounded sequence of raw source messages, never a
 * summary, exactly like every other retrieval mode.
 */
export interface EpisodeMatch {
  episodeId: string;
  title: string;
  chunks: ContentChunkRow[];
}

export function episodeMode(projectionsDb: ProjectionsDb, retrievalDb: RetrievalDb, userId: string, episodeId: string): EpisodeMatch | undefined {
  const episode = projectionsDb.getEpisodeById(episodeId);
  if (!episode || episode.user_id !== userId) return undefined;

  const sourceEventIds = JSON.parse(episode.source_event_ids) as string[];
  const seen = new Set<string>();
  const chunks: ContentChunkRow[] = [];

  for (const eventId of sourceEventIds) {
    for (const chunk of retrievalDb.getChunksBySourceEventId(eventId)) {
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      chunks.push(chunk);
    }
  }

  chunks.sort((a, b) => (a.occurred_at ?? a.recorded_at).localeCompare(b.occurred_at ?? b.recorded_at));

  return { episodeId: episode.id, title: episode.title, chunks };
}
