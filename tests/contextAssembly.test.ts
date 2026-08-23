import { describe, expect, it } from "vitest";
import { assembleContext, DEFAULT_CONTEXT_BUDGETS, type ContextBudgets } from "../src/conversation/contextAssembly.js";
import type { ContentChunkRow } from "../src/retrieval/retrievalDb.js";
import type { RecentTurnForPrompt } from "../src/persona/systemPrompt.js";

function chunk(id: string, text: string, sourceEventId: string = "evt-" + id): ContentChunkRow {
  return {
    id,
    user_id: "u1",
    source_type: "message",
    source_event_id: sourceEventId,
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
    expect(result.retrieval.dedupedCount).toBe(0);
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

describe("assembleContext — retrieval dedup against the recent window (Part B-0)", () => {
  it("a candidate chunk whose source message is already in the recent window is skipped, never consumes a retrieval slot, and is counted in dedupedCount", () => {
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "I live in Austin.", eventId: "evt-dup" }];
    const chunks = [chunk("c1", "I live in Austin.", "evt-dup"), chunk("c2", "unrelated chunk")];
    const result = assembleContext(chunks, RETRIEVAL_META, turns, DEFAULT_CONTEXT_BUDGETS);
    expect(result.retrieval.injectedChunkIds).toEqual(["c2"]);
    expect(result.retrieval.dedupedCount).toBe(1);
    expect(result.retrieval.truncated).toBe(false); // a dedup is never counted as a budget cut
  });

  it("a chunk with no matching eventId in the window is never deduped — safe no-op default for hand-built turns", () => {
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "no eventId on this turn" }];
    const chunks = [chunk("c1", "some retrieved text")];
    const result = assembleContext(chunks, RETRIEVAL_META, turns, DEFAULT_CONTEXT_BUDGETS);
    expect(result.retrieval.injectedChunkIds).toEqual(["c1"]);
    expect(result.retrieval.dedupedCount).toBe(0);
  });

  it("dedup happens BEFORE the chunk-count budget, so a deduped chunk never displaces a real candidate from the slots", () => {
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "dup", eventId: "evt-dup" }];
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRetrievedChunks: 1 };
    const chunks = [chunk("dup-chunk", "dup", "evt-dup"), chunk("real", "real content")];
    const result = assembleContext(chunks, RETRIEVAL_META, turns, budgets);
    expect(result.retrieval.injectedChunkIds).toEqual(["real"]);
    expect(result.retrieval.dedupedCount).toBe(1);
  });
});

describe("assembleContext — recent-window budget is a character budget, not a turn count (Part B-0)", () => {
  it("no recent turns: reports zero available/injected and truncated=false", () => {
    const result = assembleContext([], RETRIEVAL_META, []);
    expect(result.recentWindow).toEqual({ availableTurns: 0, injectedTurns: 0, truncated: false });
  });

  it("under budget: the ENTIRE session is injected, not capped to a fixed count — the whole point of Part B-0", () => {
    const turns: RecentTurnForPrompt[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("enso" as const), text: `turn-${i}` }));
    const result = assembleContext([], RETRIEVAL_META, turns);
    expect(result.recentWindow).toEqual({ availableTurns: 40, injectedTurns: 40, truncated: false });
    expect(result.systemPrompt).toContain("turn-0"); // the OLDEST turn — would have been cut under the old 6-turn cap
    expect(result.systemPrompt).toContain("turn-39");
  });

  it("over budget: keeps the MOST RECENT turns verbatim and drops from the OLDEST end only, marks truncated=true", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 20 };
    const turns: RecentTurnForPrompt[] = [
      { role: "user", text: "zzqqturnONE" },
      { role: "enso", text: "zzqqturnTWO" },
      { role: "user", text: "zzqqturnTHREE" }
    ];
    const result = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(result.recentWindow.truncated).toBe(true);
    expect(result.recentWindow.availableTurns).toBe(3);
    // Keeps the most recent turns, not the oldest — never the middle either.
    expect(result.systemPrompt).toContain("zzqqturnTHREE");
    expect(result.systemPrompt).not.toContain("zzqqturnONE");
  });

  it("a single most-recent turn that alone exceeds the budget is dropped entirely, same precedent as retrieval's char budget", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 5 };
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "this text is way over five characters" }];
    const result = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(result.recentWindow).toEqual({ availableTurns: 1, injectedTurns: 0, truncated: true });
  });

  it("truncation is disclosed explicitly in the prompt text itself (memory-honesty principle applied to the window, not just retrieval)", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 20 };
    const turns: RecentTurnForPrompt[] = [
      { role: "user", text: "zzqqturnONE" },
      { role: "user", text: "zzqqturnTWO" }
    ];
    const truncatedResult = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(truncatedResult.systemPrompt).toMatch(/aren't shown|beyond what's visible/i);

    const untruncatedResult = assembleContext([], RETRIEVAL_META, [{ role: "user", text: "short" }]);
    expect(untruncatedResult.systemPrompt).not.toMatch(/aren't shown|beyond what's visible/i);
  });
});

describe("assembleContext — provenance metadata mirrors the actual invocation", () => {
  it("carries the retrieval mode and query through into the returned provenance, unchanged", () => {
    const result = assembleContext([], { mode: "entity", query: "Elena" }, []);
    expect(result.retrieval.mode).toBe("entity");
    expect(result.retrieval.query).toBe("Elena");
  });
});
