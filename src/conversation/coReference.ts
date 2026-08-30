import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { EntityRow, ProjectionsDb, StructuralAtomRow } from "../projections/db.js";
import { primaryEntityId } from "../projections/rebuild.js";
import type { ReplySentPayload } from "./chatPipeline.js";

/**
 * Co-reference confirmation gate (EN-101/Bug fix 2 of 2). Human-confirmed,
 * never model-asserted or auto-merged (DECIDED): this file only ever
 * PROPOSES a candidate pairing and recognizes the owner's own answer to a
 * question already asked — it never writes a merge itself. The actual fold
 * happens in rebuild.ts's pre-pass (coReferenceMerge.ts), driven entirely
 * by the fact_confirmed/fact_corrected events this file's payload builders
 * produce.
 *
 * Gated to parent_of and spouse_of only (DECIDED) — friend/colleague/
 * neighbor/classmate/mentor_of/romantic have high natural multiplicity and
 * would be pure noise as a collision signal. Trigger fires ONLY when the
 * EXISTING holder of the (type, anchor) slot is itself name_kind
 * 'role_word' and a new, textually-unrelated real name is asserted into
 * the same slot — never on ordinary multiplicity (two named parents on one
 * child must never fire; neither is a placeholder, so no pairing exists to
 * propose).
 *
 * NOT part of the curiosity-turn pool (removed from it — see live-testing
 * finding below). Consolidating a duplicated entity is not curiosity:
 * every curiosity-turn candidate is Enso choosing to learn something NEW,
 * while a co-reference ask is Enso resolving a contradiction in what it
 * ALREADY holds — two entities for one person, corrupting the dossier,
 * traversal, and every downstream answer about that person until fixed.
 * findCuriosityAskCandidates (circleBack.ts) is a strict fallthrough that
 * stops at the first non-empty list; thirdParty regenerates continuously
 * because introducing new people is the app's core use case, so the
 * coReference branch beneath it was effectively unreachable — live-tested
 * directly (three real API runs; even after pre-seeding every self-fact,
 * something else — a Layer 1 elicitation opener needing no anchor at all —
 * still won the single slot on turn 1 and cooldown-blocked the rest). Not
 * a one-turn lag: starvation with no natural exhaustion point, and worse
 * for busier accounts (more people mentioned = more thirdParty
 * competition = less chance the collision ever reaches the slot), which
 * are also the accounts most likely to actually hold a collision. Now an
 * independent gate, computed every turn in chatPipeline.ts, same shape as
 * ambientContext/travelContext — never behind curiosityTurnEligible, never
 * waiting on the shared cooldown. Its own bounds (MAX_CO_REFERENCE_ATTEMPTS,
 * COOLDOWN_TURNS below) are unchanged and still the only thing preventing
 * a repeated quiz on the same pairing.
 */

const GATED_TYPES = ["parent_of", "spouse_of"] as const;
type GatedType = (typeof GATED_TYPES)[number];

export const MAX_CO_REFERENCE_ATTEMPTS = 2;
const COOLDOWN_TURNS = 5;

export interface CoReferenceCandidate {
  kind: "coReference";
  placeholderEntityId: string;
  placeholderName: string;
  placeholderStableKey: string;
  realEntityId: string;
  realName: string;
  realStableKey: string;
  anchorEntityId: string;
  anchorName: string;
  relationType: GatedType;
  attemptNumber: 1 | 2;
}

