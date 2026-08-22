import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { rankByFts } from "../src/retrieval/ftsRank.js";
import { rankByVector } from "../src/retrieval/vectorRank.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { CHUNKING_PRESETS } from "../src/retrieval/chunking.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let retrievalDb: RetrievalDb;
let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
});

describe("rebuildRetrievalIndex (EN-035/062)", () => {
  it("indexes message text unconditionally from message_sent, regardless of extraction outcome", async () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "A week at the cabin in Tahoe." }, userId: PRIMARY_USER_ID });

    const result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(result.messagesIndexed).toBe(1);
    const chunks = retrievalDb.getChunksBySourceEventId(msg.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("A week at the cabin in Tahoe.");
    expect(chunks[0]!.source_type).toBe("message");
  });

  it("indexes document full text, chunked, with correct provenance (source_event_id = upload, extraction_event_id = the extraction)", async () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "trip.pdf", mimeType: "application/pdf", byteLength: 10, path: "x" }, userId: PRIMARY_USER_ID });
    const longText = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(40)}`).join("\n\n");
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, kind: "document", fullText: longText, entities: [] },
      userId: PRIMARY_USER_ID
    });

    const result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder, CHUNKING_PRESETS.small);

    expect(result.documentsIndexed).toBe(1);
    const chunks = retrievalDb.getChunksBySourceEventId(upload.id);
    expect(chunks.length).toBeGreaterThan(1); // long enough to actually chunk
    expect(chunks.every((c) => c.extraction_event_id === extraction.id)).toBe(true);
    expect(chunks.every((c) => c.source_type === "document")).toBe(true);
    // provenance integrity: every chunk's span really is that slice of the original document
    for (const chunk of chunks) {
      expect(longText.slice(chunk.char_start, chunk.char_end)).toBe(chunk.text);
    }
  });

  it("indexes image descriptions as a single chunk with provenance to the upload and its extraction", async () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "photo.jpg", mimeType: "image/jpeg", byteLength: 10, path: "x" }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, kind: "image", description: "A cabin by a lake in the mountains." },
      userId: PRIMARY_USER_ID
    });

    const result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(result.imagesIndexed).toBe(1);
    const chunks = retrievalDb.getChunksBySourceEventId(upload.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.source_type).toBe("image_description");
    expect(chunks[0]!.extraction_event_id).toBe(extraction.id);
  });

  it("is a rebuild, not a reprocess: clears and regenerates rather than accumulating across calls", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "First message." }, userId: PRIMARY_USER_ID });
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(retrievalDb.listChunks(PRIMARY_USER_ID)).toHaveLength(1); // not 2
  });

  it("both FTS and vector search find the indexed message (end-to-end sanity)", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "A week at the cabin in Tahoe was wonderful." }, userId: PRIMARY_USER_ID });
    await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    const ftsResults = rankByFts(retrievalDb, PRIMARY_USER_ID, "Tahoe");
    expect(ftsResults.length).toBeGreaterThan(0);

    const queryEmbedding = await embedder.embed("a mountain vacation");
    const vecResults = rankByVector(retrievalDb, PRIMARY_USER_ID, queryEmbedding);
    expect(vecResults.length).toBeGreaterThan(0);
  });
});

describe("rebuildRetrievalIndex + upload deletion (EN-065)", () => {
  it("a deleted upload's document content is no longer indexed after rebuild — never retrievable again", async () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "trip.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: upload.id, kind: "document", fullText: "A very specific plan involving Lisbon and fado music.", entities: [] },
      userId: PRIMARY_USER_ID
    });

    let result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);
    expect(result.documentsIndexed).toBe(1);
    expect(retrievalDb.getChunksBySourceEventId(upload.id).length).toBeGreaterThan(0);

    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "trip.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });
    result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(result.documentsIndexed).toBe(0);
    expect(retrievalDb.getChunksBySourceEventId(upload.id)).toHaveLength(0);
    const ftsResults = rankByFts(retrievalDb, PRIMARY_USER_ID, "Lisbon");
    expect(ftsResults).toHaveLength(0);
  });

  it("a deleted upload's image description is no longer indexed after rebuild", async () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "photo.jpg", mimeType: "image/jpeg", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, kind: "image", description: "A cat on a windowsill." }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "photo.jpg", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    const result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(result.imagesIndexed).toBe(0);
    expect(retrievalDb.getChunksBySourceEventId(upload.id)).toHaveLength(0);
  });

  it("deleting one upload never affects an unrelated message's indexing", async () => {
    const upload = eventLog.append({ type: "file_uploaded", actor: "user", payload: { filename: "trip.pdf", mimeType: "application/pdf", byteLength: 1, path: "x" }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: upload.id, kind: "document", fullText: "Trip details.", entities: [] }, userId: PRIMARY_USER_ID });
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Unrelated message about work." }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "upload_deleted", actor: "user", payload: { uploadEventId: upload.id, filename: "trip.pdf", removedFactCount: 0, preservedFactCount: 0 }, userId: PRIMARY_USER_ID });

    const result = await rebuildRetrievalIndex(eventLog.listForUser(PRIMARY_USER_ID), retrievalDb, PRIMARY_USER_ID, embedder);

    expect(result.messagesIndexed).toBe(1);
    expect(retrievalDb.getChunksBySourceEventId(msg.id)).toHaveLength(1);
  });
});
