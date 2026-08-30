import { captureMessage, type MessageSentPayload } from "../capture/messageCapture.js";
import type { FileUploadedPayload } from "../attachments/attachmentCapture.js";
import type { DocumentExtractionCompletedPayload, ImageExtractionCompletedPayload } from "../attachments/attachmentContent.js";
import { computeEclipsedEventIds } from "../attachments/uploadDeletion.js";
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
import { decideRetrievalInvocation, findAllMentionedEntityIds, type RetrievalInvocation, type RetrievalMode } from "./retrievalInvocation.js";
import { buildAmbientContextBlock, buildAttachmentContextBlock, buildCurrentDateContextBlock, buildEntityDossierBlock, buildLocationContextBlock, buildSelfProfileBlock, buildSuppressedEntitiesDirective, type RecentTurnForPrompt, type VoiceMode } from "../persona/systemPrompt.js";
import { getDismissedEstablishedEntityNames } from "./elicitation.js";
import { buildEntityDossier, buildSelfProfile, getPrimaryUserAttribute, MAX_ENTITY_DOSSIERS_PER_TURN } from "../projections/peopleView.js";
import type { CurrentLocationContext } from "../location/currentLocation.js";
import { getSessionTurnsForPrompt } from "./conversationHistory.js";
import { buildConnectDotDirective, buildCuriosityAskDirective, findCuriosityAskCandidates, isCuriosityTurnEligible, isWindingDown, verifyCuriosityAskExecuted } from "./circleBack.js";
import type { CuriosityAskCandidate } from "./router/routerTypes.js";
import {
  buildCoReferenceAskDirective,
  findEligibleCoReferenceCandidates,
  findPendingCoReferenceQuestions,
  findRetractableCoReferencePairings,
  resolveCoReferenceConfirmation,
  resolveCoReferenceRetraction,
  verifyCoReferenceAskExecuted,
  type CoReferenceCandidate,
  type CoReferenceConfirmedPairing
} from "./coReference.js";
import { buildSelfBirthdateDirective, isSelfBirthdateEligible, verifySelfBirthdateAskExecuted } from "./selfBirthdateGate.js";
import {
  buildAmbiguousMergeDirective,
  buildMergeProposalDirective,
  buildUnresolvableMergeDirective,
  findPendingMergeProposal,
  resolveMergeRequest,
  verifyMergeProposalExecuted,
  type PendingMergeProposal
} from "../relationships/ownerInitiatedMerge.js";
import {
  buildTypoMergeAskDirective,
  findPendingTypoMergeQuestions,
  findTypoMergeCandidates,
  resolveTypoMergeConfirmation,
  resolveTypoMergeDismissal,
  verifyTypoMergeAskExecuted,
  type TypoMergeCandidate,
  type TypoMergePendingPairing
} from "../relationships/typoMerge.js";
import {
  buildAmbiguousRetractionDirective,
  buildNotFoundRetractionDirective,
  buildUnresolvableRetractionDirective,
  resolveRelationshipRetraction
} from "../relationships/relationshipRetraction.js";
import { recentAttributeClaims, resolveAttestation, type FactConfirmedPayload } from "./attestation.js";
import { decideVoiceMode, hasZenTriggerPhrase } from "./voiceMode.js";
import type { IntentRouter, RouterResult } from "./router/intentRouter.js";
import { ambientLocationCandidates } from "./ambientCandidates.js";
import { fetchAmbientContext } from "./ambientContextFetch.js";
import { fetchAmbientTravelContext } from "./ambientTravelFetch.js";

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
    /** Part B-0: how many retrieval candidates were skipped because they duplicated a message already sitting verbatim in the (now much larger) recent window — never counted against retrievalTruncated, since skipping a genuine duplicate isn't a budget cut. */
    retrievalDedupedCount: number;
    recentWindowAvailableTurns: number;
    recentWindowInjectedTurns: number;
    recentWindowTruncated: boolean;
    /**
     * Part B (R38): the always-on self-profile block (buildSelfProfile +
     * buildSelfProfileBlock) is a THIRD context-shaping input alongside
     * retrieval and the recent window, so it gets the same round-trip
     * treatment — optional only because events recorded before this field
     * existed genuinely don't have it, never because it's skippable going
     * forward.
     */
    selfProfile?: { included: boolean; attributeCount: number; bondCount: number; truncated: boolean };
    /**
     * Part D (R40): the entity-dossier block is a FOURTH context-shaping
     * input — which known entities got a direct-match dossier this turn,
     * for the same round-trip reason as selfProfile above. Optional for
     * the same pre-existing-events reason.
     */
    entityDossier?: { mentionedEntityIds: string[]; includedEntityCount: number };
    /**
     * Ambient current-location: a record of what the model SAW this turn,
     * never a fact about the user — this is what makes a transcript
     * debuggable ("why did it say 'still up late'?") without implying the
     * reading itself is durable data. Null when no location context was
     * available at all this turn (nothing resolved, or the caller never
     * supplied one). Optional for the same pre-existing-events reason as
     * the other three.
     */
    locationContext?: { placeName: string | null; tier: "geolocation" | "ip" | "timezone" | null; timezone: string | null } | null;
    /**
     * Ambient current-date (breadth-before-depth batch, item 4): the exact
     * date line the model actually saw this turn, for the same round-trip
     * debuggability as locationContext above. Unlike location, this is
     * never permission-gated — null only if the block somehow exceeded its
     * own tiny budget, which in practice never happens.
     */
    currentDateContext?: string | null;
    /**
     * Ambient context batch, item 1: what actually resolved and was shown
     * to the model this turn — never a fact about the user, same
     * debuggability discipline as locationContext above. Null when the
     * router decided nothing was relevant, OR when relevant fetches were
     * attempted but every one of them failed (HONESTY: this is
     * indistinguishable from "nothing relevant" in this field on purpose —
     * a failed fetch means silence, exactly like never having asked).
     */
    ambientContext?: { ownWeatherKnown: boolean; ownLocalTimeKnown: boolean; thirdPartyName: string | null; distancePlaceName: string | null } | null;
    /** Part 4: same "reflects what actually reached the block, not what the router merely judged relevant" discipline as ambientContext above. Null when nothing resolved (never relevant, or the fetch/lookup chain failed anywhere) — indistinguishable from "never asked," same honesty as ambientContext. */
    travelContext?: { destinationLabel: string } | null;
    /** EN-126 item 4: established entities under a terminal dismissal this turn — i.e. what the suppression GATE DIRECTIVE (if any) actually named, for the same debuggability every other block here gets ("why didn't it ask about X?"). Empty array, never omitted, when nothing is currently suppressed — same never-omit-just-empty discipline retrieval's own injectedChunkIds already follows. */
    suppressedEntities: string[];
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
    /**
     * Adversarial-test batch, item 1: true only when the self-birthdate
     * gate fired AND EN-073-style verification confirmed the ask actually
     * appeared in the reply — same decided-vs-executed discipline as
     * circleBackFired above, and the only state src/conversation/
     * selfBirthdateGate.ts derives its one-shot cap from (a scan of this
     * field, never a new event type).
     */
    selfBirthdateAskFired: boolean;
    /**
     * EN-030 item A: the generalized self-fact half of the curiosity pool
     * (location/occupation — birthdate keeps using selfBirthdateAskFired
     * above, untouched). Non-null only when decided AND EN-073-verified,
     * same discipline as circleBackFired; circleBack.ts's
     * findEligibleSelfFactCandidates derives its one-shot-per-attribute cap
     * from a scan of this field.
     */
    selfFactAskFired: { attribute: "location" | "occupation" } | null;
    /**
     * EN-030 item B/"connecting beats asking": true whenever the router
     * decided kind="connectDot" and curiosityTurnEligible was true. No
     * EN-073 verification exists for this one — unlike an ask, there is no
     * attempt cap or cooldown resource a false positive could wrongly
     * consume (see circleBack.ts's buildConnectDotDirective comment), so
     * this simply records the decision made.
     */
    connectDotFired: boolean;
    /**
     * EN-097: non-null only when the elicitation gate fired AND EN-073-style
     * verification confirmed the reply actually asked something (see
     * elicitation.ts's verifyElicitationExecuted for why that check is
     * looser than circle-back's/self-fact's). anchorEntityId/anchorStableKey
     * are set only for a Layer 3 probe; elicitation.ts's own attempt-cap
     * scans (one-shot per Layer 1 probeType; one-shot per Layer 3
     * (probeType, anchor) pair) both derive from a scan of this field,
     * never a new event type. R44: the Layer 3 cap keys on anchorStableKey
     * (the anchor's earliest provenance event ULID), never anchorEntityId —
     * entityId is reassigned on every projection rebuild (EN-054) and is
     * carried here for display/debug only, same split as circleBackFired's
     * entityId vs. stableKey above.
     */
    elicitationFired: { layer: 1 | 3; probeType: string; anchorEntityId?: string; anchorStableKey?: string } | null;
    /**
     * EN-101/Bug fix 2 of 2: non-null only when the co-reference ASK gate
     * fired AND EN-073-verified the reply actually asked (see
     * coReference.ts's verifyCoReferenceAskExecuted) — same decided-vs-
     * executed discipline as every other ask gate above. Independent of
     * curiosityTurn's single-slot arbitration (removed from that pool —
     * live-tested starvation, see coReference.ts's file header); MAY fire
     * alongside a curiosityTurn ask in the same reply.
     * findEligibleCoReferenceCandidates' own attempt cap/cooldown derives
     * from a scan of this field, never a new event type. Distinct from
     * coReferenceAnswerEventId below: this is the ASK side, that is the
     * ANSWER side — mutually exclusive by construction (the coReference
     * axis's own `direction` field can only be one of "ask"/"confirm"/
     * "retract" per turn), never a separate arbitration mechanism.
     */
    coReferenceAskFired: { placeholderStableKey: string; placeholderName: string; realStableKey: string; realName: string; anchorName: string } | null;
    /** The fact_confirmed or fact_corrected event id this turn produced, if the co-reference axis recognized a validated confirm/retract answer. */
    coReferenceAnswerEventId: string | null;
    /**
     * Owner-initiated merge: non-null only when a survivor was PROPOSED
     * this turn (both names resolved, unambiguous, distinct, no survivor
     * stated) AND EN-073-style verification confirmed the reply actually
     * asked (verifyMergeProposalExecuted) — same decided-vs-executed
     * discipline as coReferenceAskFired above, since this is the one merge
     * outcome with real state to protect: findPendingMergeProposal derives
     * next turn's pending-proposal recognition from a scan of this field,
     * never a new event type. A merge that resolved outright this turn
     * (survivor already stated, or answering an already-pending proposal)
     * needs no verification — see mergeAnswerEventId below — since that is
     * recognizing something the OWNER already said, not something Enso's
     * own reply needs to have executed.
     */
    mergeProposalFired: PendingMergeProposal | null;
    /** The fact_confirmed event id this turn produced, if the mergeRequest axis resolved an owner-initiated merge outright (survivor stated, or answering a pending proposal). */
    mergeAnswerEventId: string | null;
    /**
     * Enso-initiated typo detection: non-null only when the typoMerge ASK
     * fired AND EN-073-style verification confirmed the reply actually
     * asked (verifyTypoMergeAskExecuted, requiring both names — this ask
     * poses an identity question, not a survivor confirmation, so it needs
     * the stricter both-names check, not mergeProposalFired's looser one).
     * findTypoMergeCandidates' own attempt cap/cooldown, and
     * findPendingTypoMergeQuestions' answer recognition, both derive from
     * a scan of this field, never a new event type.
     */
    typoMergeAskFired: { pairKey: string; firstStableKey: string; firstName: string; secondStableKey: string; secondName: string; proposedSurvivorName: string } | null;
    /** The fact_confirmed or fact_corrected event id this turn produced, if the typoMerge axis recognized a validated confirm/dismiss answer. */
    typoMergeAnswerEventId: string | null;
    /** The fact_corrected event id this turn produced, if the relationshipRetraction axis resolved a real, open relationship to close. Single-shot — no separate "fired" field, since this axis has no propose/pending turn shape to protect. */
    relationshipRetractionEventId: string | null;
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
  /**
   * EN-047/048 round-trip survival: which voice register this reply was
   * generated under, and why — `triggeredByPhrase` distinguishes the cheap
   * literal-trigger layer from the router's own semantic judgment (or the
   * natural default when neither fired), so a future reader never has to
   * guess which layer decided a given turn's register.
   */
  voiceMode: { mode: VoiceMode; triggeredByPhrase: boolean };
}