function stableKeyOf(entity: { source_event_ids: string }): string | undefined {
  const ids = (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
  return ids[0];
}

function anchorDisplayName(userId: string, anchorId: string, entityById: Map<string, EntityRow>): string {
  if (anchorId === primaryEntityId(userId)) return "you";
  return entityById.get(anchorId)?.name ?? "unknown";
}

/** Groups open (interval_end === null) gated-type atoms by (type, anchor) — parent_of's anchor is always the CHILD (to_entity_id); spouse_of's anchor is either side (symmetric), so both sides are considered. Carries each atom's own source_event_ids (not the counterparty entity's, which accumulates across every mention ever) so provenance-based liveness (below) can check exactly when THIS atom — the one that actually formed a collision — was created. */
function groupByAnchor(atoms: StructuralAtomRow[]): Map<string, { type: GatedType; anchorId: string; counterpartyId: string; sourceEventIds: string[] }[]> {
  const groups = new Map<string, { type: GatedType; anchorId: string; counterpartyId: string; sourceEventIds: string[] }[]>();
  function add(type: GatedType, anchorId: string, counterpartyId: string, sourceEventIds: string[]) {
    const key = `${type}|${anchorId}`;
    const list = groups.get(key) ?? [];
    list.push({ type, anchorId, counterpartyId, sourceEventIds });
    groups.set(key, list);
  }
  for (const atom of atoms) {
    if (atom.interval_end !== null) continue;
    const sourceEventIds = JSON.parse(atom.source_event_ids) as string[];
    if (atom.type === "parent_of") {
      add("parent_of", atom.to_entity_id, atom.from_entity_id, sourceEventIds);
    } else if (atom.type === "spouse_of") {
      add("spouse_of", atom.from_entity_id, atom.to_entity_id, sourceEventIds);
      add("spouse_of", atom.to_entity_id, atom.from_entity_id, sourceEventIds);
    }
  }
  return groups;
}

/**
 * Provenance-based liveness (replaces the old literal-substring check on
 * the current message, which missed any pronoun/paraphrase reference to
 * the anchor — "her father is An Song" never mentions "Vanessa" by name,
 * live-confirmed to produce zero candidates under the old check even
 * though the collision is being formed in that exact sentence). "Live"
 * now means: the real-name atom that FORMED the collision carries a
 * source_event_id from the single most recently extracted user message —
 * i.e. the collision was just created, not a stale one from many turns
 * back the owner has moved on from. Deliberately a single most-recent
 * message, not an N-turn lookback, to preserve that same "never spring a
 * name on the owner they haven't just brought up themselves" intent.
 * Extraction runs after the reply (turnMemoryRefresh.ts), so this is also
 * exactly the earliest point any caller could observe the collision at
 * all — the router routing turn N only ever sees extraction results
 * through turn N-1.
 */
function mostRecentlyExtractedMessageId(eventLog: EventLog, userId: string): string | undefined {
  const latest = [...eventLog.listForUser(userId)]
    .reverse()
    .find((e): e is EventRecord & { payload: { kind: string; sourceEventId: string } } => {
      if (e.type !== "extraction_completed") return false;
      const payload = e.payload as { kind?: string; sourceEventId?: string };
      return payload.kind === "message" && typeof payload.sourceEventId === "string";
    });
  return latest?.payload.sourceEventId;
}

function userMessageTurns(eventLog: EventLog, userId: string): EventRecord[] {
  return eventLog.listForUser(userId).filter((e) => e.type === "message_sent" && e.actor === "user");
}

interface FiredAttempt {
  pairKey: string;
  turnIndex: number;
}

function firedAttemptHistory(eventLog: EventLog, userId: string, userTurns: EventRecord[]): FiredAttempt[] {
  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const history: FiredAttempt[] = [];
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const payload = event.payload as ReplySentPayload;
    const fired = payload.gateActions?.coReferenceAskFired;
    if (!fired) continue;
    const turnIndex = turnIndexByMessageId.get(payload.inReplyToEventId) ?? userTurns.length - 1;
    history.push({ pairKey: `${fired.placeholderStableKey}|${fired.realStableKey}`, turnIndex });
  }
  return history;
}

/**
 * The candidate pool for ASKING (EN-071-style stage 1 heuristic): every
 * currently-open role-word-vs-real-name collision on a gated slot whose
 * real-name atom is still live (provenance-based, see
 * mostRecentlyExtractedMessageId above), not yet at the attempt cap, and
 * past cooldown since its last attempt. No longer part of the curiosity
 * pool — see this file's header comment. Independent gate, computed every
 * turn in chatPipeline.ts; this function only proposes, never fires.
 */
