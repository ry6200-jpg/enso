import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { ProjectionsDb } from "../projections/db.js";
import { isPlausibleNameVariant } from "../entities/resolutionCascade.js";
import { findRetractableCoReferencePairings, stableKeyOf, type CoReferenceConfirmedPayload } from "../conversation/coReference.js";
import { buildCoReferenceMergePayload, proposeSurvivor } from "./ownerInitiatedMerge.js";
import type { ReplySentPayload } from "../conversation/chatPipeline.js";

/**
 * Enso-initiated typo detection, per the design report: isPlausibleNameVariant
 * (resolutionCascade.ts) is the whole similarity measure — reused exactly as
 * built for resolveName's own fuzzy cascade, no new measure designed here.
 * Compared pairwise across current entity NAMES only, never aliases (an
 * alias is already a confirmed variant of ITS OWN entity; comparing aliases
 * across DIFFERENT entities risks flagging two people who both happen to
 * share one alias spelling, not a typo of the canonical name at all).
 *
 * Ask fires from its OWN axis (typoMerge), not coReference's or
 * mergeRequest's: unlike coReference, neither side is a role-word
 * placeholder to answer FOR; unlike mergeRequest, the owner never said
 * anything — Enso is the one raising a suspicion, so there is no "current
 * message names two entities" to recognize on the ask turn at all. The
 * MERGE outcome, once confirmed, is built by buildCoReferenceMergePayload
 * (ownerInitiatedMerge.ts) — the SAME function, not a second copy — with
 * aliasSuppressed: false, since both sides here are always real names.
 *
 * Neither side has a natural "placeholder" role, so pendingStableKey for
 * this axis is a PAIR key (both sides' stable keys, sorted and joined) —
 * see pairKey below — never a single side's key the way coReference's is.
 */

export const MAX_TYPO_MERGE_ATTEMPTS = 2;
const TYPO_MERGE_COOLDOWN_TURNS = 5;

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export interface TypoMergeCandidate {
  kind: "typoMerge";
  pairKey: string;
  firstStableKey: string;
  firstName: string;
  secondStableKey: string;
  secondName: string;
  proposedSurvivorName: string;
  attemptNumber: 1 | 2;
}

export interface TypoMergePendingPairing {
  pairKey: string;
  firstStableKey: string;
  firstName: string;
  secondStableKey: string;
  secondName: string;
  proposedSurvivorName: string;
}

export interface CoReferenceDismissalPayload {
  kind: "coReferenceDismissal";
  firstStableKey: string;
  secondStableKey: string;
}

function userMessageTurns(eventLog: EventLog, userId: string): EventRecord[] {
  return eventLog.listForUser(userId).filter((e) => e.type === "message_sent" && e.actor === "user");
}

/** Every pair ever permanently dismissed ("no, different people") — see resolveTypoMergeDismissal for what writes this. Distinct from a merged pair (findRetractableCoReferencePairings): dismissal never had a confirmation to retract, so it needs its own record, and it's permanent — no cooldown, no attempt cap, checked before either applies. */
export function findDismissedTypoMergePairs(eventLog: EventLog, userId: string): Set<string> {
  const dismissed = new Set<string>();
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "fact_corrected") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== "coReferenceDismissal") continue;
    if (typeof payload.firstStableKey === "string" && typeof payload.secondStableKey === "string") {
      dismissed.add(pairKey(payload.firstStableKey, payload.secondStableKey));
    }
  }
  return dismissed;
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
    const fired = payload.gateActions?.typoMergeAskFired;
    if (!fired) continue;
    const turnIndex = turnIndexByMessageId.get(payload.inReplyToEventId) ?? userTurns.length - 1;
    history.push({ pairKey: fired.pairKey, turnIndex });
  }
  return history;
}

/**
 * The candidate pool for ASKING — every current pair of ordinary (never
 * role-word) entity names that plausibly vary from each other, not already
 * merged, not already dismissed, not yet at the attempt cap, and past
 * cooldown since the last attempt. Same MAX_TYPO_MERGE_ATTEMPTS/
 * TYPO_MERGE_COOLDOWN_TURNS shape as coReference.ts's own
 * MAX_CO_REFERENCE_ATTEMPTS/COOLDOWN_TURNS, mirrored deliberately, not
 * shared — a wrong role-word guess and a wrong typo guess have different
 * risk profiles (see the design report), and this pool needing its own
 * dismissal concept coReference's never needed is exactly why.
 *
 * Gating on "one of the two names live in the current message" (the
 * settled decision — never a standing whole-roster scan) is NOT enforced
 * here: like coReference's own ask axis, this candidate list is
 * unconditional, and the live-in-message requirement is the router
 * prompt's fire condition (routerSchema.ts), validated only by
 * pendingStableKey membership here, never by re-checking message text in
 * code.
 */
