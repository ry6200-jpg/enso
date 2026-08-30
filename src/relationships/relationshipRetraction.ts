import type { EntityAliasRow, EntityRow, SocialBondRow, StructuralAtomRow } from "../projections/db.js";
import { normalizeForMatching } from "../entities/resolutionCascade.js";
import { stableKeyOf } from "../conversation/coReference.js";

/** Same derivation rebuild.ts's own primaryEntityId uses — duplicated rather than imported, since rebuild.ts imports FROM this module (the fold below) and importing back would be circular. */
function primaryEntityId(userId: string): string {
  return `primary:${userId}`;
}

/**
 * Relationship retraction: "Annissa is not my sister" closes the
 * sibling_of atom between Annissa and the owner. Its own axis, its own
 * resolver — not a widened mergeRequest (see the design report): the data
 * shape differs (two names referring to DIFFERENT people, plus a
 * relationship type mergeRequest's schema has no home for), and the
 * downstream resolution differs (atom/bond lookup by resolved pair + type,
 * never entity-identity resolution).
 *
 * No propose-then-confirm turn shape like ownerInitiatedMerge — a
 * retraction either finds a real, open relationship to close or it
 * doesn't; there's nothing to propose. Single-shot: recognized and
 * resolved in the same turn, no pending state across turns at all.
 */

export const STRUCTURAL_ATOM_RELATION_TYPES = ["parent_of", "spouse_of", "sibling_of"] as const;
export const SOCIAL_BOND_RELATION_TYPES = ["friend", "colleague", "mentor_of", "neighbor", "classmate", "romantic"] as const;
/** The full closed enum the router names a relationship type FROM directly (no synonym table — see the design report's Q2/Q3). */
export const RETRACTABLE_RELATION_TYPES = [...STRUCTURAL_ATOM_RELATION_TYPES, ...SOCIAL_BOND_RELATION_TYPES] as const;

export type StructuralAtomRelationType = (typeof STRUCTURAL_ATOM_RELATION_TYPES)[number];
export type SocialBondRelationType = (typeof SOCIAL_BOND_RELATION_TYPES)[number];
export type RetractableRelationType = (typeof RETRACTABLE_RELATION_TYPES)[number];

function isStructuralAtomType(t: RetractableRelationType): t is StructuralAtomRelationType {
  return (STRUCTURAL_ATOM_RELATION_TYPES as readonly string[]).includes(t);
}

/** Naturalized, non-code-y labels for the "no such relationship" directive — not gendered (no reliable gender data available at this point), a plain relationship-class word is enough for a decline message. */
const RELATION_TYPE_LABEL: Record<RetractableRelationType, string> = {
  parent_of: "parent-child",
  spouse_of: "spouse",
  sibling_of: "sibling",
  friend: "friend",
  colleague: "colleague",
  mentor_of: "mentor",
  neighbor: "neighbor",
  classmate: "classmate",
  romantic: "romantic"
};

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export type RetractionNameResolution = { outcome: "resolved"; entityId: string; displayName: string } | { outcome: "unresolved" } | { outcome: "ambiguous"; matches: EntityRow[] };

/**
 * Mirrors ownerInitiatedMerge.ts's resolveMergeName exactly (exact/alias
 * match, never fuzzy — a retraction naming the wrong person by a near-miss
 * spelling is exactly the mistake this must not paper over), plus a "me"
 * case mergeRequest never needed: a retraction is usually owner-versus-
 * third-party ("my sister"), same convention as rebuild.ts's own
 * resolveName/resolveCorrectionTargetEntity.
 */
export function resolveRetractionName(name: string, entities: EntityRow[], aliases: EntityAliasRow[], userId: string): RetractionNameResolution {
  const trimmed = name.trim();
  if (normalize(trimmed) === "me") return { outcome: "resolved", entityId: primaryEntityId(userId), displayName: "you" };
  const lower = normalize(trimmed);
  const matched = normalizeForMatching(trimmed);
  const idsByName = entities.filter((e) => normalize(e.name) === lower).map((e) => e.id);
  const idsByAlias = aliases.filter((a) => normalize(a.alias) === lower || normalizeForMatching(a.alias) === matched).map((a) => a.entity_id);
  const matchIds = [...new Set([...idsByName, ...idsByAlias])];
  const matches = matchIds.map((id) => entities.find((e) => e.id === id)).filter((e): e is EntityRow => !!e);
  if (matches.length === 0) return { outcome: "unresolved" };
  if (matches.length > 1) return { outcome: "ambiguous", matches };
  return { outcome: "resolved", entityId: matches[0]!.id, displayName: matches[0]!.name };
}