export function findEligibleCoReferenceCandidates(eventLog: EventLog, projections: ProjectionsDb, userId: string): CoReferenceCandidate[] {
  const entities = projections.listEntities(userId);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const atoms = projections.listStructuralAtoms(userId).filter((a) => GATED_TYPES.includes(a.type as GatedType));
  const groups = groupByAnchor(atoms as StructuralAtomRow[]);

  const userTurns = userMessageTurns(eventLog, userId);
  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const history = firedAttemptHistory(eventLog, userId, userTurns);
  const attemptCounts = new Map<string, number>();
  const lastAttemptTurn = new Map<string, number>();
  for (const h of history) {
    attemptCounts.set(h.pairKey, (attemptCounts.get(h.pairKey) ?? 0) + 1);
    lastAttemptTurn.set(h.pairKey, Math.max(lastAttemptTurn.get(h.pairKey) ?? -1, h.turnIndex));
  }

  const mostRecentMessageId = mostRecentlyExtractedMessageId(eventLog, userId);
  const candidates: CoReferenceCandidate[] = [];

  for (const [key, group] of groups) {
    const [type, anchorId] = key.split("|") as [GatedType, string];
    if (entityById.get(anchorId)?.name_kind === "role_word") continue; // anchor itself must be a real, addressable identity

    const counterpartyIds = [...new Set(group.map((g) => g.counterpartyId))];
    const placeholders = counterpartyIds.map((id) => entityById.get(id)).filter((e): e is EntityRow => !!e && e.name_kind === "role_word");
    const reals = counterpartyIds.map((id) => entityById.get(id)).filter((e): e is EntityRow => !!e && e.name_kind !== "role_word");
    if (placeholders.length === 0 || reals.length === 0) continue; // ordinary multiplicity (e.g. two named parents) — no placeholder, nothing to suspect

    const anchorName = anchorDisplayName(userId, anchorId, entityById);
    const sourceEventIdsByRealId = new Map(group.map((g) => [g.counterpartyId, g.sourceEventIds]));

    for (const placeholder of placeholders) {
      const placeholderStableKey = stableKeyOf(placeholder);
      if (!placeholderStableKey) continue;
      for (const real of reals) {
        const realStableKey = stableKeyOf(real);
        if (!realStableKey) continue;

        // Liveness: the real-name atom (this specific counterparty's own
        // group entry, not the entity's full mention history) must trace
        // back to the single most recently extracted user message.
        const realAtomSourceIds = sourceEventIdsByRealId.get(real.id) ?? [];
        if (!mostRecentMessageId || !realAtomSourceIds.includes(mostRecentMessageId)) continue;

        const pairKey = `${placeholderStableKey}|${realStableKey}`;
        const attemptsSoFar = attemptCounts.get(pairKey) ?? 0;
        if (attemptsSoFar >= MAX_CO_REFERENCE_ATTEMPTS) continue;
        if (attemptsSoFar > 0) {
          const lastTurn = lastAttemptTurn.get(pairKey)!;
          if (userTurns.length - 1 - lastTurn < COOLDOWN_TURNS) continue;
        }

        candidates.push({
          kind: "coReference",
          placeholderEntityId: placeholder.id,
          placeholderName: placeholder.name,
          placeholderStableKey,
          realEntityId: real.id,
          realName: real.name,
          realStableKey,
          anchorEntityId: anchorId,
          anchorName,
          relationType: type,
          attemptNumber: (attemptsSoFar + 1) as 1 | 2
        });
      }
    }
  }

  return candidates;
}

/**
 * ASK directive (EN-073 discipline: verified against the actual reply
 * before any state is consumed — see verifyCoReferenceAskExecuted). Must
 * not read as a quiz and must not reveal what Enso stores beyond the two
 * names already live in this conversation — no mention of "placeholder",
 * "role word", or any internal bookkeeping.
 */
