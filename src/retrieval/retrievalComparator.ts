import type { RetrievalDb } from "./retrievalDb.js";

export interface RetrievalExactComparisonResult {
  equivalent: boolean;
  differences: string[];
}

/**
 * Strict-exact comparison for the retrieval index (EN-054/057 v1.5):
 * rebuild is deterministic (no extraction, and embeddings are
 * deterministic for a fixed model — Part 1), so two independent rebuilds
 * of the same log must produce identical chunk text/provenance AND
 * byte-identical embedding vectors. Ephemeral fields (id, fts_rowid,
 * vec_rowid, created_at) are excluded, same principle as
 * compareExact for entities — those are regenerated every rebuild by
 * design and were never meant to be stable.
 */
export function compareRetrievalIndexExact(a: RetrievalDb, b: RetrievalDb, userId: string): RetrievalExactComparisonResult {
  const differences: string[] = [];

  const chunksA = a.listChunks(userId);
  const chunksB = b.listChunks(userId);

  function key(source_type: string, source_event_id: string, chunk_index: number, text: string): string {
    return JSON.stringify({ source_type, source_event_id, chunk_index, text });
  }

  const byKeyA = new Map(chunksA.map((c) => [key(c.source_type, c.source_event_id, c.chunk_index, c.text), c]));
  const byKeyB = new Map(chunksB.map((c) => [key(c.source_type, c.source_event_id, c.chunk_index, c.text), c]));

  for (const k of byKeyA.keys()) if (!byKeyB.has(k)) differences.push(`chunk only in A: ${k}`);
  for (const k of byKeyB.keys()) if (!byKeyA.has(k)) differences.push(`chunk only in B: ${k}`);

  for (const [k, chunkA] of byKeyA) {
    const chunkB = byKeyB.get(k);
    if (!chunkB) continue;

    const embA = a.getEmbeddingForChunk(chunkA.id);
    const embB = b.getEmbeddingForChunk(chunkB.id);
    if (!embA || !embB) {
      differences.push(`missing embedding for chunk: ${k}`);
      continue;
    }
    if (embA.length !== embB.length || !embA.every((v, i) => v === embB[i])) {
      differences.push(`embedding vector differs for chunk: ${k}`);
    }
  }

  return { equivalent: differences.length === 0, differences };
}