export interface SendMessageDeps {
  eventLog: EventLog;
  retrievalDb: RetrievalDb;
  projectionsDb: ProjectionsDb;
  embedder: Embedder;
  chatRouter: ChatRouter;
  /** Optional (Phase 6): when absent, sendMessage falls back to Part 1's local-heuristic-only retrieval decision with no gates — preserves every pre-Phase-6 caller unchanged. */
  intentRouter?: IntentRouter;
  /**
   * Ambient context batch, item 1: the same Google Maps Platform key
   * already used for reverse-geocoding (GOOGLE_MAPS_API_KEY) — Weather,
   * Time Zone, Routes, and Places (New) are all enabled on that same
   * project. Optional so every pre-existing caller (tests, the REPL
   * without ambient wired up) keeps working unchanged; every ambient
   * fetch function already degrades to null on a missing key, so omitting
   * this simply means ambientContext never resolves anything, never a
   * thrown error.
   */
  googleMapsApiKey?: string;
}

export interface SendMessageInput {
  userId: string;
  text: string;
  /**
   * Part B-0: OPTIONAL — omit it and sendMessage computes the real window
   * itself, server-side, from the event log (getSessionTurnsForPrompt),
   * which is what production (app/api/chat/route.ts) now does. The event
   * log — not a caller's own idea of recent history — is the source of
   * truth for what Enso can see of the current session; a caller
   * overriding this is a deliberate escape hatch (tests wanting direct
   * control over exactly what's in the window), never the normal path.
   * There's still no conversation-scoping concept in the event log itself
   * (EN-050: events are user-scoped only) — "the current session" is
   * simply this user's whole history, per Part B-0's decision that this
   * project has no multi-session boundary concept to split on yet.
   */
  recentTurns?: RecentTurnForPrompt[];
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
  /**
   * Ambient current-location (see enso-rebuild-requirements.md's CORE
   * DISTINCTION): resolved by the CALLER (app/api/chat/route.ts, via
   * src/location/currentLocation.ts's resolveCurrentLocationContext, which
   * needs the raw HTTP request for the IP tier — chatPipeline.ts itself
   * has no business touching that) BEFORE calling sendMessage. Threaded
   * only into context assembly for the reply — NEVER passed to extraction
   * (refreshMemoryAfterTurn, turnMemoryRefresh.ts, is a completely
   * separate call this field is never given to). Never an event, never
   * entity_attributes, never persisted anywhere — recorded on reply_sent
   * only as provenance of what the model saw this one turn.
   */
  locationContext?: CurrentLocationContext | null;
  /**
   * Ambient context batch, item 1: raw device coordinates for THIS TURN
   * ONLY — supersedes the earlier "reverse-geocode then discard
   * coordinates" decision. Sent by the client with every chat turn (app/
   * page.tsx), passed straight through by app/api/chat/route.ts with no
   * geocoding step (Weather/Time Zone take coordinates directly). Used
   * ONLY here, for whatever ambientContext.ownSituation/namedPlaceForDistance
   * the router decides is relevant THIS turn — never stored, never an
   * event, never entity_attributes, never given to extraction
   * (refreshMemoryAfterTurn is a completely separate call this is never
   * passed to), same discipline as locationContext above.
   */
  ownCoordinates?: { latitude: number; longitude: number } | null;
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

