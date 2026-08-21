import type { Embedder } from "../embeddings/embedder.js";
import { rankByFts } from "./ftsRank.js";
import { rankByRecency } from "./recencyRank.js";
import { rankByVector } from "./vectorRank.js";
import type { RetrievalDb } from "./retrievalDb.js";

/**
 * The query-conditional recency weight, w_t(q) (EN-035). A cheap local
 * heuristic for this phase — the interface is shaped so Phase 6's intent
 * router can take over setting it later without any caller-side change:
 * `hybridSearch`'s `temporalWeight` option accepts a plain number (what a
 * router would supply, having already made its judgment call) as an
 * override; when omitted, this heuristic runs instead. Nothing about the
 * fusion math needs to know or care which one produced the number.
 */
const POSITIVE_TEMPORAL_WEIGHT = 1.0;
const NEGATIVE_TEMPORAL_WEIGHT = -1.0;

const RECENT_PHRASES = /\b(recently|lately|these days|just now|the other day|latest)\b/i;
const EARLIEST_PHRASES = /\b(first time|the first|earliest|originally|initially|when we first)\b/i;

export function computeTemporalWeightHeuristic(query: string): number {
  if (EARLIEST_PHRASES.test(query)) return NEGATIVE_TEMPORAL_WEIGHT;
  if (RECENT_PHRASES.test(query)) return POSITIVE_TEMPORAL_WEIGHT;
  return 0;
}

export interface HybridSearchOptions {
  /** RRF constant — spec-recommended low init (~10-20), not the web-scale 60. */
  k?: number;
  /** w_t(q) override. Omit to use the local heuristic; Phase 6's router supplies this directly once it exists. */
  temporalWeight?: number;
  limit?: number;
  /** How many candidates each individual rank list considers before fusion. */
  candidatePoolSize?: number;
}

export interface HybridResult {
  chunkId: string;
  score: number;
  ftsRank: number | null;
  vecRank: number | null;
  timeRank: number | null;
}

const DEFAULT_K = 15; // spec: "~10-20, not the web-scale 60"

/**
 * Hybrid search (EN-035): RRF over FTS + vector + recency.
 * RRF(d,q) = 1/(k+r_fts(d)) + 1/(k+r_vec(d)) + w_t(q)/(k+r_time(d))
 *
 * The recency term is a re-ranking WEIGHT over candidates FTS or vector
 * already surfaced, not a third independent retrieval channel — a chunk
 * that matched neither keyword nor semantic search doesn't get pulled in
 * just because it's recent (that's what the separate recency MODE is
 * for). A chunk absent from a given rank list contributes 0 for that term
 * (standard RRF convention for a list it didn't place in).
 */
export async function hybridSearch(
  retrievalDb: RetrievalDb,
  userId: string,
  query: string,
  embedder: Embedder,
  options: HybridSearchOptions = {}
): Promise<HybridResult[]> {
  const k = options.k ?? DEFAULT_K;
  const limit = options.limit ?? 20;
  const poolSize = options.candidatePoolSize ?? 100;
  const w_t = options.temporalWeight ?? computeTemporalWeightHeuristic(query);

  const ftsList = rankByFts(retrievalDb, userId, query, poolSize);
  const queryEmbedding = await embedder.embed(query);
  const vecList = rankByVector(retrievalDb, userId, queryEmbedding, poolSize);
  const timeList = rankByRecency(retrievalDb, userId, poolSize);

  const ftsRanks = new Map(ftsList.map((r) => [r.chunkId, r.rank]));
  const vecRanks = new Map(vecList.map((r) => [r.chunkId, r.rank]));
  const timeRanks = new Map(timeList.map((r) => [r.chunkId, r.rank]));

  // Candidate universe is FTS ∪ vector only — recency re-ranks, it doesn't retrieve.
  const candidateIds = new Set([...ftsRanks.keys(), ...vecRanks.keys()]);

  const results: HybridResult[] = [];
  for (const chunkId of candidateIds) {
    const rf = ftsRanks.get(chunkId) ?? null;
    const rv = vecRanks.get(chunkId) ?? null;
    const rt = timeRanks.get(chunkId) ?? null;

    const score = (rf !== null ? 1 / (k + rf) : 0) + (rv !== null ? 1 / (k + rv) : 0) + (w_t !== 0 && rt !== null ? w_t / (k + rt) : 0);

    results.push({ chunkId, score, ftsRank: rf, vecRank: rv, timeRank: rt });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
