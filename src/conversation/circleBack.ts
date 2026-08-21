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
 * Phase 7 Part 0 — Option B (user decision, resolving the Phase 6 design
 * note that the original port made a second attempt on the same entity
 * near-impossible: recency window and cooldown shared the same 5-turn
 * value, so by the time cooldown cleared, the entity's introduction had
 * always already aged out of the recency window).
 *   - The recency window now applies to FIRST attempts only. A still-
 *     unestablished entity that already had one attempt WAIVES recency on
 *     its retry — unresolvedness is itself the standing reason to ask
 *     again, not how long ago it came up.
 *   - Cooldown is unchanged (global, 5 turns).
 *   - Hard cap unchanged: 2 attempts total per entity, ever. After that,
 *     permanent silence — the user can always volunteer the relationship.
 *   - Priority: a fresh, recency-eligible first-attempt candidate always
 *     outranks a retry candidate. Retries are only offered when no fresh
 *     candidate exists this turn — they fill lulls, never interrupt the
 *     present moment a fresh mention creates.
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
  entityId: string;
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
    history.push({ entityId: fired.entityId, turnIndex });
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
 * The cheap local heuristic (EN-071 stage 1): the candidate pool the
 * router (stage 2) is allowed to choose from — never a set it discovers
 * independently. An empty result means the router's circleBack axis has
 * nothing to work with this turn (still calls the router for retrieval,
 * but circleBack.fire will always validate to false — see intentRouter.ts).
 *
 * Option B priority (Phase 7 Part 0): fresh (first-attempt, recency-
 * eligible) candidates are returned alone whenever any exist; retry
 * candidates (already attempted once, recency waived) are only returned
 * when no fresh candidate exists this turn.
 */
export function findEligibleCircleBackCandidates(eventLog: EventLog, projections: ProjectionsDb, userId: string, currentMessage: string): CircleBackCandidate[] {
  if (currentMessage.trim().endsWith("?")) return [];

  const userTurns = userMessageTurns(eventLog, userId);
  const history = firedAttemptHistory(eventLog, userId, userTurns);

  const lastAttemptTurn = history.length > 0 ? Math.max(...history.map((h) => h.turnIndex)) : null;
  if (lastAttemptTurn !== null && userTurns.length - 1 - lastAttemptTurn < COOLDOWN_TURNS) return [];

  // Recency window (first attempts only — see Option B header note): an
  // entity whose EARLIEST provenance event falls outside the last
  // RECENCY_WINDOW_TURNS user turns is excluded from a FIRST attempt,
  // but a retry ignores this entirely.
  const threshold = userTurns.length >= RECENCY_WINDOW_TURNS ? userTurns[userTurns.length - RECENCY_WINDOW_TURNS]!.id : null;

  const attemptCounts = new Map<string, number>();
  for (const h of history) attemptCounts.set(h.entityId, (attemptCounts.get(h.entityId) ?? 0) + 1);

  const fresh: CircleBackCandidate[] = [];
  const retries: CircleBackCandidate[] = [];

  for (const entity of projections.listEntities(userId)) {
    if (isEstablished(projections, userId, entity.id)) continue;
    const attemptsSoFar = attemptCounts.get(entity.id) ?? 0;
    if (attemptsSoFar >= MAX_CIRCLE_BACK_ATTEMPTS) continue; // hard cap, permanent silence after 2

    const sourceIds = (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
    const earliestId = sourceIds[0];
    const earliestEvent = earliestId ? eventLog.getById(earliestId) : undefined;
    const ageLabel = earliestEvent ? mentionAgeLabel(earliestEvent.recordedAt) : "a while back";
    const candidate: CircleBackCandidate = { entityId: entity.id, name: entity.name, attemptNumber: (attemptsSoFar + 1) as 1 | 2, mentionAgeLabel: ageLabel };

    if (attemptsSoFar === 0) {
      // First attempt: still subject to the recency window.
      if (threshold !== null && earliestId !== undefined && earliestId < threshold) continue;
      fresh.push(candidate);
    } else {
      // Retry: recency waived — unresolvedness is the standing reason.
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
 * On a retry (attemptNumber 2, Option B): the directive explicitly asks
 * for phrasing that BRIDGES the time gap since the first, presumably
 * brushed-off ask — returning to an open thread, in the spirit of "the
 * other day you mentioned..." This is distinct from, and must never be
 * confused with, the never-count-repetitions rule: that rule governs
 * repeating the OWNER's own statements back at them ("as I said," "asking
 * a third time"); this is Enso re-raising its OWN earlier question, which
 * is the opposite move — picking a thread back up, not tallying anything.
 */
export function buildCircleBackDirective(candidateName: string, attemptNumber: 1 | 2 = 1, ageLabel?: string): string {
  if (attemptNumber === 2) {
    return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThis is a second and final ask about "${candidateName}" — you asked once before and it didn't land, so this is the last time this comes up naturally rather than staying an open thread forever. Bridge the time gap explicitly rather than repeating the earlier phrasing: something in the register of "${ageLabel ?? "a while back"} you mentioned ${candidateName} — where do they fit?" Word it freshly, not a repeat of however you asked the first time. Never reference that this is a second attempt, a repeated question, or that it went unanswered — this is Enso picking a thread back up, not counting anything back.\n=== END GATE DIRECTIVE ===`;
  }
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally and briefly, gently ask who "${candidateName}" is — you don't have their relationship to the owner on record yet. Weave it in, don't bolt it on as an afterthought, and word it freshly rather than reaching for a stock phrasing you may have used before for this or another person.\n=== END GATE DIRECTIVE ===`;
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
