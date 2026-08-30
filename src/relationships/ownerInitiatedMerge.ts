import type { EventLog } from "../events/eventLog.js";
import type { EntityAliasRow, EntityAttributeRow, EntityRow, SocialBondRow, StructuralAtomRow } from "../projections/db.js";
import { normalizeForMatching } from "../entities/resolutionCascade.js";

/** Same one-line normalization rebuild.ts's own (private) `normalize` uses — trimmed, lowercased, nothing fuzzy. Duplicated rather than exported from rebuild.ts, which doesn't otherwise expose any of its internal name-resolution helpers. */
function normalize(name: string): string {
  return name.trim().toLowerCase();
}
import { findRetractableCoReferencePairings, stableKeyOf, type CoReferenceConfirmedPayload } from "../conversation/coReference.js";
import type { ReplySentPayload } from "../conversation/chatPipeline.js";

/**
 * Owner-initiated merge (following the alias-suppression fix and its own
 * design report). "Ah Song and An Song are the same person," recognized in
 * ordinary conversation, resolved against the current roster, and folded
 * through the exact same coReference merge fold as the role-word ask —
 * with aliasSuppressed: false (the alias fix this module depends on),
 * since both sides here are always real names, never a role word.
 *
 * Distinct from coReference.ts's ask/confirm/retract axis on purpose (see
 * that design report): this recognizes an open-world statement naming any
 * two entities from the whole roster, not an answer validated against a
 * pre-rendered structural-collision candidate list. The router's job here
 * is narrow — report the name spans the CURRENT message actually contains,
 * verbatim, no lookup — and every real decision (does this name resolve,
 * is it ambiguous, who's already been proposed) happens here, in code,
 * against the real roster.
 */

export interface PendingMergeProposal {
  firstStableKey: string;
  firstName: string;
  secondStableKey: string;
  secondName: string;
  proposedSurvivorStableKey: string;
  proposedSurvivorName: string;
  losingStableKey: string;
  losingName: string;
}

/**
 * The latest merge proposal still awaiting an answer — mirrors
 * findPendingCoReferenceQuestions' shape exactly (scan reply_sent's
 * gateActions, exclude anything already resolved), scoped to
 * mergeProposalFired instead of coReferenceAskFired. "Already resolved"
 * here means a coReference confirmation already exists for this exact
 * unordered pair — reusing findRetractableCoReferencePairings rather than
 * a second, parallel bookkeeping mechanism, since a merge proposal and a
 * role-word confirmation both resolve to the identical fact_confirmed
 * shape and both close out the same way.
 */
export function findPendingMergeProposal(eventLog: EventLog, userId: string): PendingMergeProposal | null {
  const confirmedPairKeys = new Set(findRetractableCoReferencePairings(eventLog, userId).map((p) => [p.placeholderStableKey, p.realStableKey].sort().join("|")));
  let latest: PendingMergeProposal | null = null;
  for (const event of eventLog.listForUser(userId)) {
    if (event.type !== "reply_sent") continue;
    const fired = (event.payload as ReplySentPayload).gateActions?.mergeProposalFired;
    if (!fired) continue;
    const pairKey = [fired.firstStableKey, fired.secondStableKey].sort().join("|");
    if (confirmedPairKeys.has(pairKey)) continue;
    latest = fired; // events iterate chronologically — the last one on record wins
  }
  return latest;
}

export type MergeNameResolution = { outcome: "resolved"; entity: EntityRow } | { outcome: "unresolved" } | { outcome: "ambiguous"; matches: EntityRow[] };

/** Resolves a free-text name (as the owner said it) against the CURRENT roster — exact/normalized match on either the entity's own name or any of its aliases. Never fuzzy: a merge instruction naming the wrong person by a near-miss spelling is exactly the kind of mistake this must not paper over on its own. */
export function resolveMergeName(name: string, entities: EntityRow[], aliases: EntityAliasRow[]): MergeNameResolution {
  const lower = normalize(name);
  const matched = normalizeForMatching(name);
  const idsByName = entities.filter((e) => normalize(e.name) === lower).map((e) => e.id);
  const idsByAlias = aliases.filter((a) => normalize(a.alias) === lower || normalizeForMatching(a.alias) === matched).map((a) => a.entity_id);
  const matchIds = [...new Set([...idsByName, ...idsByAlias])];
  const matches = matchIds.map((id) => entities.find((e) => e.id === id)).filter((e): e is EntityRow => !!e);
  if (matches.length === 0) return { outcome: "unresolved" };
  if (matches.length > 1) return { outcome: "ambiguous", matches };
  return { outcome: "resolved", entity: matches[0]! };
}

