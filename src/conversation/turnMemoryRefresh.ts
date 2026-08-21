import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "../projections/db.js";
import type { RetrievalDb } from "../retrieval/retrievalDb.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { ExtractionRouter } from "../providers/router.js";
import { extractMessageWithResilience } from "../extraction/resilientExtraction.js";
import { rebuildProjections } from "../projections/rebuild.js";
import { rebuildRetrievalIndex } from "../retrieval/rebuildRetrievalIndex.js";

export interface TurnMemoryRefreshDeps {
  eventLog: EventLog;
  projectionsDb: ProjectionsDb;
  retrievalDb: RetrievalDb;
  embedder: Embedder;
  extractionRouter: ExtractionRouter;
}

/**
 * The post-reply half of a real turn (extraction + full projection/
 * retrieval-index rebuild) — factored out of scripts/chat.ts (Phase 5
 * Part 3) so the web app (Phase 7 Part 1) calls the exact same function
 * rather than re-implementing it in an API route. This is what "zero
 * pipeline logic duplicated into the web layer" means in practice: both
 * surfaces import this, neither reimplements it.
 */
export async function refreshMemoryAfterTurn(deps: TurnMemoryRefreshDeps, userId: string, messageEventId: string): Promise<void> {
  const messageEvent = deps.eventLog.getById(messageEventId)!;
  const knownPeopleNames = deps.projectionsDb.listEntities(userId).map((e) => e.name);
  await extractMessageWithResilience(deps.eventLog, deps.extractionRouter, messageEvent, undefined, knownPeopleNames);

  const allEvents = deps.eventLog.listForUser(userId);
  rebuildProjections(allEvents, deps.projectionsDb, userId);
  await rebuildRetrievalIndex(allEvents, deps.retrievalDb, userId, deps.embedder);
}
