import type { ContentChunkRow } from "../retrieval/retrievalDb.js";
import { buildRecentWindowBlock, buildRetrievedMemoryBlock, buildSystemPrompt, type RecentTurnForPrompt, type VoiceMode } from "../persona/systemPrompt.js";
import type { RetrievalMode } from "./retrievalInvocation.js";

export interface ContextBudgets {
  /** Max retrieved chunks injected, regardless of how many retrieval returned. */
  maxRetrievedChunks: number;
  /** Max total characters of retrieved-chunk text injected — a cumulative budget applied on top of the chunk-count cap, since chunk sizes vary (documents vs. short messages). */
  maxRetrievedChars: number;
  /**
   * Part B-0: max total characters of the recent conversation window,
   * REPLACING the old fixed maxRecentTurns cap (mirrored the old repo's
   * MAX_HISTORY_TURNS = 6). A hard turn count made Enso blind past 6 turns
   * regardless of session length — the widest remaining memory gap this
   * project had (a fact said 20 turns ago was reachable only through
   * hybridSearch, which structurally loses the ranking competition for
   * short/sparse content — see R38). The window is now the ENTIRE current
   * session by default, governed by this character budget instead: kept
   * verbatim from the MOST RECENT end, oldest turns dropped first when it
   * doesn't fit — never from the middle, never interleaved with retrieval.
   *
   * 40,000 chars (~10,000 estimated tokens at ~4 chars/token) — set from
   * real measurement against the actual 79-reply/158-message dev-data
   * session: its ENTIRE raw history is 28,369 chars (~7,093 estimated
   * tokens), so this budget comfortably covers a real full session with
   * ~40% headroom before ever truncating, while still bounding worst-case
   * cost/latency for a pathologically long single session. Persona
   * (~35,600 chars fixed) + retrieval (6,000) + self-profile (1,000) +
   * this budget tops out around 82,600 chars (~20,650 tokens) even at the
   * ceiling — nowhere near any modern model's context window.
   *
   * HYSTERESIS (owner-requested, prompt-caching follow-up): this is now
   * the HIGH watermark only — the hard ceiling that triggers a prune —
   * not a target the window is trimmed to on every call. See
   * lowWatermarkRecentWindowChars below for the target a prune drops down
   * to. Live-verified against the real primary account before this was
   * built: a naive "trim to this exact number every turn once it's
   * exceeded" design made the window's start point move on every single
   * turn once the account was long enough to hit the ceiling (confirmed:
   * a real 638-turn account's two most-recent turns shared only a
   * 75-byte-into-the-window prefix, diverging from the very first line of
   * conversation content) — which defeats prompt-prefix caching for the
   * conversation window entirely on any long-running account, the exact
   * case this budget exists to bound. A simulated replay of the real
   * account's actual turn sequence through the two-watermark version
   * found prunes firing roughly every 46-208 turns (median 55) instead of
   * every turn — i.e. the window's start point now holds still for tens
   * of turns at a stretch, which is what makes a stable, cacheable prefix
   * achievable for a real, long-running account instead of only a fresh
   * one.
   */
  maxRecentWindowChars: number;
  /**
   * HYSTERESIS low watermark: the target a prune drops the window down to,
   * once maxRecentWindowChars (the high watermark) is exceeded. Must be
   * strictly less than maxRecentWindowChars — the gap between the two is
   * what creates the hysteresis band: after a prune, the window can grow
   * anywhere from this value back up to the high watermark, entirely
   * untouched, before the next prune fires. A field on this object rather
   * than hardcoded in truncateRecentTurnsToCharBudget, same discipline as
   * every other budget here, so it's overridable per test/caller like the
   * rest of ContextBudgets already is.
   */
  lowWatermarkRecentWindowChars: number;
  /** Part B (R38): max characters of the always-on self-profile block (src/persona/systemPrompt.ts's buildSelfProfileBlock, called by chatPipeline.ts before assembleContext). Deliberately generous relative to actual content — the profile is bounded by construction (3 attributes, direct bonds only) — but still an explicit, documented cap, never an unbounded block. */
  maxSelfProfileChars: number;
  /**
   * Ambient current-location: its own SEPARATE small allocation — never
   * shared with maxRecentWindowChars (B-0's budget), by explicit
   * requirement, since the two govern completely different content. 200
   * chars is deliberately tight: the location block is at most two short
   * lines ("Location: X (via Y)" / "Local time: Z") with nothing
   * meaningful to trim if it somehow grew, so a real content bug should
   * show up as the block being OMITTED (buildLocationContextBlock returns
   * null over budget, never a mangled partial render) rather than quietly
   * ballooning the prompt.
   */
  maxLocationContextChars: number;
  /**
   * Ambient current-date (breadth-before-depth batch, item 4): its own
   * SEPARATE tiny allocation, same reasoning as maxLocationContextChars —
   * this content is a single fixed-shape line with nothing meaningful to
   * trim, so a real content bug should show up as the block being OMITTED
   * (buildCurrentDateContextBlock returns null over budget) rather than a
   * mangled partial render. Unlike location, this is never permission-
   * gated or tier-dependent — the server always knows today's date — so
   * in practice this block is present on every single turn.
   */
  maxCurrentDateContextChars: number;
  /**
   * Ambient context batch, item 1: its own SEPARATE small allocation, same
   * reasoning as maxLocationContextChars — up to four short lines (own
   * weather, own local time, a third party's weather/local time, a
   * walking distance), nothing meaningful to trim if it somehow grew, so
   * over-budget means the block is OMITTED entirely (buildAmbientContextBlock
   * returns null), never a partial, misleadingly-incomplete render.
   */
  maxAmbientContextChars: number;
}

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  maxRetrievedChunks: 8,
  maxRetrievedChars: 6000,
  maxRecentWindowChars: 40000,
  lowWatermarkRecentWindowChars: 30000,
  maxSelfProfileChars: 1000,
  maxLocationContextChars: 200,
  maxCurrentDateContextChars: 100,
  maxAmbientContextChars: 400
};

