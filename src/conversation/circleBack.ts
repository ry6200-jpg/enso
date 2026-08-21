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

/**
 * The cheap local heuristic (EN-071 stage 1): the candidate pool the
 * router (stage 2) is allowed to choose from — never a set it discovers
 * independently. An empty result means the router's circleBack axis has
 * nothing to work with this turn (still calls the router for retrieval,
 * but circleBack.fire will always validate to false — see intentRouter.ts).
 */
export function findEligibleCircleBackCandidates(eventLog: EventLog, projections: ProjectionsDb, userId: string, currentMessage: string): CircleBackCandidate[] {
  if (currentMessage.trim().endsWith("?")) return [];

  const userTurns = userMessageTurns(eventLog, userId);
  const history = firedAttemptHistory(eventLog, userId, userTurns);

  const lastAttemptTurn = history.length > 0 ? Math.max(...history.map((h) => h.turnIndex)) : null;
  if (lastAttemptTurn !== null && userTurns.length - 1 - lastAttemptTurn < COOLDOWN_TURNS) return [];

  // Recency window: only circle back on an entity whose EARLIEST provenance
  // event falls within the last RECENCY_WINDOW_TURNS user turns — an old,
  // never-circled-back-on mention ages out rather than surfacing out of
  // nowhere much later (ported verbatim in spirit from the old repo's
  // establishmentRecencyThreshold, adapted to compare ULIDs directly since
  // they sort lexicographically by creation time — EN-050).
  const threshold = userTurns.length >= RECENCY_WINDOW_TURNS ? userTurns[userTurns.length - RECENCY_WINDOW_TURNS]!.id : null;

  const attemptCounts = new Map<string, number>();
  for (const h of history) attemptCounts.set(h.entityId, (attemptCounts.get(h.entityId) ?? 0) + 1);

  const candidates: CircleBackCandidate[] = [];
  for (const entity of projections.listEntities(userId)) {
    if (isEstablished(projections, userId, entity.id)) continue;
    if ((attemptCounts.get(entity.id) ?? 0) >= MAX_CIRCLE_BACK_ATTEMPTS) continue;
    const sourceIds = (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
    const earliest = sourceIds[0];
    if (threshold !== null && earliest !== undefined && earliest < threshold) continue;
    candidates.push({ entityId: entity.id, name: entity.name });
  }
  return candidates;
}

/**
 * EN-071 stage 3: the short, high-salience directive injected at the end
 * of the system prompt when the router fires — names the one specific
 * action, but explicitly demands varied phrasing (R22: "circle-back
 * phrasing repeats near-verbatim" is a live regression, not hypothetical).
 * Delivery is Enso's voice; this only says WHAT, never HOW.
 */
export function buildCircleBackDirective(candidateName: string): string {
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