/** Bonds (structural atoms + social bonds, either direction) + attributes + mentions (own source_event_ids count) — a deterministic, explainable proxy for "more established history." Ties broken by earliest stable key (whichever has been on record longer) so the rule never has to guess. */
function establishedHistoryScore(entity: EntityRow, structuralAtoms: StructuralAtomRow[], socialBonds: SocialBondRow[], attributes: EntityAttributeRow[]): number {
  const bondCount =
    structuralAtoms.filter((a) => a.from_entity_id === entity.id || a.to_entity_id === entity.id).length +
    socialBonds.filter((a) => a.from_entity_id === entity.id || a.to_entity_id === entity.id).length;
  const attributeCount = attributes.filter((a) => a.entity_id === entity.id).length;
  const mentionCount = (JSON.parse(entity.source_event_ids) as string[]).length;
  return bondCount + attributeCount + mentionCount;
}

export const PROPOSE_SURVIVOR_RULE = "more established history (bond count + attribute count + mention count), ties broken by earliest stable key";

/** Deterministic survivor proposal for when the owner didn't say which name to keep — see PROPOSE_SURVIVOR_RULE for exactly what "more established" means here. */
export function proposeSurvivor(
  a: EntityRow,
  b: EntityRow,
  structuralAtoms: StructuralAtomRow[],
  socialBonds: SocialBondRow[],
  attributes: EntityAttributeRow[]
): { survivor: EntityRow; losing: EntityRow } {
  const scoreA = establishedHistoryScore(a, structuralAtoms, socialBonds, attributes);
  const scoreB = establishedHistoryScore(b, structuralAtoms, socialBonds, attributes);
  if (scoreA !== scoreB) return scoreA > scoreB ? { survivor: a, losing: b } : { survivor: b, losing: a };
  const keyA = stableKeyOf(a) ?? "";
  const keyB = stableKeyOf(b) ?? "";
  return keyA <= keyB ? { survivor: a, losing: b } : { survivor: b, losing: a };
}

export type MergeRequestOutcome =
  | { outcome: "unresolvable"; name: string }
  | { outcome: "ambiguous"; name: string; matchNames: string[] }
  | { outcome: "alreadySame" }
  | { outcome: "propose"; proposal: PendingMergeProposal }
  | { outcome: "confirmed"; payload: CoReferenceConfirmedPayload };

function buildConfirmedPayload(survivor: EntityRow, losing: EntityRow): CoReferenceConfirmedPayload | null {
  const survivorKey = stableKeyOf(survivor);
  const losingKey = stableKeyOf(losing);
  if (!survivorKey || !losingKey) return null;
  return {
    kind: "coReference",
    placeholderStableKey: losingKey,
    placeholderName: losing.name,
    realStableKey: survivorKey,
    realName: survivor.name,
    // No natural "anchor" for a real-name-vs-real-name merge (unlike a
    // role-word collision, which is always relative to someone) — display/
    // audit only (see CoReferenceConfirmedPayload's own doc comment), left
    // empty rather than a misleading guess. KNOWN GAP: today nothing reads
    // this value for a merge produced here, but coReferenceConfirmedBlock
    // (routerSchema.ts) already renders every pairing's anchorName
    // unconditionally ("(re: ${anchorName})") for the RETRACT candidate
    // list, and any future admin/audit view built against
    // CoReferenceConfirmedPayload would likely do the same — an empty
    // string will surface as a literal blank there, not a crash, but not a
    // real answer either. Revisit if either of those ever needs to
    // describe a real-name merge meaningfully instead of just rendering "".
    anchorName: "",
    aliasSuppressed: false
  };
}

/**
 * The single entry point: turns a router-validated mergeRequest decision
 * (firstName/secondName verbatim from the current message, survivingName
 * if the owner stated or just confirmed one) into what should happen this
 * turn. Never trusts the router's name spans directly — every outcome here
 * is re-derived from the real roster, in code, the same defensive-second-
 * check discipline resolveAttestation/resolveCorrection/
 * resolveCoReferenceConfirmation already share.
 *
 * survivingNameRaw covers BOTH a fresh statement that named a survivor
 * ("...it's An Song, not Ah Song") AND an answer to an already-pending
 * proposal (a plain "yes" resolves, in the router prompt, to the proposed
 * name; a correction resolves to the other one) — by the time this
 * function runs, the router has already turned either shape into a
 * concrete name string or left it null; this function only needs to
 * resolve names and decide the outcome, never re-derive what a "yes"
 * meant.
 */
