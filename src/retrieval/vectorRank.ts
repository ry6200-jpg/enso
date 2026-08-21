import type { RetrievalDb } from "./retrievalDb.js";
import type { RankedChunk } from "./ftsRank.js";

/**
 * Vector rank list (EN-035): nearest-neighbor search over content_vec,
 * ordered by ascending distance (closest first — this direction is
 * correct by default in sqlite-vec, unlike bm25()'s trap on the FTS side).
 * Filtered to the given user's chunks by joining back to content_chunks,
 * since vec0 itself carries no user_id.
 */
export function rankByVector(retrievalDb: RetrievalDb, userId: string, queryEmbedding: Float32Array, limit = 50): RankedChunk[] {
  const rows = retrievalDb.db
    .prepare(
      `SELECT cc.id as chunk_id, v.distance as distance
       FROM (
         SELECT rowid, distance FROM content_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?
       ) v
       JOIN content_chunks cc ON cc.vec_rowid = v.rowid
       WHERE cc.user_id = ?
       ORDER BY v.distance ASC`
    )
    .all(Buffer.from(queryEmbedding.buffer), limit * 4, userId) as { chunk_id: string; distance: number }[]; // over-fetch before the user filter, since vec0 can't filter by user_id itself

  return rows.slice(0, limit).map((row, index) => ({ chunkId: row.chunk_id, rank: index + 1 }));
}
