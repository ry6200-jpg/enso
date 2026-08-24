import type { EventLog } from "../events/eventLog.js";
import type { EventRecord } from "../events/schema.js";
import type { ProjectionsDb } from "../projections/db.js";
import { primaryEntityId } from "../projections/rebuild.js";
import { getPrimaryUserAttribute } from "../projections/peopleView.js";
import type { RecentTurnForPrompt } from "../persona/systemPrompt.js";
import type { ElicitationCandidate, ElicitationLayer1ProbeType, ElicitationLayer3ProbeType } from "./router/routerTypes.js";
import type { ReplySentPayload } from "./chatPipeline.js";
import type { MessageExtractionCompletedPayload } from "../extraction/resilientExtraction.js";
import { buildEntityDensityByMessageId, buildMessageTextById, computeInterestScore, rankByInterestWithRotation, recentlyFiredStableKeys } from "./entityInterest.js";

/**
 * ============================================================================
 * EN-097: elicitation — Enso actively helping someone talk about themselves,
 * not waiting to be handed material. Three layers, exactly as scoped:
 *
 * Layer 1 (NAME GENERATORS): fires unconditionally whenever the shared
 * curiosityTurn eligibility gate (circleBack.ts's isCuriosityTurnEligible)
 * passes — no coverage dependency, works on a completely empty archive.
 * The answer is a name; ordinary extraction populates the entity model from
 * it exactly like any other mention, no special-casing needed here.
 *
 * Layer 2 (LIFE DOMAINS): NOT a candidate kind, never offered to the router,
 * never spoken. Its only job is breaking a tie between Layer 1 and Layer 3
 * when BOTH are eligible the same turn (see rankElicitationCandidate) — it
 * never gates Layer 1's own eligibility, and it never limits what Enso may
 * be curious about in ordinary conversation (the user's own correction,
 * mid-build): only 5 of the 10 named domains (work, family,
 * closeFriendship, partnership, homePlace) are derivable from
 * entity_attributes/structural_atoms/social_bonds today, so only those 5
 * feed this tiebreak. The other 5 (health, money, learning, recreation,
 * meaning) are fully legitimate conversational territory and the raw event
 * log captures them like anything else the user says — "untracked" here
 * means "not usable for gap ranking," never "off limits" or "not stored."
 * Recorded as an explicit open item in Section 12, not buried in a comment.
 *
 * Layer 3 (KEY SCENES): unlocked only once an anchor PERSON exists — an
 * established entity (a structural_atom or social_bond connecting it to
 * the primary user; the exact same "established" test circleBack.ts's own
 * findEligibleCircleBackCandidates already uses, reused here rather than
 * reinvented). "Anchor period" from the original brief isn't representable
 * at all — entities are people-only (EN-011) — so this is scoped to
 * person-anchors, flagged as the same kind of documented, deferred gap as
 * the domain-coverage limitation above.
 * ============================================================================
 */

export const LAYER1_PROBE_TYPES: readonly ElicitationLayer1ProbeType[] = ["goodNews", "call2am", "seeVsMatter", "lostTouch", "dependsOnThem", "knownLongest"];
export const LAYER3_PROBE_TYPES: readonly ElicitationLayer3ProbeType[] = ["howMet", "earliestMemory", "highPoint", "lowPoint", "turningPoint", "wantRemembered"];

/**
 * Production bug batch, item 1(a): a topic can be dismissed in prose
 * ("you keep asking about this," Enso agreeing to drop it) without ever
 * touching a gate — MAX_LAYER3_ATTEMPTS_PER_PAIR already caps a single
 * probeType at one GATED fire, but organic (ungated) curiosity about the
 * same anchor is uncapped by anything, so a real dismissal or Enso's own
 * self-correction was pure conversation text with nothing to persist it.
 * Live-caught: the owner explicitly called out Enso repeatedly circling
 * back to one relationship's origin story mid-session, Enso agreed to
 * drop it, and the very next SESSION's opening reply led with the exact
 * same topic — the "leave it alone" only ever held within that one live
 * context window.
 *
 * Same fix shape as circleBack.ts's own principle, reused rather than
 * reinvented — not "classify whether that was a dismissal" (circleBack's
 * own header comment explicitly rejects that for identity-clarification,
 * since silence/dismissal/anything-in-between are genuinely
 * indistinguishable there), but a short, explicit signal list checked
 * structurally, the exact same technique this codebase already trusts for
 * isWindingDown's DEPLETION_SIGNALS/PERMISSION_TO_STOP_SIGNALS (both
 * roles' text, no free-form judgment). Unlike isWindingDown's whole-axis
 * suppression, this is attributed to whichever established anchor is
 * actually named in the SAME turn as the signal, so dismissing one
 * person's topic never silences curiosity about anyone else.
 */
