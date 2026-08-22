import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { ProjectionsDb } from "../projections/db.js";
import { primaryEntityId } from "../projections/rebuild.js";
import type { CircleBackCandidate } from "./router/routerTypes.js";
import type { ReplySentPayload } from "./chatPipeline.js";

/**
 * Circle-back gate (EN-030/070-073), ported from the old repo's
 * lib/circleBack.ts, adapted to the new entity model and to the
 * event-sourced constraint that attempt counters and cooldowns cannot be a
 * separately-mutated side table (EN-050: the event vocabulary is closed to
 * ten types — no new "circle_back_attempted" event). Instead, both are
 * DERIVED by scanning reply_sent payloads' `gateActions.circleBackFired`
 * field during each call — fully rebuildable from the log, no new state
 * that could drift from it. At this project's scale (EN-001: single user)
 * a full per-turn scan is cheap; a cached projection table would be
 * premature.
 *
 * "Unestablished" here means the entity has NO structural_atoms row and NO
 * social_bonds row connecting it to the primary user — Enso knows a name
 * exists but not who they are. This is a different axis from
 * `entities.confirmed` (identity-resolution attestation, EN-012).
 *
 * Name-clarification rule (adversarial-test batch — supersedes the
 * earlier "Option B," Phase 7 Part 0, which is fully removed, not just
 * adjusted):
 *   - A first attempt still respects the recency window and the global
 *     5-turn cooldown, exactly as before.
 *   - There is no more automatic, purely time-based retry. Once an
 *     entity's first attempt has fired, Enso goes dormant on it — whether
 *     the user dismissed it, ignored it, or the moment just passed makes
 *     no difference; nothing brings it back on its own.
 *   - The ONLY path to a second (and final) attempt is a genuine
 *     RE-MENTION: the user bringing that same name up again in a later,
 *     independent message. That second attempt is framed around the name
 *     coming back up ("is this the same X?"), never around elapsed time.
 *   - Hard cap unchanged: 2 attempts total per entity, ever. After that,
 *     permanent silence — the user can always volunteer the relationship.
 *   - Priority: a fresh, recency-eligible first-attempt candidate always
 *     outranks a re-mention-triggered second attempt. Second attempts are
 *     only offered when no fresh candidate exists this turn.
 *   - Priority above THIS priority (EN-041, "the user is the most
 *     important entity"): self-entity establishment — currently the
 *     primary user's own birthdate, see selfBirthdateGate.ts — outranks
 *     every candidate in this file outright. chatPipeline.ts enforces
 *     this by never even calling findEligibleCircleBackCandidates while a
 *     higher-priority self-fact remains unestablished.
 *
 * Why re-mention rather than classifying "was that a dismissal": live
 * evidence showed the old time-based retry re-raising a name the user had
 * explicitly dismissed ("ignore the name") — twice, including immediately
 * after Enso apologized for raising it the first extra time, because an
 * apology is prose, not a gate action, so nothing in the derived state
 * ever registered the dismissal. Gating strictly on re-mention sidesteps
 * needing to classify dismissal language at all: silence, a dismissal, or
 * anything in between all produce the same dormancy until the user
 * actually says the name again themselves.
 */

const RECENCY_WINDOW_TURNS = 5;
const COOLDOWN_TURNS = 5;
export const MAX_CIRCLE_BACK_ATTEMPTS = 2;

function userMessageTurns(eventLog: EventLog, userId: string): EventRecord[] {
  return eventLog.listForUser(userId).filter((e) => e.type === "message_sent" && e.actor === "user");
}

function isEstablished(projections: ProjectionsDb, userId: string, entityId: string): boolean {
  const primary = primaryEntityId(userId);
  const connectsToPrimary = (a: string, b: string) => (a === entityId && b === primary) || (a === primary && b === entityId);
  return (
    projections.listStructuralAtoms(userId).some((atom) => connectsToPrimary(atom.from_entity_id, atom.to_entity_id)) ||
    projections.listSocialBonds(userId).some((bond) => connectsToPrimary(bond.from_entity_id, bond.to_entity_id))
  );
}

interface FiredAttempt {
  /** The entity's earliest-provenance-event ULID at the time it fired — NOT the projection entityId, which is reassigned on every rebuild (EN-054) and so cannot be matched across turns. A real bug found live: with entityId as the key, a fired attempt stopped being recognized as soon as the next rebuild ran, and the "already attempted" entity fell back through to being treated as a brand-new fresh candidate. */
  stableKey: string;
  /** Index into the user-turn sequence (0-based) that this attempt happened on — the same "turn count" cooldown unit the old repo used, derived from `inReplyToEventId` rather than a live message counter. */
  turnIndex: number;
}