  // EN-065 edge case: a stale client reference to an upload deleted since
  // the page loaded (e.g. deleted in another tab/session) must never make
  // its content reach a reply — treated exactly like "no attachment at
  // all" rather than an error, since from the chat turn's perspective
  // that's exactly what it now is.
  if (computeEclipsedEventIds(eventLog.listForUser(uploadEvent.userId)).has(attachmentEventId)) return null;

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
    attachmentCount: input.attachmentEventId ? 1 : 0,
    attachmentEventId: input.attachmentEventId
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

  // Part B-0: the event log, not the caller, is the source of truth for
  // session history — recentTurns is computed here whenever the caller
  // doesn't supply its own (production never does anymore; see
  // app/api/chat/route.ts). Excludes the message just captured above,
  // which is the live input to this reply, not history.
  const recentTurns = input.recentTurns ?? getSessionTurnsForPrompt(deps.eventLog, input.userId, messageEvent.id);

  // Part B (R38): deterministic, code-computed, never a router decision —
  // unlike retrieval/gates below, this doesn't branch on deps.intentRouter
  // or input.retrievalOverride, so every path (router, no-router fallback,
  // test override) gets the same always-on self-profile block.
  const selfProfile = buildSelfProfile(deps.projectionsDb, input.userId);
  const selfProfileResult = buildSelfProfileBlock(selfProfile, (input.budgets ?? DEFAULT_CONTEXT_BUDGETS).maxSelfProfileChars);