export function buildCoReferenceAskDirective(candidate: CoReferenceCandidate): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally and briefly, check something: is "${candidate.realName}" the same person as the "${candidate.placeholderName}" you mentioned in connection with ${candidate.anchorName === "you" ? "your own life" : candidate.anchorName}? Word it as genuine curiosity, not a checklist item — something in the register of "wait, is ${candidate.realName} the same ${candidate.placeholderName} you mentioned?" Never say anything about records, tracking, or how you keep this straight — just ask.\n=== END GATE DIRECTIVE ===`;
}

export function verifyCoReferenceAskExecuted(candidate: CoReferenceCandidate, replyText: string): boolean {
  const lower = replyText.toLowerCase();
  return lower.includes(candidate.realName.toLowerCase()) && lower.includes(candidate.placeholderName.toLowerCase());
}

export interface CoReferenceConfirmedPayload {
  kind: "coReference";
  placeholderStableKey: string;
  placeholderName: string;
  realStableKey: string;
  realName: string;
  /** Display/audit only — the anchor has no stable-key role in the merge fold itself (see coReferenceMerge.ts), which only ever needs the two stable keys and the canonical name. */
  anchorName: string;
}

/**
 * A pairing awaiting an answer (not yet confirmed) OR already confirmed
 * (retractable) — same shape either way, since both are just "here is a
 * placeholder/real-name pairing keyed by stable ULID," and the caller
 * (chatPipeline.ts) already knows which list it pulled a given entry from.
 * confirmationEventId is meaningless/unused for a still-pending entry —
 * only resolveCoReferenceRetraction ever reads it, and only for entries
 * that came from findRetractableCoReferencePairings.
 */
export interface CoReferenceConfirmedPairing {
  confirmationEventId: string;
  placeholderStableKey: string;
  placeholderName: string;
  realStableKey: string;
  realName: string;
  anchorName: string;
}

/** Turns a router-validated "confirm" decision (already checked against the pending candidate list by intentRouter.ts) into the fact_confirmed payload to append — resolved against the PENDING list (findPendingCoReferenceQuestions), never the fresh ask-eligible list: the confirming message itself ("yes, same person") won't re-mention the anchor, so the ask-eligible list's own "anchor must be live" gate would wrongly filter it out. Returns null if the caller passes something that doesn't resolve — the same defensive-second-check discipline as attestation.ts's resolveAttestation. */
export function resolveCoReferenceConfirmation(pending: CoReferenceConfirmedPairing[], placeholderStableKey: string): CoReferenceConfirmedPayload | null {
  const match = pending.find((p) => p.placeholderStableKey === placeholderStableKey);
  if (!match) return null;
  return {
    kind: "coReference",
    placeholderStableKey: match.placeholderStableKey,
    placeholderName: match.placeholderName,
    realStableKey: match.realStableKey,
    realName: match.realName,
    anchorName: match.anchorName
  };
}

/** Every co-reference confirmation currently live (not already retracted) — the candidate pool for RETRACTING, mirroring findEligibleCoReferenceCandidates' role for confirming. Scans the event log directly (EN-050 scale: cheap at this project's single-user size, same discipline as circleBack's own full-log scans). */
export function findRetractableCoReferencePairings(eventLog: EventLog, userId: string): CoReferenceConfirmedPairing[] {
  const confirmations = new Map<string, CoReferenceConfirmedPairing>();
  const retracted = new Set<string>();
  for (const event of eventLog.listForUser(userId)) {
    if (event.type === "fact_confirmed") {
      const payload = event.payload as Record<string, unknown>;
      if (payload.kind !== "coReference") continue;
      confirmations.set(event.id, {
        confirmationEventId: event.id,
        placeholderStableKey: payload.placeholderStableKey as string,
        placeholderName: payload.placeholderName as string,
        realStableKey: payload.realStableKey as string,
        realName: payload.realName as string,
        anchorName: payload.anchorName as string
      });
    } else if (event.type === "fact_corrected") {
      const payload = event.payload as Record<string, unknown>;
      if (payload.kind !== "coReferenceRetraction") continue;
      if (typeof payload.targetEventId === "string") retracted.add(payload.targetEventId);
    }
  }
  return [...confirmations.values()].filter((c) => !retracted.has(c.confirmationEventId));
}

/**
 * The candidate pool for the ANSWER-recognition axis's "confirm" side —
 * every co-reference question already asked (per reply_sent's
 * gateActions.coReferenceAskFired) that hasn't since been confirmed.
 * Distinct from findEligibleCoReferenceCandidates: that list is gated by
 * cooldown for RE-asking; this one has no cooldown at all, since the
 * owner answering the very next turn is exactly the common case.
 */
export function findPendingCoReferenceQuestions(eventLog: EventLog, userId: string): CoReferenceConfirmedPairing[] {
  const confirmedKeys = new Set(findRetractableCoReferencePairings(eventLog, userId).map((p) => p.placeholderStableKey));
  const pending = new Map<string, CoReferenceConfirmedPairing>();
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const fired = (event.payload as ReplySentPayload).gateActions?.coReferenceAskFired;
    if (!fired) continue;
    if (confirmedKeys.has(fired.placeholderStableKey)) continue;
    pending.set(fired.placeholderStableKey, {
      confirmationEventId: event.id, // not a real confirmation event yet — placeholder value, unused for a still-pending entry
      placeholderStableKey: fired.placeholderStableKey,
      placeholderName: fired.placeholderName,
      realStableKey: fired.realStableKey,
      realName: fired.realName,
      anchorName: fired.anchorName
    });
  }
  return [...pending.values()];
}

export interface CoReferenceRetractionPayload {
  kind: "coReferenceRetraction";
  targetEventId: string;
  placeholderStableKey: string;
}

/** Turns a router-validated "retract" decision into the fact_corrected payload to append — targets the ORIGINAL confirmation event's own ULID (EN-055's corrections-bind-to-ULIDs convention), never an entity id. */
export function resolveCoReferenceRetraction(pairings: CoReferenceConfirmedPairing[], placeholderStableKey: string): CoReferenceRetractionPayload | null {
  const match = pairings.find((p) => p.placeholderStableKey === placeholderStableKey);
  if (!match) return null;
  return { kind: "coReferenceRetraction", targetEventId: match.confirmationEventId, placeholderStableKey: match.placeholderStableKey };
}
