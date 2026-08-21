import type { ContentChunkRow, RetrievalDb } from "./retrievalDb.js";

/**
 * Recency retrieval mode (EN-035): the last N messages verbatim, no search
 * term — serves "read my messages" / "what have we talked about," which
 * contain no searchable keyword at all. Returned in chronological
 * (oldest-of-the-N first) order, matching how a "recent messages" view
 * actually reads. Scoped to source_type='message' specifically — EN-035's
 * wording is "last N messages," not "last N chunks of anything."
 */
export function recencyMode(retrievalDb: RetrievalDb, userId: string, n: number): ContentChunkRow[] {
  const rows = retrievalDb.db
    .prepare(
      `SELECT * FROM content_chunks
       WHERE user_id = ? AND source_type = 'message'
       ORDER BY COALESCE(occurred_at, recorded_at) DESC
       LIMIT ?`
    )
    .all(userId, n) as ContentChunkRow[];

  return rows.reverse();
}
