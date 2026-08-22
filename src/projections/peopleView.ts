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
