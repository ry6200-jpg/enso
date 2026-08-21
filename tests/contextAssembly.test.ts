import { describe, expect, it } from "vitest";
import { assembleContext, DEFAULT_CONTEXT_BUDGETS, type ContextBudgets } from "../src/conversation/contextAssembly.js";
import type { ContentChunkRow } from "../src/retrieval/retrievalDb.js";
import type { RecentTurnForPrompt } from "../src/persona/systemPrompt.js";

function chunk(id: string, text: string): ContentChunkRow {
  return {
    id,
    user_id: "u1",
    source_type: "message",
    source_event_id: "evt-" + id,
    extraction_event_id: null,
    chunk_index: 0,
    char_start: 0,
    char_end: text.length,
    text,
    occurred_at: null,
    recorded_at: "2026-01-01T00:00:00.000Z",
    fts_rowid: 1,
    vec_rowid: 1,
    created_at: "2026-01-01T00:00:00.000Z"
  };
}

const RETRIEVAL_META = { mode: "hybrid" as const, query: "test query" };

describe("assembleContext — retrieval budget (round-trip survival, CLAUDE.md)", () => {
  it("no candidates: reports zero candidates, empty injected ids, and truncated=false — never omits the fields", () => {
    const result = assembleContext([], RETRIEVAL_META, []);
    expect(result.retrieval.candidateCount).toBe(0);
    expect(result.retrieval.injectedChunkIds).toEqual([]);
    expect(result.retrieval.truncated).toBe(false);
  });

  it("under both budgets: every candidate is injected and truncated is false", () => {
    const chunks = [chunk("c1", "short text"), chunk("c2", "more short text")];
    const result = assembleContext(chunks, RETRIEVAL_META, []);
    expect(result.retrieval.injectedChunkIds).toEqual(["c1", "c2"]);
    expect(result.retrieval.candidateCount).toBe(2);
    expect(result.retrieval.truncated).toBe(false);
  });

  it("chunk-count budget cuts extra candidates and marks truncated=true", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRetrievedChunks: 2 };
    const chunks = [chunk("c1", "a"), chunk("c2", "b"), chunk("c3", "c")];
    const result = assembleContext(chunks, RETRIEVAL_META, [], budgets);
    expect(result.retrieval.injectedChunkIds).toEqual(["c1", "c2"]);
    expect(result.retrieval.candidateCount).toBe(3);
    expect(result.retrieval.truncated).toBe(true);
  });

  it("character budget stops injecting once the running total would exceed it, even under the chunk-count cap", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRetrievedChunks: 10, maxRetrievedChars: 10 };
    const chunks = [chunk("c1", "1234567890"), chunk("c2", "this one doesn't fit")];
    const result = assembleContext(chunks, RETRIEVAL_META, [], budgets);
    expect(result.retrieval.injectedChunkIds).toEqual(["c1"]);
    expect(result.retrieval.truncated).toBe(true);
  });

  it("a single chunk that alone exceeds the character budget is dropped entirely, not injected partially", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRetrievedChars: 5 };
    const chunks = [chunk("c1", "this text is way over five characters")];
    const result = assembleContext(chunks, RETRIEVAL_META, [], budgets);
    expect(result.retrieval.injectedChunkIds).toEqual([]);
    expect(result.retrieval.truncated).toBe(true);
  });

  it("order is preserved and determines which chunks survive a tight budget — later candidates are the ones cut", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRetrievedChunks: 1 };
    const chunks = [chunk("best-match", "x"), chunk("second-match", "y")];
    const result = assembleContext(chunks, RETRIEVAL_META, [], budgets);
    expect(result.retrieval.injectedChunkIds).toEqual(["best-match"]);
  });
});

describe("assembleContext — recent-window budget", () => {
  it("no recent turns: reports zero available/injected and truncated=false", () => {
    const result = assembleContext([], RETRIEVAL_META, []);
    expect(result.recentWindow).toEqual({ availableTurns: 0, injectedTurns: 0, truncated: false });
  });

  it("caps to the most recent N turns and marks truncated=true when more were available", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentTurns: 2 };
    const turns: RecentTurnForPrompt[] = [
      { role: "user", text: "zzqqturnONE" },
      { role: "enso", text: "zzqqturnTWO" },
      { role: "user", text: "zzqqturnTHREE" }
    ];
    const result = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(result.recentWindow).toEqual({ availableTurns: 3, injectedTurns: 2, truncated: true });
    // Keeps the most recent turns, not the oldest.
    expect(result.systemPrompt).toContain("zzqqturnTWO");
    expect(result.systemPrompt).toContain("zzqqturnTHREE");
    expect(result.systemPrompt).not.toContain("zzqqturnONE");
  });
});

describe("assembleContext — provenance metadata mirrors the actual invocation", () => {
  it("carries the retrieval mode and query through into the returned provenance, unchanged", () => {
    const result = assembleContext([], { mode: "entity", query: "Elena" }, []);
    expect(result.retrieval.mode).toBe("entity");
    expect(result.retrieval.query).toBe("Elena");
  });
});
