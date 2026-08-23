import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "./db.js";
import { primaryEntityId } from "./rebuild.js";
import { resolveEntityAttribute } from "../perception/attributes.js";

/**
 * Phase 7 Part 2 — the People view's data: what Enso holds about each
 * person, with every value traceable to its source ("you told me this on
 * ...") via stored provenance. This is deliberately a plain read over the
 * existing projection tables (entities, entity_attributes,
 * structural_atoms, social_bonds) — no new projection state, just
 * presentation of what already exists, which is why this lives in src/
 * as a pure, testable function rather than inline in the API route.
 */
export interface ProvenancedFact {
  value: string;
  /** "you told me this on ..." — resolved from the earliest message_sent event in this fact's provenance set. Null only if no message_sent event could be resolved (shouldn't happen in practice, but never fabricated). */
  toldOn: string | null;
  sourceEventIds: string[];
}

export interface PersonView {
  entityId: string;
  name: string;
  confirmed: boolean;
  attributes: { attribute: "birthdate" | "location" | "occupation"; facts: ProvenancedFact[] }[];
  relationships: { type: string; direction: "from" | "to"; basis: string; toldOn: string | null; sourceEventIds: string[] }[];
}

function resolveToldOn(eventLog: EventLog, sourceEventIds: string[]): string | null {
  const sorted = [...sourceEventIds].sort(); // ULIDs sort lexicographically by time (EN-050)
  for (const id of sorted) {
    const event = eventLog.getById(id);
    if (event?.type === "message_sent") return event.occurredAt ?? event.recordedAt;
  }
  return null;
}

/**
 * The primary user's own stated birthdate, if any — extraction resolves
 * entityName "me" to primaryEntityId(userId) (see rebuild.ts), so this is
 * the resolved "birthdate" entity_attributes row for that synthetic id
 * (resolveEntityAttribute, R36/R37: birthdate is immutable — first valid
 * value wins, never simply the last-asserted row, which is how a stray
 * misextraction used to silently override a correct birthdate). Used by
 * EN-031/032 (zodiac sidebar, Horoscope tab). No separate onboarding flow
 * exists yet (EN-021 is out of this phase's scope) — this simply reads
 * whatever the user has stated in ordinary conversation, and returns null
 * (never a guess) until they have.
 */
export function getPrimaryUserBirthdate(projections: ProjectionsDb, userId: string): string | null {
  return resolveEntityAttribute(projections, userId, primaryEntityId(userId), "birthdate")?.value ?? null;
}

/**
 * EN-030 item A generalization: the same "does Enso already have this
 * self-fact on record" lookup as getPrimaryUserBirthdate above, but for any
 * of the three attribute types entity_attributes actually supports
 * (db.ts's CHECK constraint: 'birthdate' | 'location' | 'occupation' — the
 * only three that exist anywhere in this data model). Used by
 * circleBack.ts's self-fact candidate pool for the two of these not
 * already covered by selfBirthdateGate.ts's own one-shot mechanism.
 */
export function getPrimaryUserAttribute(projections: ProjectionsDb, userId: string, attribute: "birthdate" | "location" | "occupation"): string | null {
  return resolveEntityAttribute(projections, userId, primaryEntityId(userId), attribute)?.value ?? null;
}

export interface SelfProfileAttribute {
  attribute: "birthdate" | "location" | "occupation";
  value: string;
  /** Distinct later values that disagree with `value` (R37) — empty for a mutable attribute or when no conflict exists. Never silently dropped: Part B's whole point is surfacing this instead of hiding it. */
  conflictingValues: string[];
}

export interface SelfProfileBond {
  name: string;
  /** "friend" / "spouse" / "parent" / "mentor" / etc. — already resolved to the label from the OWNER's perspective (e.g. a parent_of atom where the owner is the child renders as "parent", not "parent_of"). */
  relationship: string;
}

export interface SelfProfile {
  attributes: SelfProfileAttribute[];
  bonds: SelfProfileBond[];
}

const SELF_PROFILE_ATTRIBUTE_ORDER = ["birthdate", "location", "occupation"] as const;

function structuralAtomRelationshipLabel(type: "parent_of" | "spouse_of" | "sibling_of", ownerIsFromSide: boolean): string {
  if (type === "spouse_of") return "spouse";
  if (type === "sibling_of") return "sibling";
  return ownerIsFromSide ? "child" : "parent"; // parent_of: fromEntityId is the parent, toEntityId is the child
}

function socialBondRelationshipLabel(type: string, ownerIsFromSide: boolean): string {
  if (type !== "mentor_of") return type;
  return ownerIsFromSide ? "mentee" : "mentor"; // mentor_of: fromEntityId is the mentor, toEntityId is the mentee
}