export const TOPIC_DISMISSAL_SIGNALS = [
  "keep asking",
  "already told you",
  "already answered",
  "asked me this before",
  "asked this already",
  "we've been over this",
  "we already covered this",
  "drop it",
  "leave it alone",
  "let it go",
  "let this go",
  "stop asking",
  "move on from that",
  "i'll leave it",
  "i'll let it go",
  "i'll drop it"
];

/**
 * True when a dismissal-shaped phrase (TOPIC_DISMISSAL_SIGNALS) appears in
 * the SAME turn as this anchor's own name. Scans the FULL event log, not
 * a session window — the same cross-session derivation discipline every
 * other gate-state function in this file already uses (firedElicitationHistory,
 * askedPairs) — which is what makes a dismissal survive into the NEXT
 * session's candidate ranking, the actual bug this closes.
 */
export function wasTopicDismissed(eventLog: EventLog, userId: string, anchorName: string): boolean {
  const lowerName = anchorName.toLowerCase();
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "message_sent" && event.type !== "reply_sent") continue;
    const text = ((event.payload as { text?: string }).text ?? "").toLowerCase();
    if (!text.includes(lowerName)) continue;
    if (TOPIC_DISMISSAL_SIGNALS.some((signal) => text.includes(signal))) return true;
  }
  return false;
}

/** Each Layer 1 subtype fires at most once ever — six greatest-hits onboarding questions, not a repeatable rotation (repeating "who would you call at 2am" verbatim months later would be exactly the near-verbatim-repetition defect R22 already names for a different gate). Once all six are spent, Layer 1 goes permanently dormant and Layer 3/third-party carry the relationship forward. */
export const MAX_LAYER1_ATTEMPTS_PER_PROBE_TYPE = 1;
/** Each (probeType, anchor) pair is a distinct question about a distinct person — "how you met Marcus" and "how you met Elena" are not duplicates — so this caps per-pair, not per-probeType globally. */
export const MAX_LAYER3_ATTEMPTS_PER_PAIR = 1;

function isEstablished(projections: ProjectionsDb, userId: string, entityId: string): boolean {
  const primary = primaryEntityId(userId);
  const connectsToPrimary = (a: string, b: string) => (a === entityId && b === primary) || (a === primary && b === entityId);
  return (
    projections.listStructuralAtoms(userId).some((atom) => connectsToPrimary(atom.from_entity_id, atom.to_entity_id)) ||
    projections.listSocialBonds(userId).some((bond) => connectsToPrimary(bond.from_entity_id, bond.to_entity_id))
  );
}

interface DomainCoverage {
  work: boolean;
  family: boolean;
  closeFriendship: boolean;
  partnership: boolean;
  homePlace: boolean;
}

/**
 * Layer 2's actual computation — the 5 domains derivable from real
 * structured data, nothing more. Deliberately excludes health/money/
 * learning/recreation/meaning: there is no column, attribute type, or
 * entity kind anywhere in the schema that could compute these honestly
 * (see the file-level comment and Section 12's open item).
 */