export interface RetrievalProvenance {
  mode: RetrievalMode;
  query: string;
  /** How many chunks the retrieval call itself returned, before any budget was applied. */
  candidateCount: number;
  /** How many chunks actually made it into the prompt. */
  injectedChunkIds: string[];
  /** True if the chunk-count or character budget cut anything (after dedup below) — recorded explicitly, per Part 1: truncation is never silent. */
  truncated: boolean;
  /**
   * Part B-0: how many candidates were skipped because their source
   * message is already sitting verbatim in the recent window — these
   * never consume one of the maxRetrievedChunks slots, and never counted
   * against `truncated` above (skipping a genuine duplicate isn't a
   * budget cut). Distinct from `truncated` so a reader can tell "nothing
   * relevant was cut" from "some things were cut, but they were dupes."
   */
  dedupedCount: number;
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
 * Part B-0, HIGH-LOW WATERMARK (HYSTERESIS) TRIM: keeps the MOST RECENT
 * turns verbatim, dropping from the OLDEST end only — never the middle —
 * same as before. What changed: this used to trim down to `maxChars`
 * itself on every single call once exceeded, which meant the window's
 * start point moved on every turn past that point (see
 * maxRecentWindowChars's own doc comment for the real-account evidence
 * this broke prompt-prefix caching). Now the window is left COMPLETELY
 * UNTOUCHED — not even re-measured against the low watermark — as long as
 * its total stays at or under `highWatermarkChars`; only once that ceiling
 * is actually exceeded does a prune fire, dropping oldest turns until the
 * total is back at or under `lowWatermarkChars`.
 *
 * STATELESS BY REPLAY, not by persisted memory: this function has no
 * memory of a previous call, and the app has nowhere to durably keep such
 * memory anyway (a fresh checkout/process per request, per EN-052/EN-054's
 * disposable-projection philosophy — there is no long-lived server process
 * to hold an in-memory cursor across turns, and inventing a new persisted
 * field for it would be its own schema decision this task was never asked
 * to make). Hysteresis is reproduced by REPLAYING the identical high/low
 * process over the full turn sequence from its true beginning on every
 * call: accumulate turns in order, and only pop from the front (advancing
 * the simulated window's start) when the running total exceeds the high
 * watermark, continuing until it's back at or under the low watermark.
 * Because the underlying turn sequence is append-only and this replay is
 * fully deterministic, it always reconverges on exactly the boundary a
 * genuinely stateful implementation would have — the anchor holds between
 * prunes and only advances at a prune, with no external state required.
 *
 * OVERSIZED SINGLE TURN (confirmed theoretical in the real corpus checked
 * before this was built — longest real turn was 1098 chars, nowhere near
 * either watermark — handled defensively anyway, deliberately not
 * elaborately): if one turn alone exceeds the high watermark, the inner
 * while loop pops it too once it's the only thing left in the simulated
 * window and the total is still over the low watermark — it is dropped
 * entirely, never partially included, same established precedent this
 * function's retrieval-side counterpart already uses ("a single chunk
 * that alone exceeds the character budget is dropped entirely, not
 * injected partially"). No throw, no infinite loop: the loop is bounded
 * by the window never being asked to pop past the turn currently being
 * accumulated.
 */
/** Exported (was private) so the hysteresis boundary itself — which turn ends up the window's oldest, by eventId — is directly testable, not just inferable from rendered prompt text (RecentTurnForPrompt.eventId is deliberately never rendered into the prompt itself). */
export function truncateRecentTurnsToCharBudget(
  recentTurns: RecentTurnForPrompt[],
  highWatermarkChars: number,
  lowWatermarkChars: number
): { injectedTurns: RecentTurnForPrompt[]; truncated: boolean } {
  let windowStart = 0;
  let runningChars = 0;

  for (let i = 0; i < recentTurns.length; i++) {
    runningChars += recentTurns[i]!.text.length;
    if (runningChars <= highWatermarkChars) continue;
    while (runningChars > lowWatermarkChars && windowStart <= i) {
      runningChars -= recentTurns[windowStart]!.text.length;
      windowStart++;
    }
  }

  const injectedTurns = recentTurns.slice(windowStart);
  return { injectedTurns, truncated: windowStart > 0 };
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
 *
 * `selfProfileBlock` (Part B, R38): pre-built by the caller (chatPipeline.ts,
 * via buildSelfProfile + buildSelfProfileBlock — the same pattern as
 * `attachmentBlock`) and threaded straight through to buildSystemPrompt.
 * Its own budget (`maxSelfProfileChars`) is enforced by buildSelfProfileBlock
 * itself, before this function ever sees the resulting string — not
 * re-enforced here, same as attachmentBlock has no size cap here either.
 *
 * Part B-0 dedup: a candidate chunk whose `source_event_id` is already one
 * of the turns kept in the (now much larger) recent window is dropped
 * BEFORE the retrieval count/char budget runs — it would only ever have
 * repeated something already shown verbatim, wasting one of the 8 slots on
 * a non-answer. recentTurns' `eventId` (systemPrompt.ts) is what makes this
 * possible; a turn with no eventId (hand-built in most FAST tests) simply
 * never matches, which is the safe no-op default.
 *
 * `entityDossierBlock` (Part D, R40): pre-built by the caller from
 * buildEntityDossier + buildEntityDossierBlock — same pre-built-string
 * pattern as selfProfileBlock/attachmentBlock, already capped
 * (MAX_ENTITY_DOSSIERS_PER_TURN, MAX_RELATIONSHIPS_PER_ENTITY_DOSSIER) by
 * the time it reaches here, so no budget logic for it lives in this
 * function either.
 *
 * `locationContextBlock` (ambient current-location): pre-built by the
 * caller via buildLocationContextBlock, using its own SEPARATE
 * `maxLocationContextChars` budget — never the recent-window budget above,
 * by explicit requirement, since it's ephemeral per-turn context, not
 * conversation history.
 */
export function assembleContext(
  candidateChunks: ContentChunkRow[],
  retrievalMeta: { mode: RetrievalMode; query: string },
  recentTurns: RecentTurnForPrompt[],
  budgets: ContextBudgets = DEFAULT_CONTEXT_BUDGETS,
  gateDirective: string | null = null,
  attachmentBlock: string | null = null,
  voiceMode: VoiceMode = "natural",
  selfProfileBlock: string | null = null,
  entityDossierBlock: string | null = null,
  locationContextBlock: string | null = null,
  dateContextBlock: string | null = null,
  ambientContextBlock: string | null = null,
  suppressedEntitiesDirective: string | null = null,
  coReferenceAskDirective: string | null = null,
  mergeRequestDirective: string | null = null,
  typoMergeAskDirective: string | null = null
): AssembledContext {
  const { injectedTurns, truncated: recentTruncated } = truncateRecentTurnsToCharBudget(recentTurns, budgets.maxRecentWindowChars, budgets.lowWatermarkRecentWindowChars);

  const injectedEventIds = new Set(injectedTurns.map((t) => t.eventId).filter((id): id is string => Boolean(id)));
  const dedupedChunks = candidateChunks.filter((c) => !injectedEventIds.has(c.source_event_id));
  const dedupedCount = candidateChunks.length - dedupedChunks.length;

  const countCapped = dedupedChunks.slice(0, budgets.maxRetrievedChunks);
  let runningChars = 0;
  const injectedChunks: ContentChunkRow[] = [];
  for (const chunk of countCapped) {
    if (runningChars + chunk.text.length > budgets.maxRetrievedChars) break;
    runningChars += chunk.text.length;
    injectedChunks.push(chunk);
  }
  const retrievalTruncated = injectedChunks.length < dedupedChunks.length;

  const retrievedBlock = buildRetrievedMemoryBlock(
    injectedChunks.map((c) => ({ id: c.id, text: c.text, occurredAt: c.occurred_at, recordedAt: c.recorded_at }))
  );
  const recentWindowBlock = buildRecentWindowBlock(injectedTurns, recentTruncated);
  const baseSystemPrompt = buildSystemPrompt(retrievedBlock, recentWindowBlock, attachmentBlock, voiceMode, selfProfileBlock, entityDossierBlock, locationContextBlock, dateContextBlock, ambientContextBlock);
  // EN-071 stage 3: a gate directive, when present, is injected at the END
  // of the system prompt — highest-salience position, named action only.
  // EN-126 item 4: suppressedEntitiesDirective is appended the same way,
  // independently of gateDirective — a restraint, not an action, so it
  // must apply regardless of which (if any) gate fires the same turn,
  // never mutually exclusive with one. coReferenceAskDirective is appended
  // the same independent way, for the same reason (removed from the
  // curiosity pool that gateDirective's curiosity branch draws from — see
  // coReference.ts's file header) — never mutually exclusive with
  // gateDirective, since a correction and a curiosity ask are genuinely
  // distinct gaps (EN-041).
  // mergeRequestDirective is appended the same independent way as
  // coReferenceAskDirective, for the same reason: an owner-initiated merge
  // recognition is never mutually exclusive with a curiosity ask, an
  // attestation, or a role-word co-reference ask in the same turn.
  // typoMergeAskDirective is appended the same independent way — an
  // Enso-noticed suspected typo is never mutually exclusive with anything
  // else that fires this turn either.
  const trailingDirectives = [gateDirective, coReferenceAskDirective, suppressedEntitiesDirective, mergeRequestDirective, typoMergeAskDirective].filter((d): d is string => d !== null);
  const systemPrompt = trailingDirectives.length > 0 ? `${baseSystemPrompt}\n\n${trailingDirectives.join("\n\n")}` : baseSystemPrompt;

  return {
    systemPrompt,
    retrieval: {
      mode: retrievalMeta.mode,
      query: retrievalMeta.query,
      candidateCount: candidateChunks.length,
      injectedChunkIds: injectedChunks.map((c) => c.id),
      truncated: retrievalTruncated,
      dedupedCount
    },
    recentWindow: {
      availableTurns: recentTurns.length,
      injectedTurns: injectedTurns.length,
      truncated: recentTruncated
    }
  };
}
