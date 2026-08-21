import type { RankedChunk } from "./ftsRank.js";
import type { RetrievalDb } from "./retrievalDb.js";

/**
 * Recency rank list for hybrid fusion (EN-035): ordered by `occurred_at`
 * falling back to `recorded_at`, most recent first (rank 1). This is one
 * of the three lists RRF fuses — not the same thing as EN-035's separate
 * "recency" retrieval MODE (see recencyMode.ts), which returns raw
 * messages verbatim rather than participating in a fused ranking.
 */
export function rankByRecency(retrievalDb: RetrievalDb, userId: string, limit = 100): RankedChunk[] {
  const rows = retrievalDb.db
    .prepare(
      `SELECT id as chunk_id FROM content_chunks
       WHERE user_id = ?
       ORDER BY COALESCE(occurred_at, recorded_at) DESC
       LIMIT ?`
    )
    .all(userId, limit) as { chunk_id: string }[];

  return rows.map((row, index) => ({ chunkId: row.chunk_id, rank: index + 1 }));
}