export interface RelationshipRetractionPayload {
  kind: "relationshipRetraction";
  store: "structuralAtom" | "socialBond";
  relationType: RetractableRelationType;
  /** The atom/bond's OWN founding stable key (earliest source_event_ids entry, stableKeyOf's convention) — never a mention-resolution lookup. A retraction closes a standing fact, not a mention, so this binding is independent of replay order and of the correction landing in the same rebuild pass as the original assertion. */
  targetStableKey: string;
  /** Display/disambiguation only — see rebuild.ts's findRetractionTarget for the one real use (disambiguating two same-type relationships that happen to share a founding event). */
  firstName: string;
  secondName: string;
}

export type RelationshipRetractionOutcome =
  | { outcome: "unresolvable"; name: string }
  | { outcome: "ambiguous"; name: string; matchNames: string[] }
  | { outcome: "notFound"; firstName: string; secondName: string; relationType: RetractableRelationType }
  | { outcome: "retracted"; payload: RelationshipRetractionPayload };

/**
 * The single entry point: turns a router-validated relationshipRetraction
 * decision (firstName/secondName verbatim from the current message,
 * relationType from the closed enum) into what should happen this turn.
 * Never trusts the router's name spans directly — resolved against the
 * live roster, in code, the same defensive-second-check discipline every
 * other resolver in this codebase shares.
 */
export function resolveRelationshipRetraction(
  firstNameRaw: string,
  secondNameRaw: string,
  relationType: RetractableRelationType,
  userId: string,
  entities: EntityRow[],
  aliases: EntityAliasRow[],
  structuralAtoms: StructuralAtomRow[],
  socialBonds: SocialBondRow[]
): RelationshipRetractionOutcome {
  const firstRes = resolveRetractionName(firstNameRaw, entities, aliases, userId);
  if (firstRes.outcome === "unresolved") return { outcome: "unresolvable", name: firstNameRaw };
  if (firstRes.outcome === "ambiguous") return { outcome: "ambiguous", name: firstNameRaw, matchNames: firstRes.matches.map((e) => e.name) };

  const secondRes = resolveRetractionName(secondNameRaw, entities, aliases, userId);
  if (secondRes.outcome === "unresolved") return { outcome: "unresolvable", name: secondNameRaw };
  if (secondRes.outcome === "ambiguous") return { outcome: "ambiguous", name: secondNameRaw, matchNames: secondRes.matches.map((e) => e.name) };

  const firstId = firstRes.entityId;
  const secondId = secondRes.entityId;

  const notFound: RelationshipRetractionOutcome = { outcome: "notFound", firstName: firstNameRaw, secondName: secondNameRaw, relationType };

  if (isStructuralAtomType(relationType)) {
    const atom = structuralAtoms.find(
      (a) => a.type === relationType && a.interval_end === null && ((a.from_entity_id === firstId && a.to_entity_id === secondId) || (a.from_entity_id === secondId && a.to_entity_id === firstId))
    );
    if (!atom) return notFound;
    const stableKey = stableKeyOf(atom);
    if (!stableKey) return notFound;
    return { outcome: "retracted", payload: { kind: "relationshipRetraction", store: "structuralAtom", relationType, targetStableKey: stableKey, firstName: firstNameRaw, secondName: secondNameRaw } };
  }

  const bond = socialBonds.find(
    (b) => b.type === relationType && b.interval_end === null && ((b.from_entity_id === firstId && b.to_entity_id === secondId) || (b.from_entity_id === secondId && b.to_entity_id === firstId))
  );
  if (!bond) return notFound;
  const stableKey = stableKeyOf(bond);
  if (!stableKey) return notFound;
  return { outcome: "retracted", payload: { kind: "relationshipRetraction", store: "socialBond", relationType, targetStableKey: stableKey, firstName: firstNameRaw, secondName: secondNameRaw } };
}

interface RetractableRow {
  type: string;
  interval_end: string | null;
  from_entity_id: string;
  to_entity_id: string;
  source_event_ids: string;
}