export function findTypoMergeCandidates(eventLog: EventLog, projections: ProjectionsDb, userId: string): TypoMergeCandidate[] {
  const entities = projections.listEntities(userId).filter((e) => e.name_kind !== "role_word");
  const dismissedPairs = findDismissedTypoMergePairs(eventLog, userId);
  const mergedPairs = new Set(findRetractableCoReferencePairings(eventLog, userId).map((p) => pairKey(p.placeholderStableKey, p.realStableKey)));

  const userTurns = userMessageTurns(eventLog, userId);
  const history = firedAttemptHistory(eventLog, userId, userTurns);
  const attemptCounts = new Map<string, number>();
  const lastAttemptTurn = new Map<string, number>();
  for (const h of history) {
    attemptCounts.set(h.pairKey, (attemptCounts.get(h.pairKey) ?? 0) + 1);
    lastAttemptTurn.set(h.pairKey, Math.max(lastAttemptTurn.get(h.pairKey) ?? -1, h.turnIndex));
  }

  const structuralAtoms = projections.listStructuralAtoms(userId);
  const socialBonds = projections.listSocialBonds(userId);
  const attributes = projections.listAllEntityAttributes(userId);

  const candidates: TypoMergeCandidate[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i]!;
      const b = entities[j]!;
      if (!isPlausibleNameVariant(a.name.trim().toLowerCase(), b.name.trim().toLowerCase())) continue;
      const keyA = stableKeyOf(a);
      const keyB = stableKeyOf(b);
      if (!keyA || !keyB) continue;
      const pk = pairKey(keyA, keyB);
      if (dismissedPairs.has(pk) || mergedPairs.has(pk)) continue;

      const attemptsSoFar = attemptCounts.get(pk) ?? 0;
      if (attemptsSoFar >= MAX_TYPO_MERGE_ATTEMPTS) continue;
      if (attemptsSoFar > 0) {
        const lastTurn = lastAttemptTurn.get(pk)!;
        if (userTurns.length - 1 - lastTurn < TYPO_MERGE_COOLDOWN_TURNS) continue;
      }

      const { survivor } = proposeSurvivor(a, b, structuralAtoms, socialBonds, attributes);
      candidates.push({
        kind: "typoMerge",
        pairKey: pk,
        firstStableKey: keyA,
        firstName: a.name,
        secondStableKey: keyB,
        secondName: b.name,
        proposedSurvivorName: survivor.name,
        attemptNumber: (attemptsSoFar + 1) as 1 | 2
      });
    }
  }
  return candidates;
}

/** The candidate pool for ANSWERING (confirm or dismiss) — every typo-merge question already asked (per reply_sent's gateActions.typoMergeAskFired) that hasn't since been merged or dismissed. No cooldown, same reasoning as findPendingCoReferenceQuestions: the owner answering the very next turn is the common case. */
export function findPendingTypoMergeQuestions(eventLog: EventLog, userId: string): TypoMergePendingPairing[] {
  const resolvedKeys = new Set([
    ...findRetractableCoReferencePairings(eventLog, userId).map((p) => pairKey(p.placeholderStableKey, p.realStableKey)),
    ...findDismissedTypoMergePairs(eventLog, userId)
  ]);
  const pending = new Map<string, TypoMergePendingPairing>();
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const fired = (event.payload as ReplySentPayload).gateActions?.typoMergeAskFired;
    if (!fired) continue;
    if (resolvedKeys.has(fired.pairKey)) continue;
    pending.set(fired.pairKey, fired);
  }
  return [...pending.values()];
}

/**
 * Confirm: the owner agreed (survivingNameRaw null — go with the proposed
 * name) or named a specific survivor explicitly (matched against either
 * side; unmatched free text is treated the same as agreeing, never a
 * guess). Reuses buildCoReferenceMergePayload — literally the same
 * function the owner-initiated path uses, per the design report ("the
 * merge itself reuses the owner-initiated path").
 */
export function resolveTypoMergeConfirmation(pending: TypoMergePendingPairing[], pairKeyToMatch: string, survivingNameRaw: string | null): CoReferenceConfirmedPayload | null {
  const match = pending.find((p) => p.pairKey === pairKeyToMatch);
  if (!match) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  const survivorIsFirst = survivingNameRaw && norm(survivingNameRaw) === norm(match.firstName);
  const survivorIsSecond = survivingNameRaw && norm(survivingNameRaw) === norm(match.secondName);
  const survivorName = survivorIsFirst ? match.firstName : survivorIsSecond ? match.secondName : match.proposedSurvivorName;
  const survivor = survivorName === match.firstName ? { name: match.firstName, stableKey: match.firstStableKey } : { name: match.secondName, stableKey: match.secondStableKey };
  const losing = survivor.stableKey === match.firstStableKey ? { name: match.secondName, stableKey: match.secondStableKey } : { name: match.firstName, stableKey: match.firstStableKey };
  return buildCoReferenceMergePayload(survivor, losing);
}

/** Dismiss: the owner said these are different people. Permanent — resolveTypoMergeDismissal always targets the SAME pair going forward via findDismissedTypoMergePairs, never a cooldown or attempt-count concern. */
export function resolveTypoMergeDismissal(pending: TypoMergePendingPairing[], pairKeyToMatch: string): CoReferenceDismissalPayload | null {
  const match = pending.find((p) => p.pairKey === pairKeyToMatch);
  if (!match) return null;
  return { kind: "coReferenceDismissal", firstStableKey: match.firstStableKey, secondStableKey: match.secondStableKey };
}

export function buildTypoMergeAskDirective(candidate: TypoMergeCandidate): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally check something: could "${candidate.firstName}" and "${candidate.secondName}" actually be the same person, just spelled a little differently? Word it as genuine curiosity and propose your own best guess at which spelling to use rather than asking them to pick — something in the register of "wait, is '${candidate.secondName}' just how you spelled '${candidate.firstName}'? I'll go with '${candidate.proposedSurvivorName}' unless you tell me otherwise." Never say anything about records, similarity, tracking, or how you keep this straight — just ask, naturally.\n=== END GATE DIRECTIVE ===`;
}

/** Requires both names, mirroring verifyCoReferenceAskExecuted (not verifyMergeProposalExecuted's looser, survivor-only check) — this ask poses an identity question naturally about two specific things, the same shape that verification already covers correctly for coReference's own ask. */
export function verifyTypoMergeAskExecuted(candidate: TypoMergeCandidate, replyText: string): boolean {
  const lower = replyText.toLowerCase();
  return lower.includes(candidate.firstName.toLowerCase()) && lower.includes(candidate.secondName.toLowerCase());
}
