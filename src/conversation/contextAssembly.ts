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
   */
  maxRecentWindowChars: number;
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
 * Part B-0: keeps the MOST RECENT turns verbatim under a character budget,
 * dropping from the OLDEST end only — never the middle. Mirrors the
 * retrieval char-budget's own precedent one line down: a single turn that
 * alone exceeds the budget is dropped entirely rather than partially
 * included (same as "a single chunk that alone exceeds the character
 * budget is dropped entirely, not injected partially").
 */
function truncateRecentTurnsToCharBudget(recentTurns: RecentTurnForPrompt[], maxChars: number): { injectedTurns: RecentTurnForPrompt[]; truncated: boolean } {
  let runningChars = 0;
  let cutoffIndex = recentTurns.length;
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turnChars = recentTurns[i]!.text.length;
    if (runningChars + turnChars > maxChars) break;
    runningChars += turnChars;
    cutoffIndex = i;
  }
  const injectedTurns = recentTurns.slice(cutoffIndex);
  return { injectedTurns, truncated: injectedTurns.length < recentTurns.length };
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
  ambientContextBlock: string | null = null
): AssembledContext {
  const { injectedTurns, truncated: recentTruncated } = truncateRecentTurnsToCharBudget(recentTurns, budgets.maxRecentWindowChars);

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
  const systemPrompt = gateDirective ? `${baseSystemPrompt}\n\n${gateDirective}` : baseSystemPrompt;

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
