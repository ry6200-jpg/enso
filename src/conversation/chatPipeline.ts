import { captureMessage, type MessageSentPayload } from "../capture/messageCapture.js";
import type { FileUploadedPayload } from "../attachments/attachmentCapture.js";
import type { DocumentExtractionCompletedPayload, ImageExtractionCompletedPayload } from "../attachments/attachmentContent.js";
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
import { buildAttachmentContextBlock, type RecentTurnForPrompt } from "../persona/systemPrompt.js";
import { buildCircleBackDirective, findEligibleCircleBackCandidates, verifyCircleBackExecuted } from "./circleBack.js";
import { recentAttributeClaims, resolveAttestation, type FactConfirmedPayload } from "./attestation.js";
import type { IntentRouter, RouterResult } from "./router/intentRouter.js";

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
  /**
   * Phase 6 round-trip survival: the router's own decision shaped this
   * reply (retrieval mode above, plus whichever gates fired), so it's
   * recorded here too — including when there was no router at all (Part-1
   * heuristic-only path, or a test override), so a future reader never has
   * to guess which regime produced a given turn.
   */
  router: {
    used: boolean;
    provider: "openai" | "gemini" | null;
    model: string | null;
    certified: boolean;
    failureReason: string | null;
  };
  gateActions: {
    /** Non-null only when the circle-back gate fired AND EN-073 verified the reply actually executed it — an attempt that was decided but not executed is recorded as null here (never silently burned, R7). stableKey (the entity's earliest provenance event ULID, NOT the ephemeral projection entityId — EN-054) is what future turns match attempt history against; entityId/name are carried for display/debug only. */
    circleBackFired: { entityId: string; name: string; stableKey: string } | null;
    /** The fact_confirmed event id this turn produced, if the attestation gate resolved a validated affirmation. */
    attestationConfirmedEventId: string | null;
  };
  /**
   * Item 8 round-trip survival: non-null whenever this turn had an
   * attachment attached, regardless of whether its content was actually
   * found and injected — `contentInjected: false` with a real
   * sourceEventId means the attachment existed but its extraction hadn't
   * completed or had failed, which is meaningfully different from no
   * attachment at all and must never be silently indistinguishable from it.
   */
  attachmentContext: { sourceEventId: string; filename: string; kind: "document" | "image"; contentInjected: boolean } | null;
}

export interface SendMessageDeps {
  eventLog: EventLog;
  retrievalDb: RetrievalDb;
  projectionsDb: ProjectionsDb;
  embedder: Embedder;
  chatRouter: ChatRouter;
  /** Optional (Phase 6): when absent, sendMessage falls back to Part 1's local-heuristic-only retrieval decision with no gates — preserves every pre-Phase-6 caller unchanged. */
  intentRouter?: IntentRouter;
}

export interface SendMessageInput {
  userId: string;
  text: string;
  /** The conversation window since the last /new (or process start) — caller-tracked, since there's no conversation-scoping concept in the event log itself (EN-050: events are user-scoped only). */
  recentTurns: RecentTurnForPrompt[];
  /** Test/Phase-6 hook — same shape as hybridSearch's temporalWeight override (see retrievalInvocation.ts). */
  retrievalOverride?: RetrievalInvocation;
  budgets?: ContextBudgets;
  /**
   * Item 8: the file_uploaded event id of a file attached to THIS message,
   * if any — set by the caller right after uploading it (see
   * app/api/attachments and app/page.tsx). `text` may legitimately be
   * empty when this is set (R1/EN-064's attachment-only placeholder).
   */
  attachmentEventId?: string;
}

/**
 * Item 8: looks up the already-stored, already-extracted content for a
 * file attached to this turn — never re-extracts, never re-reads the raw
 * bytes; extraction already ran when the file was uploaded
 * (uploadAndExtract/extractDocumentWithResilience et al.). Returns null
 * content-wise (but a non-null filename/kind) when extraction hasn't
 * completed or failed — the caller still records that the attachment
 * existed, just without a content block to show the model.
 */
function resolveAttachmentContext(
  eventLog: EventLog,
  attachmentEventId: string
): { filename: string; kind: "document" | "image"; content: string | null } | null {
  const uploadEvent = eventLog.getById(attachmentEventId);
  if (!uploadEvent || uploadEvent.type !== "file_uploaded") return null;
  const filename = (uploadEvent.payload as FileUploadedPayload).filename;

  const extractionEvent = eventLog
    .listForUser(uploadEvent.userId)
    .find((e) => e.type === "extraction_completed" && (e.payload as { sourceEventId?: string }).sourceEventId === attachmentEventId);
  if (!extractionEvent) return { filename, kind: "document", content: null };

  const payload = extractionEvent.payload as DocumentExtractionCompletedPayload | ImageExtractionCompletedPayload;
  if (payload.kind === "image") return { filename, kind: "image", content: payload.description };
  return { filename, kind: "document", content: payload.boundedExcerpt };
}