function firedAttemptHistory(eventLog: EventLog, userId: string, userTurns: EventRecord[]): FiredAttempt[] {
  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const history: FiredAttempt[] = [];
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const payload = event.payload as ReplySentPayload;
    const fired = payload.gateActions?.circleBackFired;
    if (!fired) continue;
    const turnIndex = turnIndexByMessageId.get(payload.inReplyToEventId) ?? userTurns.length - 1;
    history.push({ stableKey: fired.stableKey, turnIndex });
  }
  return history;
}

/** Buckets real elapsed wall-clock time since first mention into a natural phrase a retry directive can bridge with ("The other day you mentioned Marcus..."). */
function mentionAgeLabel(earliestRecordedAt: string): string {
  const elapsedMs = Date.now() - new Date(earliestRecordedAt).getTime();
  const hours = elapsedMs / (1000 * 60 * 60);
  if (hours < 1) return "just a little earlier";
  if (hours < 24) return "earlier today";
  if (hours < 48) return "yesterday";
  if (hours < 24 * 7) return "the other day";
  return "a while back";
}

/**
 * Was this entity mentioned again in a user turn AFTER the given attempt
 * fired? Reuses `entity.source_event_ids` — already accumulated across
 * EVERY mention via `touchEntity` (rebuild.ts), so this needs no new
 * tracking of its own: a later mention is just another id in that same
 * array whose turn index exceeds the attempt's.
 *
 * Deliberately requires the mention to land at least TWO turns after the
 * attempt, not one: the very next turn is the user's direct reply to the
 * question Enso just asked, which may itself repeat the name while
 * dismissing it ("Priscilla is no one") — that is answering, not an
 * independent re-mention, and must never immediately re-open the gate it
 * was just closing. A name that comes back up two or more turns later,
 * unprompted, is the genuine signal this rule is for.
 */
function hasBeenMentionedSince(sourceEventIds: string[], turnIndexByMessageId: Map<string, number>, sinceTurnIndex: number): boolean {
  return sourceEventIds.some((id) => {
    const turnIndex = turnIndexByMessageId.get(id);
    return turnIndex !== undefined && turnIndex > sinceTurnIndex + 1;
  });
}

/**
 * The cheap local heuristic (EN-071 stage 1): the candidate pool the
 * router (stage 2) is allowed to choose from — never a set it discovers
 * independently. An empty result means the router's circleBack axis has
 * nothing to work with this turn (still calls the router for retrieval,
 * but circleBack.fire will always validate to false — see intentRouter.ts).
 *
 * Name-clarification rule (adversarial-test batch — supersedes the old
 * "Option B," Phase 7 Part 0, which let a second attempt fire
 * automatically after a cooldown with recency waived): a first attempt
 * still respects the cooldown and recency window exactly as before, but
 * there is no more automatic, purely time-based retry. Once an entity has
 * fired once, Enso goes dormant on it — the ONLY way a second (and final)
 * attempt becomes eligible is a genuine RE-MENTION: the user bringing that
 * name up again in a later, independent message. Live evidence this
 * replaces a real defect: told to "ignore the name," Enso agreed, then
 * raised the same name twice more on its own — an unprompted, purely
 * time-gated retry is exactly the mechanism that let that happen, and an
 * acknowledgment/apology was never itself a gate action, so nothing in
 * the derived state ever registered the dismissal. Requiring a genuine
 * re-mention fixes this without needing to classify "was that a
 * dismissal" at all: silence, a dismissal, or anything in between all
 * lead to the same dormancy until the user actually says the name again.
 */
