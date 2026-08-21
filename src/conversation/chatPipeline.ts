import { captureMessage } from "../capture/messageCapture.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { ChatRouter } from "../providers/chatRouter.js";
import type { ProjectionsDb } from "../projections/db.js";
import { entityMode } from "../retrieval/entityMode.js";
import { hybridSearch } from "../retrieval/hybridSearch.js";
import { recencyMode } from "../retrieval/recencyMode.js";
import type { ContentChunkRow, RetrievalDb } from "../retrieval/retrievalDb.js";
import { assembleContext, DEFAULT_CONTEXT_BUDGETS, type AssembledContext, type ContextBudgets } from "./contextAssembly.js";
import { decideRetrievalInvocation, type RetrievalInvocation, type RetrievalMode } from "./retrievalInvocation.js";
import type { RecentTurnForPrompt } from "../persona/systemPrompt.js";

export interface ReplySentPayload {
  text: string;
  provider: "openai" | "gemini";
  model: string;
  /** The message_sent event this reply answers. */
  inReplyToEventId: string;
  /**
   * Round-trip survival (CLAUDE.md): every retrieved chunk actually injected
   * into context, plus enough about the retrieval call itself and the
   * recent-window budget to reconstruct why the reply looked the way it did
   * — recorded even when retrieval found nothing (an empty array is still
   * recorded, never omitted).
   */
  contextProvenance: {
    retrievalMode: RetrievalMode;
    retrievalQuery: string;
    candidateChunkCount: number;
    injectedChunkIds: string[];
    retrievalTruncated: boolean;
    recentWindowAvailableTurns: number;
    recentWindowInjectedTurns: number;
    recentWindowTruncated: boolean;
  };
}

export interface SendMessageDeps {
  eventLog: EventLog;
  retrievalDb: RetrievalDb;
  projectionsDb: ProjectionsDb;
  embedder: Embedder;
  chatRouter: ChatRouter;
}

export interface SendMessageInput {
  userId: string;
  text: string;
  /** The conversation window since the last /new (or process start) — caller-tracked, since there's no conversation-scoping concept in the event log itself (EN-050: events are user-scoped only). */
  recentTurns: RecentTurnForPrompt[];
  /** Test/Phase-6 hook — same shape as hybridSearch's temporalWeight override (see retrievalInvocation.ts). */
  retrievalOverride?: RetrievalInvocation;
  budgets?: ContextBudgets;
}

export interface SendMessageResult {
  messageEvent: EventRecord;
  replyEvent: EventRecord;
  replyText: string;
  debug: AssembledContext;
}

/**
 * Runs whichever retrieval mode the invocation decided on and returns the
 * raw candidate chunks — hybrid mode's are best-match-first (RRF score
 * order), recency/entity mode's are chronological. assembleContext caps
 * from the front, so ordering here is what determines which chunks survive
 * a tight budget.
 */
async function runRetrieval(deps: SendMessageDeps, userId: string, invocation: RetrievalInvocation): Promise<ContentChunkRow[]> {
  if (invocation.mode === "recency") {
    return recencyMode(deps.retrievalDb, userId, invocation.n ?? 10);
  }
  if (invocation.mode === "entity") {
    return entityMode(deps.projectionsDb, deps.retrievalDb, userId, invocation.entityId!);
  }
  const results = await hybridSearch(deps.retrievalDb, userId, invocation.query, deps.embedder);
  const chunks: ContentChunkRow[] = [];
  for (const r of results) {
    const chunk = deps.retrievalDb.getChunkById(r.chunkId);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/**
 * The chat pipeline (Part 1): capture (EN-010, save-before-AI) -> retrieval
 * (EN-035) -> context assembly (persona + retrieved memory + recent window)
 * -> provider call (EN-081/083 failover) -> reply_sent. Extraction of the
 * just-sent message is deliberately NOT part of this chain — it runs as a
 * separate step the caller invokes afterward (mirroring resilientExtraction's
 * existing separation from captureMessage), which is also why
 * MEMORY_HONESTY_INSTRUCTION can never truthfully claim a save happened
 * before this function returns.
 *
 * On a provider failure (both tiers), this throws — the message_sent event
 * from the capture step has already committed and is never rolled back
 * (EN-010's whole point), so the conversation is resumable even though no
 * reply_sent exists for this turn.
 */
export async function sendMessage(deps: SendMessageDeps, input: SendMessageInput): Promise<SendMessageResult> {
  const messageEvent = captureMessage(deps.eventLog, { userId: input.userId, text: input.text });

  const invocation = input.retrievalOverride ?? decideRetrievalInvocation(input.text, deps.projectionsDb, input.userId);
  const candidateChunks = await runRetrieval(deps, input.userId, invocation);

  const assembled = assembleContext(candidateChunks, { mode: invocation.mode, query: invocation.query }, input.recentTurns, input.budgets ?? DEFAULT_CONTEXT_BUDGETS);

  const callResult = await deps.chatRouter.reply({ system: assembled.systemPrompt, history: [], latestMessage: input.text });

  const payload: ReplySentPayload = {
    text: callResult.text,
    provider: callResult.provider,
    model: callResult.model,
    inReplyToEventId: messageEvent.id,
    contextProvenance: {
      retrievalMode: assembled.retrieval.mode,
      retrievalQuery: assembled.retrieval.query,
      candidateChunkCount: assembled.retrieval.candidateCount,
      injectedChunkIds: assembled.retrieval.injectedChunkIds,
      retrievalTruncated: assembled.retrieval.truncated,
      recentWindowAvailableTurns: assembled.recentWindow.availableTurns,
      recentWindowInjectedTurns: assembled.recentWindow.injectedTurns,
      recentWindowTruncated: assembled.recentWindow.truncated
    }
  };
  const replyEvent = deps.eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: input.userId });

  return { messageEvent, replyEvent, replyText: callResult.text, debug: assembled };
}