  // Part D (R40): direct name match only — no search, no ranking, reusing
  // the same findEntityIdByExactAlias primitive entity-mode retrieval
  // already uses. Deterministic and code-computed, same as the self-
  // profile block above; never a router decision.
  const mentionedEntityIds = findAllMentionedEntityIds(effectiveText, deps.projectionsDb, input.userId, MAX_ENTITY_DOSSIERS_PER_TURN);
  const entityDossiers = mentionedEntityIds.map((id) => buildEntityDossier(deps.projectionsDb, input.userId, id)).filter((d): d is NonNullable<typeof d> => d !== null);
  const entityDossierBlock = buildEntityDossierBlock(entityDossiers);

  // Ambient current-location: already fully resolved by the caller (see
  // SendMessageInput.locationContext's doc comment) — this is pure
  // formatting, same as the self-profile/entity-dossier blocks above, and
  // uses its OWN budget (maxLocationContextChars), never the recent-
  // window budget. Deliberately NOT passed anywhere near extraction below.
  const locationContextBlock = input.locationContext
    ? buildLocationContextBlock(input.locationContext, (input.budgets ?? DEFAULT_CONTEXT_BUDGETS).maxLocationContextChars)
    : null;

  // Ambient current-date (breadth-before-depth batch, item 4): unlike
  // location, never permission-gated or async-resolved by the caller —
  // the server always knows today's date, so this is computed directly
  // here, present on every single turn. Own budget (maxCurrentDateContextChars),
  // deliberately NOT passed anywhere near extraction below, same discipline
  // as locationContextBlock.
  const dateContextBlock = buildCurrentDateContextBlock(new Date(), (input.budgets ?? DEFAULT_CONTEXT_BUDGETS).maxCurrentDateContextChars);

  let invocation: RetrievalInvocation;
  let routerResult: RouterResult | null = null;
  let claims: ReturnType<typeof recentAttributeClaims> = [];
  let curiosityCandidates: CuriosityAskCandidate[] = [];
  let curiosityTurnEligible = false;
  let selfBirthdateEligible = false;
  let ambientCandidates: ReturnType<typeof ambientLocationCandidates> = [];
  let coReferencePendingCandidates: CoReferenceConfirmedPairing[] = [];
  let coReferenceConfirmedPairings: CoReferenceConfirmedPairing[] = [];
  let coReferenceAskCandidates: CoReferenceCandidate[] = [];
  let mergePendingProposal: PendingMergeProposal | null = null;
  let typoMergeAskCandidates: TypoMergeCandidate[] = [];
  let typoMergePendingCandidates: TypoMergePendingPairing[] = [];

