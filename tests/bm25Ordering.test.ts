import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { rankByFts } from "../src/retrieval/ftsRank.js";
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

async function insertText(text: string, id: string) {
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
      occurred_at: null,
      recorded_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    },
    embedding
  );
}

describe("THE BM25 TRAP (EN-035): FTS5's bm25() is negative-is-better, sort must be ASCENDING", () => {
  it("bm25() itself really does return negative scores, more negative for the better match — confirms the trap is real, not hypothetical", async () => {
    await insertText("vacation vacation vacation cabin lake mountains", "strong-match");
    await insertText("a completely unrelated sentence about spreadsheets", "no-match");

    const rows = retrievalDb.db
      .prepare(
        `SELECT cc.id as chunk_id, bm25(content_fts) as score
         FROM content_fts JOIN content_chunks cc ON cc.fts_rowid = content_fts.rowid
         WHERE content_fts MATCH ? ORDER BY content_fts.rowid`
      )
      .all('"vacation"') as { chunk_id: string; score: number }[];

    const strong = rows.find((r) => r.chunk_id === "strong-match")!;
    expect(strong.score).toBeLessThan(0); // negative, as documented
  });

  it("rankByFts returns the BEST match at rank 1 — proves the ascending sort, not a naive descending one", async () => {
    await insertText("vacation vacation vacation at the cabin by the lake", "best");
    await insertText("we went on vacation briefly", "medium");
    await insertText("nothing to do with the query at all", "irrelevant");

    const ranked = rankByFts(retrievalDb, PRIMARY_USER_ID, "vacation");

    expect(ranked[0]!.chunkId).toBe("best");
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked.find((r) => r.chunkId === "irrelevant")).toBeUndefined(); // FTS MATCH excludes non-matches entirely
  });

  it("REGRESSION GUARD: sorting bm25() DESCENDING (the naive mistake) reverses the ranking entirely", async () => {
    // Same word count/length on both sides so term-frequency is the only
    // variable — BM25's length normalization can otherwise make a short,
    // single-term document outscore a longer one with MORE repetitions of
    // the query term, which is a real, separate BM25 property (confirmed
    // while writing this test) and not what this specific test is isolating.
    await insertText("vacation vacation vacation vacation filler filler filler filler", "best");
    await insertText("vacation filler filler filler filler filler filler filler", "weak");

    const ascending = retrievalDb.db
      .prepare(
        `SELECT cc.id as chunk_id FROM content_fts JOIN content_chunks cc ON cc.fts_rowid = content_fts.rowid
         WHERE content_fts MATCH ? ORDER BY bm25(content_fts) ASC`
      )
      .all('"vacation"') as { chunk_id: string }[];
    const descendingWrong = retrievalDb.db
      .prepare(
        `SELECT cc.id as chunk_id FROM content_fts JOIN content_chunks cc ON cc.fts_rowid = content_fts.rowid
         WHERE content_fts MATCH ? ORDER BY bm25(content_fts) DESC`
      )
      .all('"vacation"') as { chunk_id: string }[];

    expect(ascending[0]!.chunk_id).toBe("best");
    expect(descendingWrong[0]!.chunk_id).toBe("weak"); // proves DESC really is backwards — the trap EN-035 warns about
    expect(ascending[0]!.chunk_id).not.toBe(descendingWrong[0]!.chunk_id);
  });

  it("multi-word queries are OR'd and each word is quote-escaped against FTS5 syntax injection", async () => {
    await insertText("Tahoe cabin trip", "a");
    await insertText("completely different content", "b");

    const ranked = rankByFts(retrievalDb, PRIMARY_USER_ID, 'Tahoe "quoted" AND');
    expect(ranked.some((r) => r.chunkId === "a")).toBe(true);
  });
});