export function domainCoverage(projections: ProjectionsDb, userId: string): DomainCoverage {
  const primary = primaryEntityId(userId);
  const connectsToPrimary = (a: string, b: string) => a === primary || b === primary;
  const atoms = projections.listStructuralAtoms(userId);
  const bonds = projections.listSocialBonds(userId);
  return {
    work: getPrimaryUserAttribute(projections, userId, "occupation") !== null || bonds.some((b) => b.type === "colleague" && connectsToPrimary(b.from_entity_id, b.to_entity_id)),
    family: atoms.some((a) => connectsToPrimary(a.from_entity_id, a.to_entity_id)),
    closeFriendship: bonds.some((b) => b.type === "friend" && connectsToPrimary(b.from_entity_id, b.to_entity_id)),
    partnership: bonds.some((b) => b.type === "romantic" && connectsToPrimary(b.from_entity_id, b.to_entity_id)) || atoms.some((a) => a.type === "spouse_of" && connectsToPrimary(a.from_entity_id, a.to_entity_id)),
    homePlace: getPrimaryUserAttribute(projections, userId, "location") !== null
  };
}

/** The tiebreak signal: how many of the RELATIONSHIP-shaped domains (family/closeFriendship/partnership — work and homePlace are excluded since those are the self-fact mechanism's job, not elicitation's) are still uncovered. High means breadth (Layer 1) still matters more than depth (Layer 3). */
function uncoveredRelationshipDomainCount(projections: ProjectionsDb, userId: string): number {
  const c = domainCoverage(projections, userId);
  return [c.family, c.closeFriendship, c.partnership].filter((covered) => !covered).length;
}

function userMessageTurns(eventLog: EventLog, userId: string): EventRecord[] {
  return eventLog.listForUser(userId).filter((e) => e.type === "message_sent" && e.actor === "user");
}

interface FiredElicitation {
  layer: 1 | 3;
  probeType: string;
  anchorStableKey?: string;
  turnIndex: number;
}

function firedElicitationHistory(eventLog: EventLog, userId: string, userTurns: EventRecord[]): FiredElicitation[] {
  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const history: FiredElicitation[] = [];
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const payload = event.payload as ReplySentPayload;
    const fired = payload.gateActions?.elicitationFired;
    if (!fired) continue;
    const turnIndex = turnIndexByMessageId.get(payload.inReplyToEventId) ?? userTurns.length - 1;
    history.push({ ...fired, turnIndex });
  }
  return history;
}

/**
 * EN-097's "zero added cost" effectiveness derivation. Extraction already
 * runs on every turn (turnMemoryRefresh.ts) and is awaited before the next
 * request in the web app (app/api/chat/route.ts) — so by the time this
 * function's caller needs to rank candidates, the PREVIOUS turn's
 * extraction_completed event (if any) is already committed. Yield is the
 * user's next-message word count plus everything extraction actually found
 * from it (entities + structural atoms + social bonds + attributes +
 * stated feelings + episode markers — the full structure, not a subset) —
 * a genuinely opened door produces a longer, richer answer; a dud produces
 * "not much." No new event type, no extra API call: this is a pure scan of
 * events already recorded for other reasons, the same derivation
 * discipline as circleBack.ts's own cooldown scan.
 */
function probeYield(eventLog: EventLog, userId: string, userTurns: EventRecord[], firedTurnIndex: number): number | null {
  const answerTurn = userTurns[firedTurnIndex + 1];
  if (!answerTurn) return null; // no answer yet — can't score this firing
  const text = (answerTurn.payload as { text: string }).text;
  const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const extraction = eventLog.listForUser(userId).find((e) => e.type === "extraction_completed" && (e.payload as { sourceEventId?: string }).sourceEventId === answerTurn.id);
  if (!extraction) return wordCount; // extraction failed or hasn't run — score on the answer's length alone rather than discarding the sample
  const p = extraction.payload as MessageExtractionCompletedPayload;
  const extractedCount = p.entities.length + p.structuralAtoms.length + p.socialBonds.length + p.attributes.length + p.statedFeelings.length + p.episodeMarkers.length;
  return wordCount + extractedCount;
}

/** Average historical yield per Layer 1 probeType, for this user, from real turns — null when never tried (explore, not a score of 0). */
function layer1EffectivenessByProbeType(eventLog: EventLog, userId: string, userTurns: EventRecord[], history: FiredElicitation[]): Map<ElicitationLayer1ProbeType, number> {
  const scores = new Map<ElicitationLayer1ProbeType, number[]>();
  for (const h of history) {
    if (h.layer !== 1) continue;
    const y = probeYield(eventLog, userId, userTurns, h.turnIndex);
    if (y === null) continue;
    const key = h.probeType as ElicitationLayer1ProbeType;
    scores.set(key, [...(scores.get(key) ?? []), y]);
  }
  const averages = new Map<ElicitationLayer1ProbeType, number>();
  for (const [key, ys] of scores) averages.set(key, ys.reduce((a, b) => a + b, 0) / ys.length);
  return averages;
}

