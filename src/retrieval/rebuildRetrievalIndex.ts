import { newId } from "../ids.js";
import type { EventRecord } from "../events/schema.js";
import type { Embedder } from "../embeddings/embedder.js";
import { computeEclipsedEventIds } from "../attachments/uploadDeletion.js";
import { chunkText, DEFAULT_CHUNKING_CONFIG, type ChunkingConfig } from "./chunking.js";
import type { RetrievalDb } from "./retrievalDb.js";

interface MessageSentPayload {
  text: string;
}
interface ExtractionCompletedPayload {
  sourceEventId: string;
  kind?: "message" | "document" | "image";
  fullText?: string;
  description?: string;
}

export interface RetrievalRebuildResult {
  chunksWritten: number;
  messagesIndexed: number;
  documentsIndexed: number;
  imagesIndexed: number;
}

/**
 * Rebuilds the retrieval index (EN-035/062): FTS5 + vector chunks, derived
 * entirely from recorded events — a rebuildable projection like everything
 * else. Message text is indexed unconditionally from message_sent (history
 * retrieval must work even if entity extraction later failed on that
 * message — EN-035 vs the entity/relationship pipeline are independent
 * concerns). Document full text and image descriptions only exist inside
 * extraction_completed payloads, so they're necessarily indexed from there.
 *
 * Unlike rebuildProjections (EN-054, synchronous — no extraction ever
 * runs), this function is genuinely async: computing an embedding is real
 * (if local, free, and deterministic) inference work. It is still
 * "rebuild" in EN-054's sense, not reprocess — it never calls a provider,
 * never costs money, and produces byte-identical output for byte-identical
 * input (proven in Part 1's determinism test) — the sync/async split here
 * is a technical necessity (you cannot await inside better-sqlite3's
 * synchronous transaction callbacks that rebuildProjections uses), not an
 * architectural blurring of rebuild and reprocess.
 */
export async function rebuildRetrievalIndex(
  events: EventRecord[],
  retrievalDb: RetrievalDb,
  userId: string,
  embedder: Embedder,
  chunkingConfig: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<RetrievalRebuildResult> {
  retrievalDb.clear();

  // EN-065: a document/image extraction_completed event derived from a
  // deleted upload is skipped below exactly like rebuildProjections skips
  // it — same shared function, same notion of "eclipsed," so a deleted
  // attachment's content stops being retrievable in the same rebuild pass
  // that stops it from producing entities/attributes/atoms/bonds.
  const eclipsedEventIds = computeEclipsedEventIds(events);

  const extractionBySourceId = new Map<string, EventRecord & { payload: ExtractionCompletedPayload }>();
  for (const event of events) {
    if (event.type === "extraction_completed") {
      const payload = event.payload as ExtractionCompletedPayload;
      if (payload.sourceEventId) extractionBySourceId.set(payload.sourceEventId, event as EventRecord & { payload: ExtractionCompletedPayload });
    }
  }

  let chunksWritten = 0;
  let messagesIndexed = 0;
  let documentsIndexed = 0;
  let imagesIndexed = 0;

  for (const event of events) {
    if (event.type === "message_sent") {
      const text = (event.payload as MessageSentPayload).text;
      const extractionEvent = extractionBySourceId.get(event.id);
      const embedding = await embedder.embed(text);
      retrievalDb.insertChunk(
        {
          id: newId(),
          user_id: userId,
          source_type: "message",
          source_event_id: event.id,
          extraction_event_id: extractionEvent?.id ?? null,
          chunk_index: 0,
          char_start: 0,
          char_end: text.length,
          text,
          occurred_at: event.occurredAt,
          recorded_at: event.recordedAt,
          created_at: new Date().toISOString()
        },
        embedding
      );
      chunksWritten++;
      messagesIndexed++;
    }

    if (event.type === "extraction_completed" && !eclipsedEventIds.has(event.id)) {
      const payload = event.payload as ExtractionCompletedPayload;

      if (payload.kind === "document" && typeof payload.fullText === "string") {
        const chunks = chunkText(payload.fullText, chunkingConfig);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const embedding = await embedder.embed(chunk.text);
          retrievalDb.insertChunk(
            {
              id: newId(),
              user_id: userId,
              source_type: "document",
              source_event_id: payload.sourceEventId,
              extraction_event_id: event.id,
              chunk_index: i,
              char_start: chunk.charStart,
              char_end: chunk.charEnd,
              text: chunk.text,
              occurred_at: event.occurredAt,
              recorded_at: event.recordedAt,
              created_at: new Date().toISOString()
            },
            embedding
          );
          chunksWritten++;
        }
        documentsIndexed++;
      }

      if (payload.kind === "image" && typeof payload.description === "string") {
        const embedding = await embedder.embed(payload.description);
        retrievalDb.insertChunk(
          {
            id: newId(),
            user_id: userId,
            source_type: "image_description",
            source_event_id: payload.sourceEventId,
            extraction_event_id: event.id,
            chunk_index: 0,
            char_start: 0,
            char_end: payload.description.length,
            text: payload.description,
            occurred_at: event.occurredAt,
            recorded_at: event.recordedAt,
            created_at: new Date().toISOString()
          },
          embedding
        );
        chunksWritten++;
        imagesIndexed++;
      }
    }
  }

  return { chunksWritten, messagesIndexed, documentsIndexed, imagesIndexed };
}