export function findEligibleCircleBackCandidates(eventLog: EventLog, projections: ProjectionsDb, userId: string, currentMessage: string): CircleBackCandidate[] {
  if (currentMessage.trim().endsWith("?")) return [];

  const userTurns = userMessageTurns(eventLog, userId);
  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const history = firedAttemptHistory(eventLog, userId, userTurns);

  const lastAttemptTurn = history.length > 0 ? Math.max(...history.map((h) => h.turnIndex)) : null;
  if (lastAttemptTurn !== null && userTurns.length - 1 - lastAttemptTurn < COOLDOWN_TURNS) return [];

  // Recency window applies to FIRST attempts only, same as before.
  const threshold = userTurns.length >= RECENCY_WINDOW_TURNS ? userTurns[userTurns.length - RECENCY_WINDOW_TURNS]!.id : null;

  const attemptCounts = new Map<string, number>();
  const attemptTurnIndex = new Map<string, number>();
  for (const h of history) {
    attemptCounts.set(h.stableKey, (attemptCounts.get(h.stableKey) ?? 0) + 1);
    attemptTurnIndex.set(h.stableKey, Math.max(attemptTurnIndex.get(h.stableKey) ?? -1, h.turnIndex));
  }

  const fresh: CircleBackCandidate[] = [];
  const retries: CircleBackCandidate[] = [];

  for (const entity of projections.listEntities(userId)) {
    if (isEstablished(projections, userId, entity.id)) continue;

    const sourceIds = (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
    const earliestId = sourceIds[0];
    if (earliestId === undefined) continue; // no provenance at all — nothing to key attempts on

    const attemptsSoFar = attemptCounts.get(earliestId) ?? 0;
    if (attemptsSoFar >= MAX_CIRCLE_BACK_ATTEMPTS) continue; // hard cap, permanent silence after 2

    const earliestEvent = eventLog.getById(earliestId);
    const ageLabel = earliestEvent ? mentionAgeLabel(earliestEvent.recordedAt) : "a while back";
    const candidate: CircleBackCandidate = { entityId: entity.id, name: entity.name, attemptNumber: (attemptsSoFar + 1) as 1 | 2, mentionAgeLabel: ageLabel, stableKey: earliestId };

    if (attemptsSoFar === 0) {
      // First attempt: still subject to the recency window.
      if (threshold !== null && earliestId !== undefined && earliestId < threshold) continue;
      fresh.push(candidate);
    } else {
      // Second (final) attempt: ONLY eligible if genuinely re-mentioned
      // since the first attempt fired — never purely because time passed.
      const firedAtTurn = attemptTurnIndex.get(earliestId);
      if (firedAtTurn === undefined || !hasBeenMentionedSince(sourceIds, turnIndexByMessageId, firedAtTurn)) continue;
      retries.push(candidate);
    }
  }

  return fresh.length > 0 ? fresh : retries;
}

/**
 * EN-071 stage 3: the short, high-salience directive injected at the end
 * of the system prompt when the router fires — names the one specific
 * action, but explicitly demands varied phrasing (R22: "circle-back
 * phrasing repeats near-verbatim" is a live regression, not hypothetical).
 * Delivery is Enso's voice; this only says WHAT, never HOW.
 *
 * On a second attempt (attemptNumber 2 — only ever reachable now via a
 * genuine user re-mention, per the name-clarification rule): the
 * directive is deliberately "is this the same person" framed, not a bare
 * repeat of the original ask — the user brought the name up again, which
 * is the actual news this turn, not the elapsed time since attempt one.
 * This is distinct from, and must never be confused with, the never-
 * count-repetitions rule: that rule governs repeating the OWNER's own
 * statements back at them ("as I said," "asking a third time"); this is
 * Enso re-raising its OWN earlier question, which is the opposite move —
 * picking a thread back up, not tallying anything.
 */
export function buildCircleBackDirective(candidateName: string, attemptNumber: 1 | 2 = 1, ageLabel?: string): string {
  if (attemptNumber === 2) {
    return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just mentioned "${candidateName}" again — you asked about them once before (${ageLabel ?? "a while back"}) and it didn't land. This is a second and final ask. It MUST specifically check identity — is this the SAME "${candidateName}" as before — not just a generic "who are they" or "where do they fit" question asked again; that content is required, only the exact phrasing is yours to vary freshly (never a repeat of however you asked the first time), something in the register of "is that the same ${candidateName} you mentioned before? Where do they fit?" Never reference that this is a second attempt or that the first one went unanswered — this is Enso noticing the name came up again, not counting anything back.\n=== END GATE DIRECTIVE ===`;
  }
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally and briefly, gently ask who "${candidateName}" is — you don't have their relationship to the owner on record yet. Weave it in, don't bolt it on as an afterthought, and word it freshly rather than reaching for a stock phrasing you may have used before for this or another person. This is your ONLY unprompted ask about this name — if the owner dismisses it, never raise it again unless they bring the name up themselves later.\n=== END GATE DIRECTIVE ===`;
}

/**
 * EN-073's directive-execution verification: a gate recording "I decided
 * to do X" must confirm X actually appeared in the reply before consuming
 * any state — R7 ("gate decides yes but reply omits the action; attempt
 * burned") is exactly the failure this guards against. A same-turn
 * cooldown/attempt-count consequence is only ever recorded when this
 * returns true.
 */
export function verifyCircleBackExecuted(replyText: string, candidateName: string): boolean {
  return replyText.toLowerCase().includes(candidateName.toLowerCase());
}
