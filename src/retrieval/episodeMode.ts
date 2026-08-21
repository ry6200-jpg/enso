import type { ContentChunkRow } from "./retrievalDb.js";

/**
 * Episode retrieval mode (EN-037) — interface stubbed only. Episode
 * clustering itself (the projection that groups related messages into a
 * named incident) is Phase 8.5 work, built on top of this proven
 * foundation, not before it. This function exists now so the CALL
 * SIGNATURE and RETURN SHAPE are settled — an episode match returns the
 * bounded sequence of raw source messages, never a summary, exactly like
 * every other retrieval mode — without building the clustering logic
 * itself early.
 */
export interface EpisodeMatch {
  episodeId: string;
  title: string;
  chunks: ContentChunkRow[];
}

export class EpisodeModeNotImplementedError extends Error {
  constructor() {
    super("Episode retrieval mode is not implemented until Phase 8.5 (EN-037 episode clustering). This is a stubbed interface only.");
    this.name = "EpisodeModeNotImplementedError";
  }
}

export function episodeMode(_userId: string, _episodeId: string): EpisodeMatch {
  throw new EpisodeModeNotImplementedError();
}
