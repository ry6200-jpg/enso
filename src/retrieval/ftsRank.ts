import type { RetrievalDb } from "./retrievalDb.js";

export interface RankedChunk {
  chunkId: string;
  rank: number; // 1-indexed, 1 = best match
}

/**
 * FTS5's query syntax treats punctuation and bare operator words (AND/OR/
 * NOT) specially, so a raw user query can throw a syntax error or match
 * nothing intended. Each word is quoted (safe against punctuation) and
 * joined with OR — FTS's job in the hybrid is precise keyword/name/date
 * recall (EN-035); the vector side covers semantic recall, so erring
 * toward more keyword matches here is the right default.
 */
export function buildFtsQuery(query: string): string {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/"/g, '""').trim())
    .filter((w) => w.length > 0);
  return words.map((w) => `"${w}"`).join(" OR ");
}

/**
 * FTS5 rank list (EN-035). THE BM25 TRAP: FTS5's bm25() returns NEGATIVE
 * values where MORE NEGATIVE is a BETTER match — naively sorting
 * descending (as you would for a "higher score is better" ranking
 * function) puts the WORST matches first. This queries `ORDER BY bm25(...)
 * ASC` explicitly, so the most-negative (best) row comes back first, and
 * 1-indexed ranks are assigned in that order.
 */
export function rankByFts(retrievalDb: RetrievalDb, userId: string, query: string, limit = 50): RankedChunk[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = retrievalDb.db
    .prepare(
      `SELECT cc.id as chunk_id, bm25(content_fts) as score
       FROM content_fts
       JOIN content_chunks cc ON cc.fts_rowid = content_fts.rowid
       WHERE content_fts MATCH ? AND cc.user_id = ?
       ORDER BY bm25(content_fts) ASC
       LIMIT ?`
    )
    .all(ftsQuery, userId, limit) as { chunk_id: string; score: number }[];

  return rows.map((row, index) => ({ chunkId: row.chunk_id, rank: index + 1 }));
}
