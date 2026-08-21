import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rebuildRetrievalIndex } from "../src/retrieval/rebuildRetrievalIndex.js";
import { compareRetrievalIndexExact } from "../src/retrieval/retrievalComparator.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

describe("compareRetrievalIndexExact (EN-054/057 v1.5, strict-exact for the retrieval projection)", () => {
  it("two independent rebuilds of the same log are exactly equivalent, including byte-identical embeddings", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "A week at the cabin in Tahoe." }, userId: PRIMARY_USER_ID });
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Called Priya about the trip." }, userId: PRIMARY_USER_ID });
    const events = eventLog.listForUser(PRIMARY_USER_ID);

    const dbA = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval-a"));
    const dbB = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval-b"));
    await rebuildRetrievalIndex(events, dbA, PRIMARY_USER_ID, embedder);
    await rebuildRetrievalIndex(events, dbB, PRIMARY_USER_ID, embedder);

    const comparison = compareRetrievalIndexExact(dbA, dbB, PRIMARY_USER_ID);
    expect(comparison).toEqual({ equivalent: true, differences: [] });
  });

  it("catches a planted difference: a chunk present in only one rebuild", async () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Message one." }, userId: PRIMARY_USER_ID });
    const events = eventLog.listForUser(PRIMARY_USER_ID);

    const dbA = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval-c"));
    const dbB = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval-d"));
    await rebuildRetrievalIndex(events, dbA, PRIMARY_USER_ID, embedder);
    await rebuildRetrievalIndex(events, dbB, PRIMARY_USER_ID, embedder);

    // Plant a difference: add an extra chunk only to dbB.
    const extraEmbedding = await embedder.embed("An extra chunk that shouldn't be here.");
    dbB.insertChunk(
      {
        id: "planted",
        user_id: PRIMARY_USER_ID,
        source_type: "message",
        source_event_id: "fake-source",
        extraction_event_id: null,
        chunk_index: 0,
        char_start: 0,
        char_end: 10,
        text: "An extra chunk that shouldn't be here.",
        occurred_at: null,
        recorded_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      },
      extraEmbedding
    );

    const comparison = compareRetrievalIndexExact(dbA, dbB, PRIMARY_USER_ID);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.differences.some((d) => d.includes("only in B"))).toBe(true);
  });
});