/**
 * Layer 1 candidate: at most one, ranked by (1) never-tried subtypes first
 * — explore before exploit — in the fixed order LAYER1_PROBE_TYPES lists
 * them; (2) once every subtype has fired at least once, whichever has the
 * highest historical yield for THIS user. Attempted-and-capped subtypes
 * (MAX_LAYER1_ATTEMPTS_PER_PROBE_TYPE reached) are never offered again.
 */
function findLayer1Candidate(eventLog: EventLog, userId: string): ElicitationCandidate | null {
  const userTurns = userMessageTurns(eventLog, userId);
  const history = firedElicitationHistory(eventLog, userId, userTurns);
  const attemptCounts = new Map<string, number>();
  for (const h of history) if (h.layer === 1) attemptCounts.set(h.probeType, (attemptCounts.get(h.probeType) ?? 0) + 1);

  const eligible = LAYER1_PROBE_TYPES.filter((p) => (attemptCounts.get(p) ?? 0) < MAX_LAYER1_ATTEMPTS_PER_PROBE_TYPE);
  if (eligible.length === 0) return null; // all six spent, permanently dormant

  const neverTried = eligible.filter((p) => (attemptCounts.get(p) ?? 0) === 0);
  if (neverTried.length > 0) return { kind: "elicitation", layer: 1, probeType: neverTried[0]! };

  const effectiveness = layer1EffectivenessByProbeType(eventLog, userId, userTurns, history);
  const ranked = [...eligible].sort((a, b) => (effectiveness.get(b) ?? 0) - (effectiveness.get(a) ?? 0));
  return { kind: "elicitation", layer: 1, probeType: ranked[0]! };
}

/**
 * Layer 3 candidate: picks the most-recently-established anchor entity
 * (freshest in the conversation) and offers the first not-yet-asked scene
 * type about THEM, in the fixed canonical order LAYER3_PROBE_TYPES lists —
 * "how you met" before "what would you want remembered," going deep on one
 * person before spreading to the next, matching the brief's framing of
 * Layer 3 as depth, not breadth.
 *
 * R44: `askedPairs` keys on each anchor's STABLE key (earliest provenance
 * event ULID — sourceIds[0], the same pattern circleBack.ts's stableKey
 * already uses), never the ephemeral projection entityId, which is
 * reassigned on every rebuild (EN-054). A real bug found live: three
 * separate "how did you meet" askings for the SAME real person, each
 * recording a DIFFERENT anchorEntityId, because the projection had been
 * rebuilt between them — the (probeType, anchor) cap never actually
 * engaged. This is the identical bug class CircleBackCandidate's own doc
 * comment already names as fixed once in circleBack.ts; it had never been
 * applied here.
 *
 * BREADTH-BEFORE-DEPTH (see entityInterest.ts): even with R44's cap
 * correctly engaged, ordering anchors by "most recently mentioned" alone
 * let one live, correctly-top-ranked anchor monopolize every Layer 3
 * selection — six probe types exhausted on the same person before any
 * other established anchor got a turn, the live-caught failure this
 * batch fixes. Anchors are now ranked by return/elaboration interest
 * (never kinship distance — see entityInterest.ts), then any anchor asked
 * about (any probe type) within the last few selections is moved to the
 * back regardless of score — a correctly top-ranked thread still yields
 * the floor.
 */
