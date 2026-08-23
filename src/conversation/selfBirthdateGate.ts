import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "../projections/db.js";
import { getPrimaryUserBirthdate } from "../projections/peopleView.js";
import type { ReplySentPayload } from "./chatPipeline.js";

/**
 * Adversarial-test batch, item 1: "THE USER IS THE MOST IMPORTANT ENTITY."
 * Live evidence this was missing: Enso met a brand-new user, was given his
 * full name, and spent three consecutive turns chasing an incidental
 * third-party name instead of learning anything about the person actually
 * in the conversation — including never working toward the birthdate
 * already flagged (an earlier batch) as worth learning early. This gate
 * makes self-entity establishment (currently just the birthdate — there's
 * no separate name-establishment gate needed since the proactive opener,
 * src/persona/proactiveOpener.ts, already asks for the owner's name
 * unconditionally on the very first turn of every session) OUTRANK any
 * third-party circle-back candidate, rather than competing with it on
 * equal footing: see chatPipeline.ts, where this is checked BEFORE
 * third-party candidates are even offered to the router, and — when
 * eligible — replaces them entirely rather than being weighed against them.
 *
 * Deliberately simple, matching the same restraint level as circle-back's
 * own cheap local heuristic (never firing on a question, EN-071 stage 1)
 * rather than routing through a full judgment-gate call: this is a
 * standing, board-scoped priority ("we don't know the owner's birthdate
 * yet"), not a nuanced per-turn call worth a new LIVE-validated router
 * flag (EN-075's N=20 confusion-matrix bar) for what is fundamentally a
 * single fact this account will normally only ever need to ask about
 * once — see MAX_SELF_BIRTHDATE_ATTEMPTS below for the one exception.
 *
 * State is derived the same way circle-back derives its own state — a
 * scan of reply_sent.gateActions, never a new event type.
 *
 * Ambient/register/zodiac batch, item 4 #1: a real, confirmed production
 * dead end — the gate fired once, the owner's actual answer got misbound
 * to the wrong attribute (write-time validation, item 5, now prevents
 * this going forward but doesn't repair what already happened), and the
 * gate then never asked again because its one-shot budget was already
 * spent — regardless of whether that one attempt actually landed a valid
 * birthdate. Two later unprompted restatements ("4/24/1970" typed bare,
 * with no birthday-relevant question immediately before it) both
 * extracted nothing at all, confirmed by reading the real extraction
 * events directly: a bare fragment with no adjacent conversational anchor
 * isn't reliably recognized, so there was no path back to a valid value
 * without the gate asking again.
 *
 * MAX_SELF_BIRTHDATE_ATTEMPTS is now 2, but this is NOT "just ask twice
 * unconditionally" — isSelfBirthdateEligible below already checks
 * getPrimaryUserBirthdate(...) FIRST and returns false immediately once a
 * VALID birthdate exists, before this budget is ever consulted. That
 * means the second attempt is only ever reachable when the first one did
 * NOT land a valid value — this constant just widens the existing,
 * already-conditional budget from 1 to 2; it does not change what makes a
 * second ask eligible.
 */
export const MAX_SELF_BIRTHDATE_ATTEMPTS = 2;

function selfBirthdateAttemptCount(eventLog: EventLog, userId: string): number {
  let count = 0;
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const payload = event.payload as ReplySentPayload;
    if (payload.gateActions?.selfBirthdateAskFired) count++;
  }
  return count;
}

export function isSelfBirthdateEligible(eventLog: EventLog, projections: ProjectionsDb, userId: string, currentMessage: string): boolean {
  if (currentMessage.trim().endsWith("?")) return false; // same restraint as circle-back's own heuristic
  if (getPrimaryUserBirthdate(projections, userId)) return false; // already known — nothing to ask
  if (selfBirthdateAttemptCount(eventLog, userId) >= MAX_SELF_BIRTHDATE_ATTEMPTS) return false;
  return true;
}

export function buildSelfBirthdateDirective(): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally and briefly, tactfully work toward learning the owner's OWN birthdate — you don't have it on record yet. Weave it in like genuine interest in them, never as a direct database-style question ("what is your date of birth") and never framed as data collection. Word it freshly, in your own voice.\n=== END GATE DIRECTIVE ===`;
}

/** EN-073-style directive-execution verification, mirroring circle-back's own verifyCircleBackExecuted — a decided-but-not-executed ask must never consume the one-shot attempt (R7's lesson, applied here too). */
export function verifySelfBirthdateAskExecuted(replyText: string): boolean {
  const lower = replyText.toLowerCase();
  return lower.includes("birthday") || lower.includes("birth date") || lower.includes("born");
}
