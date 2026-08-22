import type { ContentChunkRow } from "../retrieval/retrievalDb.js";
import { buildRecentWindowBlock, buildRetrievedMemoryBlock, buildSystemPrompt, type RecentTurnForPrompt, type VoiceMode } from "../persona/systemPrompt.js";
import type { RetrievalMode } from "./retrievalInvocation.js";

export interface ContextBudgets {
  /** Max retrieved chunks injected, regardless of how many retrieval returned. */
  maxRetrievedChunks: number;
  /** Max total characters of retrieved-chunk text injected — a cumulative budget applied on top of the chunk-count cap, since chunk sizes vary (documents vs. short messages). */
  maxRetrievedChars: number;
  /** Max recent conversation turns injected (mirrors the old repo's MAX_HISTORY_TURNS = 6). */
  maxRecentTurns: number;
}

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  maxRetrievedChunks: 8,
  maxRetrievedChars: 6000,
  maxRecentTurns: 6
};

export interface RetrievalProvenance {
  mode: RetrievalMode;
  query: string;
  /** How many chunks the retrieval call itself returned, before any budget was applied. */
  candidateCount: number;
  /** How many chunks actually made it into the prompt. */
  injectedChunkIds: string[];
  /** True if the chunk-count or character budget cut anything — recorded explicitly, per Part 1: truncation is never silent. */
  truncated: boolean;
}

export interface RecentWindowProvenance {
  availableTurns: number;
  injectedTurns: number;
  truncated: boolean;
}

export interface AssembledContext {
  systemPrompt: string;
  retrieval: RetrievalProvenance;
  recentWindow: RecentWindowProvenance;
}

/**
 * Context assembly (Part 1): persona prompt + retrieved-memory block (raw
 * text with provenance, delimited) + recent conversation window, all under
 * explicit, bounded budgets. Both retrieval and recent-window truncation are
 * computed and returned as data — the caller (the chat pipeline) records
 * them on `reply_sent` (the round-trip rule: what shaped this reply is
 * self-describing), rather than truncating invisibly inside this function
 * and losing the fact that it happened.
 *
 * `attachmentBlock` (item 8) is pre-built by the caller (chatPipeline.ts,
 * which has the event-log access this pure function deliberately doesn't)
 * from a file attached to THIS specific turn — kept a plain string here,
 * same as `gateDirective`, so this function stays I/O-free.
 *
 * `voiceMode` (EN-047/048): natural by default, zen only when the caller
 * (chatPipeline.ts, via src/conversation/voiceMode.ts) decided this turn
 * calls for it — threaded straight through to buildSystemPrompt.
 */
export function assembleContext(
  candidateChunks: ContentChunkRow[],
  retrievalMeta: { mode: RetrievalMode; query: string },
  recentTurns: RecentTurnForPrompt[],
  budgets: ContextBudgets = DEFAULT_CONTEXT_BUDGETS,
  gateDirective: string | null = null,
  attachmentBlock: string | null = null,
  voiceMode: VoiceMode = "natural"
): AssembledContext {
  const countCapped = candidateChunks.slice(0, budgets.maxRetrievedChunks);
  let runningChars = 0;
  const injectedChunks: ContentChunkRow[] = [];
  for (const chunk of countCapped) {
    if (runningChars + chunk.text.length > budgets.maxRetrievedChars) break;
    runningChars += chunk.text.length;
    injectedChunks.push(chunk);
  }
  const retrievalTruncated = injectedChunks.length < candidateChunks.length;

  const injectedTurns = recentTurns.slice(-budgets.maxRecentTurns);
  const recentTruncated = injectedTurns.length < recentTurns.length;

  const retrievedBlock = buildRetrievedMemoryBlock(
    injectedChunks.map((c) => ({ id: c.id, text: c.text, occurredAt: c.occurred_at, recordedAt: c.recorded_at }))
  );
  const recentWindowBlock = buildRecentWindowBlock(injectedTurns);
  const baseSystemPrompt = buildSystemPrompt(retrievedBlock, recentWindowBlock, attachmentBlock, voiceMode);
  // EN-071 stage 3: a gate directive, when present, is injected at the END
  // of the system prompt — highest-salience position, named action only.
  const systemPrompt = gateDirective ? `${baseSystemPrompt}\n\n${gateDirective}` : baseSystemPrompt;

  return {
    systemPrompt,
    retrieval: {
      mode: retrievalMeta.mode,
      query: retrievalMeta.query,
      candidateCount: candidateChunks.length,
      injectedChunkIds: injectedChunks.map((c) => c.id),
      truncated: retrievalTruncated
    },
    recentWindow: {
      availableTurns: recentTurns.length,
      injectedTurns: injectedTurns.length,
      truncated: recentTruncated
    }
  };
}
