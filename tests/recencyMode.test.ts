import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { recencyMode } from "../src/retrieval/recencyMode.js";
import { configureLocalOnlyEmbeddings, createEmbedder, type Embedder } from "../src/embeddings/embedder.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let retrievalDb: RetrievalDb;
let embedder: Embedder;

beforeAll(async () => {
  configureLocalOnlyEmbeddings();
  embedder = await createEmbedder();
});

beforeEach(() => {
  retrievalDb = new RetrievalDb(freshTestDbPath(import.meta.url, "retrieval"));
});

async function insertMessage(text: string, occurredAt: string, id: string) {
  const embedding = await embedder.embed(text);
  retrievalDb.insertChunk(
    {
      id,
      user_id: PRIMARY_USER_ID,
      source_type: "message",
      source_event_id: `src-${id}`,
      extraction_event_id: null,
      chunk_index: 0,
      char_start: 0,
      char_end: text.length,
      text,
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      created_at: occurredAt
    },
    embedding
  );
}

describe("recencyMode (EN-035): last N messages verbatim, no search term", () => {
  it("returns the last N messages in chronological order, most recent last", async () => {
    await insertMessage("Message one.", "2026-01-01T00:00:00.000Z", "m1");
    await insertMessage("Message two.", "2026-01-02T00:00:00.000Z", "m2");
    await insertMessage("Message three.", "2026-01-03T00:00:00.000Z", "m3");
    await insertMessage("Message four.", "2026-01-04T00:00:00.000Z", "m4");

    const result = recencyMode(retrievalDb, PRIMARY_USER_ID, 2);

    expect(result.map((r) => r.id)).toEqual(["m3", "m4"]); // last 2, oldest-of-the-2 first
    expect(result.every((r) => r.text.length > 0)).toBe(true); // raw text, not a summary
  });

  it("works with no search term at all — the whole point of this mode", async () => {
    await insertMessage("Anything.", "2026-01-01T00:00:00.000Z", "m1");
    const result = recencyMode(retrievalDb, PRIMARY_USER_ID, 5);
    expect(result).toHaveLength(1);
  });

  it("only returns messages, not document/image chunks", async () => {
    await insertMessage("A real message.", "2026-01-01T00:00:00.000Z", "m1");
    const embedding = await embedder.embed("A document chunk.");
    retrievalDb.insertChunk(
      {
        id: "doc1",
        user_id: PRIMARY_USER_ID,
        source_type: "document",
        source_event_id: "upload1",
        extraction_event_id: "ext1",
        chunk_index: 0,
        char_start: 0,
        char_end: 10,
        text: "A document chunk.",
        occurred_at: "2026-01-02T00:00:00.000Z",
        recorded_at: "2026-01-02T00:00:00.000Z",
        created_at: "2026-01-02T00:00:00.000Z"
      },
      embedding
    );

    const result = recencyMode(retrievalDb, PRIMARY_USER_ID, 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("m1");
  });
});