  if (input.retrievalOverride) {
    // Test/override hook (Part 1): bypasses the router entirely, no gates.
    invocation = input.retrievalOverride;
  } else if (deps.intentRouter) {
    // Item 1: self-entity establishment OUTRANKS third-party circle-back,
    // not merely competes with it — so when eligible, third-party
    // candidates are never even offered to the router this turn, rather
    // than being weighed against a self-candidate on equal footing.
    selfBirthdateEligible = isSelfBirthdateEligible(deps.eventLog, deps.projectionsDb, input.userId, effectiveText);
    // EN-030 item B: the open-loop/winding-down precondition is computed
    // once here, in code, and short-circuits candidate lookup entirely
    // when false — never left to the router to notice or ignore.
    curiosityTurnEligible = !selfBirthdateEligible && isCuriosityTurnEligible(deps.eventLog, input.userId, effectiveText, recentTurns);
    curiosityCandidates = curiosityTurnEligible ? findCuriosityAskCandidates(deps.eventLog, deps.projectionsDb, input.userId, effectiveText) : [];
    const knownEntities = deps.projectionsDb.listEntities(input.userId).map((e) => ({ entityId: e.id, name: e.name }));
    claims = recentAttributeClaims(deps.eventLog, deps.projectionsDb, input.userId);
    ambientCandidates = ambientLocationCandidates(deps.projectionsDb, input.userId);
    // EN-101/Bug fix 2 of 2: the ANSWER-recognition axis's own candidate
    // lists — distinct from curiosityCandidates' "coReference" kind above,
    // which is the ASK side. Computed unconditionally here (not gated on
    // curiosityTurnEligible), since answering a co-reference question is
    // never a proactive-curiosity action gated by the same open-loop/
    // winding-down precondition.
    coReferencePendingCandidates = findPendingCoReferenceQuestions(deps.eventLog, input.userId);
    coReferenceConfirmedPairings = findRetractableCoReferencePairings(deps.eventLog, input.userId);
    // Removed from the curiosity pool (live-tested starvation — see
    // coReference.ts's file header). Independent gate now: computed
    // unconditionally, never behind curiosityTurnEligible, never waiting
    // on the shared cooldown — only its own winding-down check (a manners
    // concern about the owner's state, orthogonal to slot arbitration;
    // hasOpenLoop deliberately does NOT apply here, see the same header
    // comment) suppresses it down to no candidates for this turn.
    coReferenceAskCandidates = isWindingDown(recentTurns) ? [] : findEligibleCoReferenceCandidates(deps.eventLog, deps.projectionsDb, input.userId);
    // Owner-initiated merge: computed unconditionally, same reasoning as
    // coReferencePendingCandidates above — recognizing an answer to a
    // standing proposal is never a proactive-curiosity action gated by
    // curiosityTurnEligible.
    mergePendingProposal = findPendingMergeProposal(deps.eventLog, input.userId);
    // Enso-initiated typo detection: ask candidates suppressed during
    // winding-down, same manners-only reasoning as coReferenceAskCandidates
    // above (never gated on curiosityTurnEligible or the shared cooldown).
    // Pending (answer-recognition) candidates computed unconditionally,
    // same as every other answer-recognition list here.
    typoMergeAskCandidates = isWindingDown(recentTurns) ? [] : findTypoMergeCandidates(deps.eventLog, deps.projectionsDb, input.userId);
    typoMergePendingCandidates = findPendingTypoMergeQuestions(deps.eventLog, input.userId);

    routerResult = await deps.intentRouter.route({
      message: effectiveText,
      // Deliberately NOT the full Part B-0 window: this is a separate paid
      // API call the router makes, out of scope for this fix (which
      // targeted the main reply prompt specifically) — kept at the same
      // small slice it always used, so the router's own cost/behavior is
      // unchanged. Attestation/register judgment needs recent context, not
      // the whole session.
      recentTurns: recentTurns.slice(-6),
      knownEntities,
      curiosityTurnEligible,
      curiosityCandidates,
      recentAttributeClaims: claims,
      ambientLocationCandidates: ambientCandidates,
      ownLocationAvailable: input.ownCoordinates != null,
      primaryResidenceKnown: getPrimaryUserAttribute(deps.projectionsDb, input.userId, "location") !== null,
      coReferencePendingCandidates,
      coReferenceConfirmedPairings,
      coReferenceAskCandidates,
      mergePendingProposal,
      typoMergeAskCandidates,
      typoMergePendingCandidates
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

  // Ambient context batch, item 1: the real API calls, made ONLY for
  // whatever the router just decided was relevant (already validated
  // against ambientCandidates by intentRouter.ts) — run in parallel with
  // retrieval below since neither depends on the other. Below the gate
  // (routerResult null, or ambientContext.relevant false) this makes
  // zero calls of any kind, including the owner's own — fetchAmbientContext
  // itself short-circuits on `!decision.relevant` before touching anything.
  const ambientContextDecision = routerResult?.decision.ambientContext ?? { relevant: false, ownSituation: false, thirdPartyEntityId: null, namedPlaceForDistance: null };
  // Part 4: same "gated by the router, zero calls below relevant=false" discipline as
  // ambientContext above — run in parallel since none of the three depend on each other.
  const travelContextDecision = routerResult?.decision.travelContext ?? { relevant: false, destinationHint: null };
  const [candidateChunks, ambientData, travelData] = await Promise.all([
    runRetrieval(deps, input.userId, invocation),
    fetchAmbientContext({
      decision: ambientContextDecision,
      ownCoordinates: input.ownCoordinates ?? null,
      candidates: ambientCandidates,
      apiKey: deps.googleMapsApiKey
    }),
    fetchAmbientTravelContext({
      decision: travelContextDecision,
      ownCoordinates: input.ownCoordinates ?? null,
      primaryResidence: getPrimaryUserAttribute(deps.projectionsDb, input.userId, "location"),
      apiKey: deps.googleMapsApiKey
    })
  ]);

  const curiosityDecision = routerResult?.decision.curiosityTurn;
  const curiosityAskCandidate: CuriosityAskCandidate | null =
    curiosityDecision?.fire && curiosityDecision.kind === "thirdParty"
      ? (curiosityCandidates.find((c) => c.kind === "thirdParty" && c.candidate.entityId === curiosityDecision.entityId) ?? null)
      : curiosityDecision?.fire && curiosityDecision.kind === "selfFact"
        ? (curiosityCandidates.find((c) => c.kind === "selfFact" && c.attribute === curiosityDecision.attribute) ?? null)
        : curiosityDecision?.fire && curiosityDecision.kind === "elicitation"
          ? (curiosityCandidates.find(
              (c) => c.kind === "elicitation" && c.probeType === curiosityDecision.probeType && (c.layer === 1 || (c.layer === 3 && c.anchorEntityId === curiosityDecision.entityId))
            ) ?? null)
          : null;
  const connectDotDecided = curiosityDecision?.fire === true && curiosityDecision.kind === "connectDot";

  const gateDirective = selfBirthdateEligible
    ? buildSelfBirthdateDirective()
    : curiosityAskCandidate
      ? buildCuriosityAskDirective(curiosityAskCandidate)
      : connectDotDecided
        ? buildConnectDotDirective()
        : null;

  // Independent of gateDirective above — never competing for that single
  // slot, per this gate's own removal from the curiosity pool (see
  // coReference.ts). May coexist with whichever gateDirective fired this
  // turn (EN-041's "occasionally more, two genuinely distinct gaps"),
  // exactly like suppressedEntitiesDirective below already coexists with it.
  const coReferenceDecision = routerResult?.decision.coReference;
  const coReferenceAskCandidateMatched: CoReferenceCandidate | null =
    coReferenceDecision?.fire && coReferenceDecision.direction === "ask"
      ? (coReferenceAskCandidates.find((c) => c.placeholderStableKey === coReferenceDecision.pendingStableKey) ?? null)
      : null;
  const coReferenceAskDirective = coReferenceAskCandidateMatched ? buildCoReferenceAskDirective(coReferenceAskCandidateMatched) : null;

  // Owner-initiated merge: resolved once, here, so its directive (for
  // unresolvable/ambiguous/propose) can reach assembleContext below —
  // never mutually exclusive with any gate above, same independent-
  // directive treatment as coReferenceAskDirective. A "confirmed" outcome
  // needs no directive (recognizing what the owner already said, not
  // something Enso's own reply needs to execute) and is appended after
  // the reply below, alongside the co-reference answer handling it mirrors.
  const mergeDecision = routerResult?.decision.mergeRequest;
  const mergeOutcome =
    mergeDecision?.fire && mergeDecision.firstName && mergeDecision.secondName
      ? resolveMergeRequest(
          mergeDecision.firstName,
          mergeDecision.secondName,
          mergeDecision.survivingName,
          deps.projectionsDb.listEntities(input.userId),
          deps.projectionsDb.listEntityAliases(input.userId),
          deps.projectionsDb.listStructuralAtoms(input.userId),
          deps.projectionsDb.listSocialBonds(input.userId),
          deps.projectionsDb.listAllEntityAttributes(input.userId)
        )
      : null;
  const mergeRequestDirective =
    mergeOutcome?.outcome === "unresolvable"
      ? buildUnresolvableMergeDirective(mergeOutcome.name)
      : mergeOutcome?.outcome === "ambiguous"
        ? buildAmbiguousMergeDirective(mergeOutcome.name, mergeOutcome.matchNames)
        : mergeOutcome?.outcome === "propose"
          ? buildMergeProposalDirective(mergeOutcome.proposal.proposedSurvivorName, mergeOutcome.proposal.losingName)
          : null;

  // Enso-initiated typo detection: same independent-directive treatment as
  // coReferenceAskDirective/mergeRequestDirective above — the ask IS the
  // survivor proposal (no separate propose step, unlike mergeRequest),
  // never mutually exclusive with any other gate this turn. "confirm"/
  // "dismiss" need no directive (recognizing the owner's own answer) and
  // are appended after the reply below, alongside the other answer paths.
  const typoMergeDecision = routerResult?.decision.typoMerge;
  const typoMergeAskCandidateMatched: TypoMergeCandidate | null =
    typoMergeDecision?.fire && typoMergeDecision.direction === "ask"
      ? (typoMergeAskCandidates.find((c) => c.pairKey === typoMergeDecision.pendingStableKey) ?? null)
      : null;
  const typoMergeAskDirective = typoMergeAskCandidateMatched ? buildTypoMergeAskDirective(typoMergeAskCandidateMatched) : null;

  // Relationship retraction: single-shot, resolved once, here — unlike
  // mergeRequest/typoMerge, there is no propose-then-confirm turn shape at
  // all (the relationship either exists to close or it doesn't), so a
  // "retracted" outcome is appended after the reply below with no
  // directive of its own, same as mergeRequest's "confirmed" outcome —
  // recognizing what the owner already said, not something Enso's own
  // reply needs to execute.
  const relationshipRetractionDecision = routerResult?.decision.relationshipRetraction;
  const relationshipRetractionOutcome =
    relationshipRetractionDecision?.fire && relationshipRetractionDecision.firstName && relationshipRetractionDecision.secondName && relationshipRetractionDecision.relationType
      ? resolveRelationshipRetraction(
          relationshipRetractionDecision.firstName,
          relationshipRetractionDecision.secondName,
          relationshipRetractionDecision.relationType,
          input.userId,
          deps.projectionsDb.listEntities(input.userId),
          deps.projectionsDb.listEntityAliases(input.userId),
          deps.projectionsDb.listStructuralAtoms(input.userId),
          deps.projectionsDb.listSocialBonds(input.userId)
        )
      : null;
  const relationshipRetractionDirective =
    relationshipRetractionOutcome?.outcome === "unresolvable"
      ? buildUnresolvableRetractionDirective(relationshipRetractionOutcome.name)
      : relationshipRetractionOutcome?.outcome === "ambiguous"
        ? buildAmbiguousRetractionDirective(relationshipRetractionOutcome.name, relationshipRetractionOutcome.matchNames)
        : relationshipRetractionOutcome?.outcome === "notFound"
          ? buildNotFoundRetractionDirective(relationshipRetractionOutcome.firstName, relationshipRetractionOutcome.secondName, relationshipRetractionOutcome.relationType)
          : null;

  // EN-047/048: cheap literal-trigger layer always wins outright; otherwise
  // the router's own register judgment (already fail-safed to "natural" on
  // any failure or uncertified tier — SAFE_DEFAULT_DECISION); with no
  // router configured at all, natural is the default.
  const triggeredByPhrase = hasZenTriggerPhrase(effectiveText);
  const voiceMode: VoiceMode = decideVoiceMode(effectiveText, routerResult?.decision.register.mode ?? null);

  // Ambient context batch, item 1: own budget (maxAmbientContextChars),
  // never the recent-window budget — same discipline as locationContextBlock/
  // dateContextBlock above. Deliberately NOT passed anywhere near
  // extraction below, same as those two.
  const ambientContextBlock = buildAmbientContextBlock(
    { ...ambientData, travel: travelData ?? undefined },
    (input.budgets ?? DEFAULT_CONTEXT_BUDGETS).maxAmbientContextChars
  );

  // EN-126 item 4: unconditional, every turn — never gated on the router
  // or any curiosity eligibility check above, since suppression must hold
  // even on a turn where nothing else fires (including, deliberately, the
  // very first turn of a session — the exact shape item 6's transcript
  // showed, an ordinary turn like any other, not a special "opener" path).
  const dismissedEntityNames = getDismissedEstablishedEntityNames(deps.eventLog, deps.projectionsDb, input.userId, effectiveText);
  const suppressedEntitiesDirective = buildSuppressedEntitiesDirective(dismissedEntityNames);

  const assembled = assembleContext(
    candidateChunks,
    { mode: invocation.mode, query: invocation.query },
    recentTurns,
    input.budgets ?? DEFAULT_CONTEXT_BUDGETS,
    gateDirective,
    attachmentBlock,
    voiceMode,
    selfProfileResult.block,
    entityDossierBlock,
    locationContextBlock,
    dateContextBlock,
    ambientContextBlock,
    suppressedEntitiesDirective,
    coReferenceAskDirective,
    mergeRequestDirective,
    typoMergeAskDirective,
    relationshipRetractionDirective
  );

  const callResult = await deps.chatRouter.reply({ system: assembled.systemPrompt, history: [], latestMessage: effectiveText });

  // EN-073: only consume curiosity-ask state (recorded below) if the reply actually executed the directive. connectDot has no cap to protect, so it's recorded purely on the decision — see chatPipeline's gateActions.connectDotFired doc comment.
  const curiosityAskFired = curiosityAskCandidate && verifyCuriosityAskExecuted(curiosityAskCandidate, callResult.text) ? curiosityAskCandidate : null;
  const selfBirthdateAskFired = selfBirthdateEligible && verifySelfBirthdateAskExecuted(callResult.text);
  // Same EN-073 decided-vs-executed discipline, independent of the
  // curiosity-ask verification above — this gate no longer shares
  // curiosityAskCandidate/curiosityAskFired with the curiosity pool.
  const coReferenceAskFiredCandidate =
    coReferenceAskCandidateMatched && verifyCoReferenceAskExecuted(coReferenceAskCandidateMatched, callResult.text) ? coReferenceAskCandidateMatched : null;

  let factConfirmedEvent: EventRecord | undefined;
  const attestation = routerResult?.decision.attestation;
  if (attestation?.isAffirmation && attestation.entityName && attestation.attribute && attestation.value) {
    const resolved = resolveAttestation(claims, attestation.entityName, attestation.attribute, attestation.value);
    if (resolved) {
      const factPayload: FactConfirmedPayload = resolved;
      factConfirmedEvent = deps.eventLog.append({ type: "fact_confirmed", actor: "user", payload: factPayload, userId: input.userId });
    }
  }

  // EN-101/Bug fix 2 of 2: the owner's own answer to a co-reference
  // question, either direction, recognized by the SAME coReference axis
  // as the ask side above (direction "confirm"/"retract" here vs. "ask"
  // above) — never a merge decided by this code: this only ever appends
  // the event the router's ALREADY-VALIDATED decision names; the actual
  // fold happens in rebuild.ts's pre-pass on the next rebuild.
  let coReferenceAnswerEvent: EventRecord | undefined;
  if (coReferenceDecision?.fire && coReferenceDecision.pendingStableKey) {
    if (coReferenceDecision.direction === "confirm") {
      const resolved = resolveCoReferenceConfirmation(coReferencePendingCandidates, coReferenceDecision.pendingStableKey, deps.projectionsDb.listEntities(input.userId));
      if (resolved) {
        coReferenceAnswerEvent = deps.eventLog.append({ type: "fact_confirmed", actor: "user", payload: resolved, userId: input.userId });
      }
    } else if (coReferenceDecision.direction === "retract") {
      const resolved = resolveCoReferenceRetraction(coReferenceConfirmedPairings, coReferenceDecision.pendingStableKey);
      if (resolved) {
        coReferenceAnswerEvent = deps.eventLog.append({ type: "fact_corrected", actor: "user", payload: resolved, userId: input.userId });
      }
    }
  }

  // Owner-initiated merge: a "confirmed" outcome (survivor already stated,
  // or answering an already-pending proposal) is appended unconditionally,
  // same "recognizing what the owner already said" discipline as
  // attestation/coReference-confirm above — no reply-text verification
  // needed. A "propose" outcome DOES need EN-073 verification, since
  // findPendingMergeProposal derives next turn's recognition from this
  // turn's reply having actually asked (mergeProposalFired below) — an
  // unverified proposal would silently hold state the owner never saw.
  let mergeAnswerEvent: EventRecord | undefined;
  const mergeProposalFiredThisTurn =
    mergeOutcome?.outcome === "propose" && verifyMergeProposalExecuted(mergeOutcome.proposal.proposedSurvivorName, callResult.text)
      ? mergeOutcome.proposal
      : null;
  if (mergeOutcome?.outcome === "confirmed") {
    mergeAnswerEvent = deps.eventLog.append({ type: "fact_confirmed", actor: "user", payload: mergeOutcome.payload, userId: input.userId });
  }

  // Enso-initiated typo detection: the ASK needs EN-073 verification
  // (verifyTypoMergeAskExecuted, both names — see that function's own
  // comment for why this differs from mergeProposalFired's looser check)
  // since findPendingTypoMergeQuestions derives next turn's recognition
  // from the reply having actually asked. "confirm"/"dismiss" are
  // recognizing the owner's own answer and are appended unconditionally,
  // same discipline as the merge-confirm case just above.
  const typoMergeAskFiredThisTurn =
    typoMergeAskCandidateMatched && verifyTypoMergeAskExecuted(typoMergeAskCandidateMatched, callResult.text)
      ? {
          pairKey: typoMergeAskCandidateMatched.pairKey,
          firstStableKey: typoMergeAskCandidateMatched.firstStableKey,
          firstName: typoMergeAskCandidateMatched.firstName,
          secondStableKey: typoMergeAskCandidateMatched.secondStableKey,
          secondName: typoMergeAskCandidateMatched.secondName,
          proposedSurvivorName: typoMergeAskCandidateMatched.proposedSurvivorName
        }
      : null;
  let typoMergeAnswerEvent: EventRecord | undefined;
  if (typoMergeDecision?.fire && typoMergeDecision.pendingStableKey) {
    if (typoMergeDecision.direction === "confirm") {
      const resolved = resolveTypoMergeConfirmation(typoMergePendingCandidates, typoMergeDecision.pendingStableKey, typoMergeDecision.survivingName);
      if (resolved) {
        typoMergeAnswerEvent = deps.eventLog.append({ type: "fact_confirmed", actor: "user", payload: resolved, userId: input.userId });
      }
    } else if (typoMergeDecision.direction === "dismiss") {
      const resolved = resolveTypoMergeDismissal(typoMergePendingCandidates, typoMergeDecision.pendingStableKey);
      if (resolved) {
        typoMergeAnswerEvent = deps.eventLog.append({ type: "fact_corrected", actor: "user", payload: resolved, userId: input.userId });
      }
    }
  }

  // Relationship retraction: a "retracted" outcome is appended
  // unconditionally, same "recognizing what the owner already said"
  // discipline as mergeRequest's "confirmed" outcome above — no reply-text
  // verification needed, and no pending state to record either (single-shot).
  let relationshipRetractionEvent: EventRecord | undefined;
  if (relationshipRetractionOutcome?.outcome === "retracted") {
    relationshipRetractionEvent = deps.eventLog.append({ type: "fact_corrected", actor: "user", payload: relationshipRetractionOutcome.payload, userId: input.userId });
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
      retrievalDedupedCount: assembled.retrieval.dedupedCount,
      recentWindowAvailableTurns: assembled.recentWindow.availableTurns,
      recentWindowInjectedTurns: assembled.recentWindow.injectedTurns,
      recentWindowTruncated: assembled.recentWindow.truncated,
      selfProfile: {
        included: selfProfileResult.block !== null,
        attributeCount: selfProfileResult.attributeCount,
        bondCount: selfProfileResult.bondCount,
        truncated: selfProfileResult.truncated
      },
      entityDossier: {
        mentionedEntityIds,
        includedEntityCount: entityDossiers.length
      },
      // Reflects what the model actually SAW (locationContextBlock !== null), not merely what the caller
      // supplied — a reading that got dropped for exceeding its own budget was never in the prompt at all.
      locationContext: locationContextBlock ? input.locationContext! : null,
      // Same "reflects what the model actually saw" discipline as locationContext above — null only if the
      // budget was somehow exceeded (never permission-gated, so this is non-null on effectively every turn).
      currentDateContext: dateContextBlock ? dateContextBlock : null,
      // Reflects what actually resolved and reached the block, not what the router merely judged relevant —
      // same "what the model actually saw" discipline as locationContext/currentDateContext above.
      ambientContext: ambientContextBlock
        ? {
            ownWeatherKnown: ambientData.own?.weather != null,
            ownLocalTimeKnown: ambientData.own?.localTime != null,
            thirdPartyName: ambientData.thirdParty?.name ?? null,
            distancePlaceName: ambientData.distance?.placeName ?? null
          }
        : null,
      // Part 4: same "reflects the block, not the router's mere judgment" discipline as
      // ambientContext above — null whenever travelData never resolved, for any reason.
      travelContext: ambientContextBlock && travelData ? { destinationLabel: travelData.destinationLabel } : null,
      suppressedEntities: dismissedEntityNames
    },
    router: {
      used: routerResult !== null,
      provider: routerResult?.provider ?? null,
      model: routerResult?.model ?? null,
      certified: routerResult?.certified ?? false,
      failureReason: routerResult?.failureReason ?? null
    },
    gateActions: {
      circleBackFired: curiosityAskFired?.kind === "thirdParty" ? { entityId: curiosityAskFired.candidate.entityId, name: curiosityAskFired.candidate.name, stableKey: curiosityAskFired.candidate.stableKey } : null,
      attestationConfirmedEventId: factConfirmedEvent?.id ?? null,
      selfBirthdateAskFired,
      selfFactAskFired: curiosityAskFired?.kind === "selfFact" ? { attribute: curiosityAskFired.attribute } : null,
      connectDotFired: connectDotDecided,
      elicitationFired:
        curiosityAskFired?.kind === "elicitation"
          ? curiosityAskFired.layer === 1
            ? { layer: 1, probeType: curiosityAskFired.probeType }
            : { layer: 3, probeType: curiosityAskFired.probeType, anchorEntityId: curiosityAskFired.anchorEntityId, anchorStableKey: curiosityAskFired.anchorStableKey }
          : null,
      coReferenceAskFired: coReferenceAskFiredCandidate
        ? {
            placeholderStableKey: coReferenceAskFiredCandidate.placeholderStableKey,
            placeholderName: coReferenceAskFiredCandidate.placeholderName,
            realStableKey: coReferenceAskFiredCandidate.realStableKey,
            realName: coReferenceAskFiredCandidate.realName,
            anchorName: coReferenceAskFiredCandidate.anchorName
          }
        : null,
      coReferenceAnswerEventId: coReferenceAnswerEvent?.id ?? null,
      mergeProposalFired: mergeProposalFiredThisTurn,
      mergeAnswerEventId: mergeAnswerEvent?.id ?? null,
      typoMergeAskFired: typoMergeAskFiredThisTurn,
      typoMergeAnswerEventId: typoMergeAnswerEvent?.id ?? null,
      relationshipRetractionEventId: relationshipRetractionEvent?.id ?? null
    },
    attachmentContext: attachmentInfo
      ? { sourceEventId: input.attachmentEventId!, filename: attachmentInfo.filename, kind: attachmentInfo.kind, contentInjected: attachmentBlock !== null }
      : null,
    voiceMode: { mode: voiceMode, triggeredByPhrase }
  };
  const replyEvent = deps.eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: input.userId });

  return { messageEvent, replyEvent, replyText: callResult.text, debug: assembled, factConfirmedEvent };
}