export interface SendMessageResult {
  messageEvent: EventRecord;
  replyEvent: EventRecord;
  replyText: string;
  debug: AssembledContext;
  /** Set only when the attestation gate resolved a validated affirmation this turn (Phase 6). */
  factConfirmedEvent?: EventRecord;
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
  const results = await hybridSearch(deps.retrievalDb, userId, invocation.query, deps.embedder, invocation.temporalWeight !== undefined ? { temporalWeight: invocation.temporalWeight } : {});
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
  const messageEvent = captureMessage(deps.eventLog, {
    userId: input.userId,
    text: input.text,
    attachmentCount: input.attachmentEventId ? 1 : 0
  });

  const attachmentInfo = input.attachmentEventId ? resolveAttachmentContext(deps.eventLog, input.attachmentEventId) : null;
  const attachmentBlock = attachmentInfo?.content ? buildAttachmentContextBlock(attachmentInfo.filename, attachmentInfo.content) : null;

  // R1/EN-064: an attachment-only turn has empty input.text — messageEvent's
  // OWN persisted text is never empty (captureMessage already substituted
  // ATTACHMENT_ONLY_PLACEHOLDER), so retrieval, the router, and the actual
  // provider call all use this, never the possibly-empty raw input.text —
  // exactly the bug R1's own comment warns about ("an empty user message
  // crashes provider chat APIs").
  const effectiveText = (messageEvent.payload as MessageSentPayload).text;

  let invocation: RetrievalInvocation;
  let routerResult: RouterResult | null = null;
  let claims: ReturnType<typeof recentAttributeClaims> = [];
  let circleBackCandidates: ReturnType<typeof findEligibleCircleBackCandidates> = [];

  if (input.retrievalOverride) {
    // Test/override hook (Part 1): bypasses the router entirely, no gates.
    invocation = input.retrievalOverride;
  } else if (deps.intentRouter) {
    circleBackCandidates = findEligibleCircleBackCandidates(deps.eventLog, deps.projectionsDb, input.userId, effectiveText);
    const knownEntities = deps.projectionsDb.listEntities(input.userId).map((e) => ({ entityId: e.id, name: e.name }));
    claims = recentAttributeClaims(deps.eventLog, deps.projectionsDb, input.userId);

    routerResult = await deps.intentRouter.route({
      message: effectiveText,
      recentTurns: input.recentTurns,
      knownEntities,
      circleBackCandidates,
      recentAttributeClaims: claims
    });

    const r = routerResult.decision.retrieval;
    invocation =
      r.mode === "entity"
        ? { mode: "entity", query: effectiveText, entityId: r.entityId! }
        : r.mode === "recency"
          ? { mode: "recency", query: effectiveText, n: r.n ?? 10 }
          : { mode: "hybrid", query: effectiveText, temporalWeight: r.temporalWeight };
  } else {
    // Pre-Phase-6 fallback: no router configured, use the Part 1 local heuristic, no gates.
    invocation = decideRetrievalInvocation(effectiveText, deps.projectionsDb, input.userId);
  }

  const candidateChunks = await runRetrieval(deps, input.userId, invocation);

  const circleBackFireEntity =
    routerResult?.decision.circleBack.fire && routerResult.decision.circleBack.entityId
      ? (circleBackCandidates.find((c) => c.entityId === routerResult!.decision.circleBack.entityId) ?? null)
      : null;
  const gateDirective = circleBackFireEntity ? buildCircleBackDirective(circleBackFireEntity.name, circleBackFireEntity.attemptNumber, circleBackFireEntity.mentionAgeLabel) : null;

  const assembled = assembleContext(
    candidateChunks,
    { mode: invocation.mode, query: invocation.query },
    input.recentTurns,
    input.budgets ?? DEFAULT_CONTEXT_BUDGETS,
    gateDirective,
    attachmentBlock
  );

  const callResult = await deps.chatRouter.reply({ system: assembled.systemPrompt, history: [], latestMessage: effectiveText });

  // EN-073: only consume circle-back state (recorded below) if the reply actually executed the directive.
  const circleBackFired = circleBackFireEntity && verifyCircleBackExecuted(callResult.text, circleBackFireEntity.name) ? circleBackFireEntity : null;

  let factConfirmedEvent: EventRecord | undefined;
  const attestation = routerResult?.decision.attestation;
  if (attestation?.isAffirmation && attestation.entityName && attestation.attribute && attestation.value) {
    const resolved = resolveAttestation(claims, attestation.entityName, attestation.attribute, attestation.value);
    if (resolved) {
      const factPayload: FactConfirmedPayload = resolved;
      factConfirmedEvent = deps.eventLog.append({ type: "fact_confirmed", actor: "user", payload: factPayload, userId: input.userId });
    }
  }

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
    },
    router: {
      used: routerResult !== null,
      provider: routerResult?.provider ?? null,
      model: routerResult?.model ?? null,
      certified: routerResult?.certified ?? false,
      failureReason: routerResult?.failureReason ?? null
    },
    gateActions: {
      circleBackFired,
      attestationConfirmedEventId: factConfirmedEvent?.id ?? null
    },
    attachmentContext: attachmentInfo
      ? { sourceEventId: input.attachmentEventId!, filename: attachmentInfo.filename, kind: attachmentInfo.kind, contentInjected: attachmentBlock !== null }
      : null
  };
  const replyEvent = deps.eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: input.userId });

  return { messageEvent, replyEvent, replyText: callResult.text, debug: assembled, factConfirmedEvent };
}