export function findLayer3Candidate(eventLog: EventLog, projections: ProjectionsDb, userId: string): ElicitationCandidate | null {
  const userTurns = userMessageTurns(eventLog, userId);
  const history = firedElicitationHistory(eventLog, userId, userTurns);
  const layer3History = history.filter((h) => h.layer === 3);
  const askedPairs = new Set(layer3History.map((h) => `${h.anchorStableKey}:${h.probeType}`));
  const recentAnchors = recentlyFiredStableKeys(layer3History.filter((h) => h.anchorStableKey !== undefined).map((h) => ({ stableKey: h.anchorStableKey!, turnIndex: h.turnIndex })));

  const turnIndexByMessageId = new Map(userTurns.map((t, i) => [t.id, i]));
  const allEntities = projections.listEntities(userId);
  const entityDensityByMessageId = buildEntityDensityByMessageId(allEntities.map((e) => JSON.parse(e.source_event_ids) as string[]));
  const messageTextById = buildMessageTextById(userTurns);

  const anchors = allEntities
    .filter((e) => isEstablished(projections, userId, e.id))
    .filter((e) => !wasTopicDismissed(eventLog, userId, e.name))
    .map((e) => {
      const sourceIds = (JSON.parse(e.source_event_ids) as string[]).slice().sort();
      const stableKey = sourceIds[0] ?? "";
      const interest = computeInterestScore(stableKey, sourceIds, turnIndexByMessageId, messageTextById, entityDensityByMessageId);
      return { entity: e, stableKey, returnScore: interest.returnScore, elaborationScore: interest.elaborationScore };
    })
    .filter((a) => a.stableKey !== ""); // no provenance at all — nothing to key attempts on

  const rankedAnchors = rankByInterestWithRotation(anchors, recentAnchors);

  for (const { entity, stableKey } of rankedAnchors) {
    for (const probeType of LAYER3_PROBE_TYPES) {
      if (askedPairs.has(`${stableKey}:${probeType}`)) continue;
      return { kind: "elicitation", layer: 3, probeType, anchorEntityId: entity.id, anchorName: entity.name, anchorStableKey: stableKey };
    }
  }
  return null; // every established anchor has exhausted all six scene types
}

/**
 * Production bug batch, item 1(b): a THIN POOL — effectively one person
 * established at all — is a distinct condition from "many candidates,
 * ranked badly." domainCoverage is binary (any friend at all marks
 * closeFriendship "covered"), so an owner with exactly one close local
 * relationship looks identical to the tiebreak as one with five, and
 * favors depth (Layer 3) over breadth (Layer 1) either way — live-caught
 * circling back to the one relationship on record instead of ever
 * broadening the pool. Same "established" test as findLayer3Candidate,
 * not a new one.
 */
export const THIN_POOL_ANCHOR_THRESHOLD = 1;

function establishedAnchorCount(projections: ProjectionsDb, userId: string): number {
  return projections.listEntities(userId).filter((e) => isEstablished(projections, userId, e.id)).length;
}

/**
 * Orchestrator: Layer 1 and Layer 3 candidates computed independently,
 * then Layer 2's coverage signal breaks the tie ONLY when both exist this
 * turn — it never gates either layer's own eligibility (the user's
 * explicit correction mid-build). High uncovered-relationship-domain count
 * favors breadth (Layer 1: surface a new name); low count favors depth
 * (Layer 3: deepen an anchor already established) — EXCEPT when the pool
 * itself is thin (THIN_POOL_ANCHOR_THRESHOLD), which forces breadth
 * regardless of domain coverage, since coverage alone can't tell "one
 * friend" from "five."
 */
export function findElicitationCandidate(eventLog: EventLog, projections: ProjectionsDb, userId: string): ElicitationCandidate | null {
  const layer1 = findLayer1Candidate(eventLog, userId);
  const layer3 = findLayer3Candidate(eventLog, projections, userId);
  if (layer1 && layer3) {
    if (establishedAnchorCount(projections, userId) <= THIN_POOL_ANCHOR_THRESHOLD) return layer1;
    return uncoveredRelationshipDomainCount(projections, userId) >= 2 ? layer1 : layer3;
  }
  return layer1 ?? layer3;
}

/**
 * THE FAILURE MODE TO GUARD HARDEST: when someone opens up in response to
 * an elicitation probe, the next move is a continuer, not another probe —
 * an interview is the opposite of what this feature is for. Detected the
 * same cheap-heuristic way as everything else in this gate family: did the
 * immediately preceding reply fire an elicitation probe, and does the
 * CURRENT message look substantive (not a one-word or near-empty answer)?
 * Biased toward over-suppressing rather than under-suppressing — missing
 * one probing opportunity is a minor cost; piling a second question onto
 * someone who just opened up is the named regression (R33).
 */