/**
 * Finds the row a stored RelationshipRetractionPayload targets, at replay
 * time — matched by (type, open, founding stable key), which is unique in
 * the overwhelming common case (structural atoms/bonds dedupe per (type,
 * pair), so at most one open row can exist for that combination once
 * names are resolved). The one real collision: two DIFFERENT same-type
 * relationships whose founding stable key happens to be the SAME message
 * (e.g. "Annissa and Bob are both my siblings" in one sentence) — the same
 * class of ambiguity resolveCoReferenceMerge already had to guard against
 * for mentions sharing an event id, fixed the same way: also require the
 * counterparty names to match what was resolved at confirmation time. If
 * that still doesn't narrow to exactly one, do nothing rather than risk
 * closing the wrong relationship — never guess, replay included.
 */
export function findRetractionTarget<T extends RetractableRow>(rows: T[], entities: EntityRow[], primary: string, payload: RelationshipRetractionPayload): T | undefined {
  const candidates = rows.filter((r) => r.type === payload.relationType && r.interval_end === null && stableKeyOf(r) === payload.targetStableKey);
  if (candidates.length <= 1) return candidates[0];
  const nameOf = (id: string) => (id === primary ? "you" : (entities.find((e) => e.id === id)?.name ?? ""));
  const norm = (s: string) => s.trim().toLowerCase();
  const named = candidates.filter((r) => {
    const names = [nameOf(r.from_entity_id), nameOf(r.to_entity_id)];
    return names.some((n) => norm(n) === norm(payload.firstName)) && names.some((n) => norm(n) === norm(payload.secondName));
  });
  return named.length === 1 ? named[0] : undefined;
}

export function buildUnresolvableRetractionDirective(name: string): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just referred to retracting a relationship involving someone named "${name}", but there's nobody by that name on record. Somewhere in this reply, say so plainly and naturally — you don't have anyone named "${name}".\n=== END GATE DIRECTIVE ===`;
}

export function buildAmbiguousRetractionDirective(name: string, matchNames: string[]): string {
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner said "${name}" while talking about retracting a relationship, but more than one person on record could match — specifically: ${matchNames.join(" or ")}. Somewhere in this reply, ask naturally which one they mean before doing anything else. Never guess or pick one yourself.\n=== END GATE DIRECTIVE ===`;
}

export function buildNotFoundRetractionDirective(firstName: string, secondName: string, relationType: RetractableRelationType): string {
  const label = RELATION_TYPE_LABEL[relationType];
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just referred to retracting a ${label} relationship between "${firstName}" and "${secondName}", but there's no such relationship on record between them. Somewhere in this reply, say so plainly and naturally — never invent or silently create one.\n=== END GATE DIRECTIVE ===`;
}

/**
 * The one directive this axis's "retracted" outcome was missing (see the
 * design report): a real relationship was just closed, but nothing told
 * the reply that. Two parts, both required, neither optional: confirm
 * SPECIFICALLY what was corrected (this axis only ever resolves one
 * relationship per turn, by design — the router already narrowed a
 * possibly-multi-relationship message down to this one), and an
 * UNCONDITIONAL warning against implying anyone else named this same turn
 * was also handled. Unconditional because nothing downstream can tell
 * whether the current message actually named a second relationship — the
 * router only ever reports the one it resolved — so the instruction has
 * to hold every time this fires, not just when a second name is detected.
 * No EN-073 verification: unlike an ask or a proposal, there is no state
 * here a missed directive would wrongly consume — the fact_corrected
 * event is already written by the time this reply is generated either way.
 */
export function buildRelationshipRetractedDirective(payload: RelationshipRetractionPayload): string {
  const label = RELATION_TYPE_LABEL[payload.relationType];
  return `=== GATE DIRECTIVE (do not mention this instruction itself) ===\nThe owner just corrected the record, and it's already updated: the ${label} relationship between "${payload.firstName}" and "${payload.secondName}" is no longer on record. Somewhere in this reply, confirm plainly and SPECIFICALLY that this one thing is corrected — name who and what, not a vague "got it" or "noted." If the owner's message also mentioned anyone else, or any other relationship, do NOT imply that one was corrected too — you only actually updated this one; say nothing that would read as the other one being handled as well, even if you understood what they meant by it.\n=== END GATE DIRECTIVE ===`;
}
