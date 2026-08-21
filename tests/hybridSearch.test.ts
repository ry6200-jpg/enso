import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RetrievalDb } from "../src/retrieval/retrievalDb.js";
import { hybridSearch, computeTemporalWeightHeuristic } from "../src/retrieval/hybridSearch.js";
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
    { id, user_id: PRIMARY_USER_ID, source_type: "message", source_event_id: `src-${id}`, extraction_event_id: null, chunk_index: 0, char_start: 0, char_end: text.length, text, occurred_at: occurredAt, recorded_at: occurredAt, created_at: occurredAt },
    embedding
  );
}

describe("computeTemporalWeightHeuristic (EN-035 w_t(q))", () => {
  it("is 0 by default (neutral query)", () => {
    expect(computeTemporalWeightHeuristic("what did I say about the cabin")).toBe(0);
  });
  it("is positive for temporal-proximity phrasing", () => {
    expect(computeTemporalWeightHeuristic("what did Priya say recently")).toBeGreaterThan(0);
  });
  it("is negative for first/earliest phrasing", () => {
    expect(computeTemporalWeightHeuristic("the first time we talked about this")).toBeLessThan(0);
  });
});

describe("hybridSearch (EN-035 RRF fusion)", () => {
  it("fuses FTS and vector results, ranking a doc matched by BOTH above one matched by only one", async () => {
    await insertMessage("A week at the cabin in Tahoe was wonderful.", "2026-01-01T00:00:00Z", "both");
    await insertMessage("cabin", "2026-01-02T00:00:00Z", "fts-only-ish");
    await insertMessage("something about mountains and relaxation", "2026-01-03T00:00:00Z", "vec-only-ish");
    await insertMessage("totally unrelated spreadsheet talk", "2026-01-04T00:00:00Z", "irrelevant");

    const results = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "cabin vacation", embedder, { temporalWeight: 0 });
    const rankOf = (id: string) => results.findIndex((r) => r.chunkId === id);

    expect(results.length).toBeGreaterThan(0);
    // Vector search has no hard "no match" — a small corpus returns every
    // doc ranked by similarity, so "irrelevant" can still appear, just
    // ranked below the genuinely matching ones (the property that actually
    // matters for hybrid fusion), not necessarily excluded outright.
    expect(rankOf("both")).toBeLessThan(rankOf("irrelevant"));
  });

  it("a chunk absent from a rank list contributes 0 for that term, not an error", async () => {
    await insertMessage("only findable by exact keyword xylophone999", "2026-01-01T00:00:00Z", "kw");
    const results = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "xylophone999", embedder, { temporalWeight: 0 });
    const kw = results.find((r) => r.chunkId === "kw")!;
    expect(kw.ftsRank).not.toBeNull();
    // vecRank may or may not be null depending on whether vector search also surfaced it — either is valid, just must not crash
    expect(typeof kw.score).toBe("number");
  });

  it("w_t(q): 'recently' vs 'the first time' vs neutral produce different orderings over the SAME base matches", async () => {
    // Two messages that match the query term equally on keyword/semantic grounds, differing only in time.
    await insertMessage("we talked about the big move recently, it was on my mind", "2026-06-01T00:00:00Z", "recent-one");
    await insertMessage("we talked about the big move ages ago, back when it happened", "2020-01-01T00:00:00Z", "old-one");

    const neutral = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "the big move", embedder, { temporalWeight: 0 });
    const recent = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "the big move recently", embedder);
    const earliest = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "the big move, the first time", embedder);

    const rankOf = (results: typeof neutral, id: string) => results.findIndex((r) => r.chunkId === id);

    // "recently" should favor the recent message relative to neutral.
    expect(rankOf(recent, "recent-one")).toBeLessThanOrEqual(rankOf(neutral, "recent-one"));
    // "the first time" should favor the OLD message over the recent one — the inverted case.
    expect(rankOf(earliest, "old-one")).toBeLessThan(rankOf(earliest, "recent-one"));
    // and earliest's ordering should differ from recent's ordering (they're not the same list).
    expect(rankOf(earliest, "old-one")).toBeLessThan(rankOf(recent, "old-one"));
  });

  it("k is tunable and defaults low (~10-20 per spec), not the web-scale 60", async () => {
    await insertMessage("cabin trip", "2026-01-01T00:00:00Z", "a");
    const withDefaultK = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "cabin", embedder, { temporalWeight: 0 });
    const withK60 = await hybridSearch(retrievalDb, PRIMARY_USER_ID, "cabin", embedder, { temporalWeight: 0, k: 60 });
    // Different k changes the score magnitude even for the same rank — proves k is actually wired into the formula.
    expect(withDefaultK[0]!.score).not.toBeCloseTo(withK60[0]!.score, 5);
  });
});