const SUBSTANTIVE_ANSWER_MIN_WORDS = 5;

export function justOpenedUpFromElicitation(eventLog: EventLog, userId: string, currentMessage: string): boolean {
  const lastReply = [...eventLog.listForUser(userId)].reverse().find((e) => e.type === "reply_sent");
  if (!lastReply) return false;
  const fired = (lastReply.payload as ReplySentPayload).gateActions?.elicitationFired;
  if (!fired) return false;
  const wordCount = currentMessage.trim().length === 0 ? 0 : currentMessage.trim().split(/\s+/).length;
  return wordCount >= SUBSTANTIVE_ANSWER_MIN_WORDS;
}

/**
 * WHAT, never HOW — same split as buildCircleBackDirective/
 * buildSelfFactDirective/buildConnectDotDirective. Layer 1's directive
 * names the CONCEPT behind the probeType, explicitly demanding fresh
 * phrasing (never templated, never verbatim from this file's own
 * comments) and, per "on a thin thread prefer offering over selecting,"
 * invites the model to frame it as an open direction rather than a single
 * pointed question when that reads more natural. Layer 3's directive names
 * the anchor and the scene concept, reusing whatever the model already
 * knows about that person from retrieved context.
 */
const LAYER1_PROBE_CONCEPTS: Record<ElicitationLayer1ProbeType, string> = {
  goodNews: "who they'd tell first if something good happened to them",
  call2am: "who they'd call if something went wrong at 2am",
  seeVsMatter: "who they see most often, versus who matters most to them — these aren't always the same person",
  lostTouch: "someone they've lost touch with but still think about",
  dependsOnThem: "who depends on them",
  knownLongest: "who they've known the longest"
};

const LAYER3_PROBE_CONCEPTS: Record<ElicitationLayer3ProbeType, string> = {
  howMet: "how they first met this person",
  earliestMemory: "their earliest memory of this person",
  highPoint: "a high point in their relationship with this person",
  lowPoint: "a low point in their relationship with this person",
  turningPoint: "a moment that changed the shape of their relationship with this person",
  wantRemembered: "what they'd want remembered about this person"
};

export function buildElicitationDirective(candidate: ElicitationCandidate): string {
  if (candidate.layer === 1) {
    return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally and warmly, help the owner talk about ${LAYER1_PROBE_CONCEPTS[candidate.probeType]}. The goal is opening a door, not collecting an answer — word it completely freshly in your own voice, never a template. On a genuinely thin thread, it often reads more natural to name a couple of possible directions and let them pick, rather than deciding for them. Never let this feel like an intake question — it should read like something a genuinely curious friend would wonder about, not a form field.\n=== END GATE DIRECTIVE ===`;
  }
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nSomewhere in this reply, naturally, ask ${candidate.anchorName} about ${LAYER3_PROBE_CONCEPTS[candidate.probeType]} — you know enough about them now to go a layer deeper. Word it completely freshly in your own voice, grounded in whatever you actually already know about ${candidate.anchorName}, never a generic template question.\n=== END GATE DIRECTIVE ===`;
}

/**
 * EN-073-style verification: loose on purpose. Unlike circle-back (which
 * checks for a specific name) or self-fact (specific keywords), an
 * elicitation probe's actual phrasing is fully freshly generated — the
 * only mechanically checkable signal is that the reply asked SOMETHING
 * (ends in a question, or names the anchor for a Layer 3 probe). This
 * can't verify the probe matched its intended concept; it only guards
 * against the decided-but-not-executed case (R7) the same way every other
 * gate in this family does.
 */
export function verifyElicitationExecuted(candidate: ElicitationCandidate, replyText: string): boolean {
  const asksSomething = replyText.trim().endsWith("?");
  if (candidate.layer === 1) return asksSomething;
  return asksSomething && replyText.toLowerCase().includes(candidate.anchorName.toLowerCase());
}
