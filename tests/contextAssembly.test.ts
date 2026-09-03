import { describe, expect, it } from "vitest";
import { assembleContext, truncateRecentTurnsToCharBudget, DEFAULT_CONTEXT_BUDGETS, type ContextBudgets } from "../src/conversation/contextAssembly.js";
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

describe("assembleContext — retrieval budget (round-trip survival, AGENTS.md)", () => {
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
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 20, lowWatermarkRecentWindowChars: 15 };
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
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 5, lowWatermarkRecentWindowChars: 0 };
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "this text is way over five characters" }];
    const result = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(result.recentWindow).toEqual({ availableTurns: 1, injectedTurns: 0, truncated: true });
  });

  it("found while building ambient location: when the single-oversized-turn case leaves ZERO injected turns, the prompt must still disclose truncation — never falsely claim 'this is the first message' when a real prior turn just got trimmed", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 5, lowWatermarkRecentWindowChars: 0 };
    const turns: RecentTurnForPrompt[] = [{ role: "user", text: "this text is way over five characters" }];
    const result = assembleContext([], RETRIEVAL_META, turns, budgets);
    expect(result.systemPrompt).not.toContain("This is the first message of the conversation");
    expect(result.systemPrompt).toMatch(/aren't shown above|beyond what's visible/i);
  });

  it("truncation is disclosed explicitly in the prompt text itself (memory-honesty principle applied to the window, not just retrieval)", () => {
    const budgets: ContextBudgets = { ...DEFAULT_CONTEXT_BUDGETS, maxRecentWindowChars: 20, lowWatermarkRecentWindowChars: 15 };
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

/**
 * High-low watermark (hysteresis) trimming, owner-requested prompt-caching
 * follow-up. truncateRecentTurnsToCharBudget exported so the boundary
 * itself — which turn ends up oldest, by eventId — is directly testable;
 * eventId is deliberately never rendered into the prompt text, so the
 * higher-level assembleContext/systemPrompt tests above couldn't verify
 * this precisely.
 *
 * All cases below share one hand-traced fixture: high=50, low=30, ten
 * turns e0..e9 of exactly 10 chars each. Traced by hand before writing
 * assertions (not just run-and-observe):
 *   e0..e4 (5 turns, total 50): no prune yet (total never exceeds 50).
 *   e0..e5 (total 60 > 50): FIRST PRUNE fires — drops e0, e1, e2 (down to
 *     total 30, at the low watermark exactly) — window becomes [e3,e4,e5].
 *   e0..e6, e0..e7 (totals 40, 50): both <= 50, no further prune — window
 *     keeps GROWING from its anchored start (still e3) up to [e3..e7].
 *   e0..e8 (total 60 > 50): SECOND PRUNE fires — drops e3, e4, e5 (down to
 *     total 30) — window becomes [e6,e7,e8], oldest advances e3 -> e6.
 */
describe("truncateRecentTurnsToCharBudget — high-low watermark (hysteresis) trimming", () => {
  const HIGH = 50;
  const LOW = 30;
  const turns: RecentTurnForPrompt[] = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("enso" as const),
    text: "x".repeat(10),
    eventId: `e${i}`
  }));

  it("a) window length never exceeds the high watermark, checked at every prefix of the sequence, not just the end", () => {
    for (let n = 1; n <= turns.length; n++) {
      const { injectedTurns } = truncateRecentTurnsToCharBudget(turns.slice(0, n), HIGH, LOW);
      const total = injectedTurns.reduce((sum, t) => sum + t.text.length, 0);
      expect(total).toBeLessThanOrEqual(HIGH);
    }
  });

  it("b) boundary stability: while the total stays between the two watermarks, the OLDEST event ID is identical across consecutive turns — the window only grows", () => {
    const afterFirstPrune = truncateRecentTurnsToCharBudget(turns.slice(0, 6), HIGH, LOW); // e0..e5, total 60 -> prunes to [e3,e4,e5]
    const oneMoreTurn = truncateRecentTurnsToCharBudget(turns.slice(0, 7), HIGH, LOW); // e0..e6, total 40, no new prune
    const twoMoreTurns = truncateRecentTurnsToCharBudget(turns.slice(0, 8), HIGH, LOW); // e0..e7, total 50, still no new prune

    expect(afterFirstPrune.injectedTurns[0]!.eventId).toBe("e3");
    expect(oneMoreTurn.injectedTurns[0]!.eventId).toBe("e3");
    expect(twoMoreTurns.injectedTurns[0]!.eventId).toBe("e3");

    // The set genuinely grows — only the start point is anchored, not the whole window.
    expect(afterFirstPrune.injectedTurns.map((t) => t.eventId)).toEqual(["e3", "e4", "e5"]);
    expect(oneMoreTurn.injectedTurns.map((t) => t.eventId)).toEqual(["e3", "e4", "e5", "e6"]);
    expect(twoMoreTurns.injectedTurns.map((t) => t.eventId)).toEqual(["e3", "e4", "e5", "e6", "e7"]);
  });

  it("c) prune execution: crossing the high watermark drops the total to <= the low watermark and moves the oldest event ID forward", () => {
    const beforePrune = truncateRecentTurnsToCharBudget(turns.slice(0, 8), HIGH, LOW); // e0..e7, total 50 - at the ceiling, not over
    const afterPrune = truncateRecentTurnsToCharBudget(turns.slice(0, 9), HIGH, LOW); // e0..e8, total 60 - crosses, prunes

    expect(beforePrune.injectedTurns[0]!.eventId).toBe("e3");
    expect(beforePrune.truncated).toBe(true); // already truncated from the FIRST prune, earlier in the sequence

    const afterTotal = afterPrune.injectedTurns.reduce((sum, t) => sum + t.text.length, 0);
    expect(afterTotal).toBeLessThanOrEqual(LOW);
    expect(afterPrune.injectedTurns[0]!.eventId).toBe("e6"); // oldest moved forward: e3 -> e6
    expect(afterPrune.injectedTurns.map((t) => t.eventId)).toEqual(["e6", "e7", "e8"]);
  });

  it("d) an oversized single turn (alone exceeding the high watermark) is handled without throwing — dropped entirely, never partially included", () => {
    const oversized: RecentTurnForPrompt[] = [{ role: "user", text: "x".repeat(100), eventId: "big" }];
    expect(() => truncateRecentTurnsToCharBudget(oversized, HIGH, LOW)).not.toThrow();
    const { injectedTurns, truncated } = truncateRecentTurnsToCharBudget(oversized, HIGH, LOW);
    expect(injectedTurns).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("d, continued) an oversized turn mixed with normal turns after it: only the oversized one is dropped, no throw, no partial inclusion", () => {
    const mixed: RecentTurnForPrompt[] = [
      { role: "user", text: "x".repeat(100), eventId: "big" },
      { role: "enso", text: "x".repeat(10), eventId: "small" }
    ];
    expect(() => truncateRecentTurnsToCharBudget(mixed, HIGH, LOW)).not.toThrow();
    const { injectedTurns } = truncateRecentTurnsToCharBudget(mixed, HIGH, LOW);
    expect(injectedTurns.map((t) => t.eventId)).toEqual(["small"]);
  });

  it("under both watermarks: nothing is pruned at all, matching legacy single-budget behavior exactly (regression guard)", () => {
    const { injectedTurns, truncated } = truncateRecentTurnsToCharBudget(turns.slice(0, 3), HIGH, LOW); // e0..e2, total 30
    expect(injectedTurns.map((t) => t.eventId)).toEqual(["e0", "e1", "e2"]);
    expect(truncated).toBe(false);
  });
});

describe("assembleContext — provenance metadata mirrors the actual invocation", () => {
  it("carries the retrieval mode and query through into the returned provenance, unchanged", () => {
    const result = assembleContext([], { mode: "entity", query: "Elena" }, []);
    expect(result.retrieval.mode).toBe("entity");
    expect(result.retrieval.query).toBe("Elena");
  });
});