export function resolveMergeRequest(
  firstNameRaw: string,
  secondNameRaw: string,
  survivingNameRaw: string | null,
  entities: EntityRow[],
  aliases: EntityAliasRow[],
  structuralAtoms: StructuralAtomRow[],
  socialBonds: SocialBondRow[],
  attributes: EntityAttributeRow[]
): MergeRequestOutcome {
  const firstRes = resolveMergeName(firstNameRaw, entities, aliases);
  if (firstRes.outcome === "unresolved") return { outcome: "unresolvable", name: firstNameRaw };
  if (firstRes.outcome === "ambiguous") return { outcome: "ambiguous", name: firstNameRaw, matchNames: firstRes.matches.map((e) => e.name) };

  const secondRes = resolveMergeName(secondNameRaw, entities, aliases);
  if (secondRes.outcome === "unresolved") return { outcome: "unresolvable", name: secondNameRaw };
  if (secondRes.outcome === "ambiguous") return { outcome: "ambiguous", name: secondNameRaw, matchNames: secondRes.matches.map((e) => e.name) };

  const first = firstRes.entity;
  const second = secondRes.entity;
  if (first.id === second.id) return { outcome: "alreadySame" };

  if (survivingNameRaw) {
    const norm = normalize(survivingNameRaw);
    let payload: CoReferenceConfirmedPayload | null = null;
    if (norm === normalize(first.name)) payload = buildConfirmedPayload(first, second);
    else if (norm === normalize(second.name)) payload = buildConfirmedPayload(second, first);
    if (payload) return { outcome: "confirmed", payload };
    // Stated but didn't match either resolved name — fall through to
    // propose, the same outcome as not stating one at all, rather than
    // guessing which of the two was meant.
  }

  const { survivor, losing } = proposeSurvivor(first, second, structuralAtoms, socialBonds, attributes);
  const survivorKey = stableKeyOf(survivor);
  const losingKey = stableKeyOf(losing);
  const firstKey = stableKeyOf(first);
  const secondKey = stableKeyOf(second);
  if (!survivorKey || !losingKey || !firstKey || !secondKey) return { outcome: "unresolvable", name: !firstKey ? first.name : second.name };

  return {
    outcome: "propose",
    proposal: {
      firstStableKey: firstKey,
      firstName: first.name,
      secondStableKey: secondKey,
      secondName: second.name,
      proposedSurvivorStableKey: survivorKey,
      proposedSurvivorName: survivor.name,
      losingStableKey: losingKey,
      losingName: losing.name
    }
  };
}

export function buildUnresolvableMergeDirective(name: string): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just referred to merging in someone named "${name}", but there's nobody by that name on record. Somewhere in this reply, say so plainly and naturally — you don't have anyone named "${name}". Do not treat this as introducing a new person; this was a correction, not a new fact, so nobody gets added.\n=== END GATE DIRECTIVE ===`;
}

export function buildAmbiguousMergeDirective(name: string, matchNames: string[]): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner said "${name}" while talking about merging two people, but more than one person on record could match — specifically: ${matchNames.join(" or ")}. Somewhere in this reply, ask naturally which one they mean before doing anything else. Never guess or pick one yourself.\n=== END GATE DIRECTIVE ===`;
}

/** Confirmation-style, not an open choice (DECIDED): propose Enso's own best guess and let the owner correct it, rather than handing them a "which one?" question — see the design report this implements. */
export function buildMergeProposalDirective(survivorName: string, losingName: string): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just told you "${survivorName}" and "${losingName}" are the same person, without saying which name to keep. Somewhere in this reply, naturally CONFIRM your own best guess rather than asking them to choose — something in the register of "That's ${survivorName}, right?" or "So it's ${survivorName}, not ${losingName}?" Never say anything about records, tracking, or how you keep this straight — just check.\n=== END GATE DIRECTIVE ===`;
}

export function verifyMergeProposalExecuted(survivorName: string, losingName: string, replyText: string): boolean {
  const lower = replyText.toLowerCase();
  return lower.includes(survivorName.toLowerCase()) && lower.includes(losingName.toLowerCase());
}