/**
 * Part B (R38): the always-on self-profile block's data — what Enso
 * already knows about the OWNER specifically, resolved through the same
 * shared resolver (resolveEntityAttribute, R37) every other reader uses,
 * so this can never disagree with them. This is "THE USER IS THE MOST
 * IMPORTANT ENTITY" (persona/instructions.ts) made physical: structured
 * self-knowledge existed in entity_attributes/structural_atoms/
 * social_bonds all along, but nothing in ordinary conversation ever read
 * it back — the model relied entirely on hybridSearch resurfacing raw
 * message text, which a short factual chunk like a bare date structurally
 * loses (0 on FTS, unlikely to survive the top-N fusion) once a session
 * has enough other text in it. See src/persona/systemPrompt.ts's
 * buildSelfProfileBlock for how this renders into the prompt.
 *
 * SCOPE LIMIT, deliberate: the owner's own attributes plus DIRECT bonds
 * only — never third-party entity detail, which is retrieval's job and
 * would be unbounded over a long relationship. Only OPEN bonds/atoms
 * (interval_end null) are included — a closed relationship is history,
 * not a current fact about who the owner is now; that history still lives
 * in getPeopleView above for anyone who asks about it directly.
 */
export function buildSelfProfile(projections: ProjectionsDb, userId: string): SelfProfile {
  const primary = primaryEntityId(userId);

  const attributes: SelfProfileAttribute[] = [];
  for (const attribute of SELF_PROFILE_ATTRIBUTE_ORDER) {
    const resolved = resolveEntityAttribute(projections, userId, primary, attribute);
    if (!resolved) continue;
    attributes.push({ attribute, value: resolved.value, conflictingValues: [...new Set(resolved.conflicting.map((r) => r.value))] });
  }

  const bonds: SelfProfileBond[] = [];
  for (const atom of projections.listStructuralAtoms(userId)) {
    if (atom.interval_end) continue;
    const ownerIsFromSide = atom.from_entity_id === primary;
    const ownerIsToSide = atom.to_entity_id === primary;
    if (!ownerIsFromSide && !ownerIsToSide) continue;
    const other = projections.getEntityById(ownerIsFromSide ? atom.to_entity_id : atom.from_entity_id);
    if (!other) continue;
    bonds.push({ name: other.name, relationship: structuralAtomRelationshipLabel(atom.type, ownerIsFromSide) });
  }
  for (const bond of projections.listSocialBonds(userId)) {
    if (bond.interval_end) continue;
    const ownerIsFromSide = bond.from_entity_id === primary;
    const ownerIsToSide = bond.to_entity_id === primary;
    if (!ownerIsFromSide && !ownerIsToSide) continue;
    const other = projections.getEntityById(ownerIsFromSide ? bond.to_entity_id : bond.from_entity_id);
    if (!other) continue;
    bonds.push({ name: other.name, relationship: socialBondRelationshipLabel(bond.type, ownerIsFromSide) });
  }

  return { attributes, bonds };
}

export function getPeopleView(eventLog: EventLog, projections: ProjectionsDb, userId: string): PersonView[] {
  const primary = primaryEntityId(userId);
  const entities = projections.listEntities(userId);
  const atoms = projections.listStructuralAtoms(userId);
  const bonds = projections.listSocialBonds(userId);

  return entities.map((entity) => {
    const attributeRows = projections.listEntityAttributes(userId, entity.id);
    const byAttribute = new Map<string, ProvenancedFact[]>();
    for (const row of attributeRows) {
      const sourceEventIds = JSON.parse(row.source_event_ids) as string[];
      const fact: ProvenancedFact = { value: row.value, toldOn: resolveToldOn(eventLog, sourceEventIds), sourceEventIds };
      byAttribute.set(row.attribute, [...(byAttribute.get(row.attribute) ?? []), fact]);
    }

    const relationships: PersonView["relationships"] = [];
    for (const atom of atoms) {
      if (atom.from_entity_id === entity.id && atom.to_entity_id === primary) {
        const sourceEventIds = JSON.parse(atom.source_event_ids) as string[];
        relationships.push({ type: atom.type, direction: "from", basis: atom.basis, toldOn: resolveToldOn(eventLog, sourceEventIds), sourceEventIds });
      } else if (atom.to_entity_id === entity.id && atom.from_entity_id === primary) {
        const sourceEventIds = JSON.parse(atom.source_event_ids) as string[];
        relationships.push({ type: atom.type, direction: "to", basis: atom.basis, toldOn: resolveToldOn(eventLog, sourceEventIds), sourceEventIds });
      }
    }
    for (const bond of bonds) {
      const connectsToPrimary = (bond.from_entity_id === entity.id && bond.to_entity_id === primary) || (bond.to_entity_id === entity.id && bond.from_entity_id === primary);
      if (!connectsToPrimary) continue;
      const sourceEventIds = JSON.parse(bond.source_event_ids) as string[];
      relationships.push({ type: bond.type, direction: bond.from_entity_id === entity.id ? "from" : "to", basis: bond.opened_basis, toldOn: resolveToldOn(eventLog, sourceEventIds), sourceEventIds });
    }

    return {
      entityId: entity.id,
      name: entity.name,
      confirmed: entity.confirmed === 1,
      attributes: [...byAttribute.entries()].map(([attribute, facts]) => ({ attribute: attribute as "birthdate" | "location" | "occupation", facts })),
      relationships
    };
  });
}
