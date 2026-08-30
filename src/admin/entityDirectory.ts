import type { ProjectionsDb } from "../projections/db.js";
import { primaryEntityId } from "../projections/rebuild.js";
import { resolveEntityAttribute } from "../perception/attributes.js";
import { ATTRIBUTE_TYPES, type AttributeType } from "../projections/attributeVocabulary.js";

/**
 * Admin-only entity view (part 2). Reads only the SIGNED-IN admin's own
 * database — every call here takes the admin's own userId and reads only
 * that user's rows (ProjectionsDb/EventLog are already opened per-user,
 * per-request, via the same checkout the rest of this app uses — see
 * app/api/directory/route.ts). There is no code path here or in the
 * route that accepts a target user id from the client; a cross-user
 * "view someone else's entity directory" feature would need a genuinely
 * new, separate mechanism, not an extension of this one.
 *
 * Deliberately a NEW aggregation, not a reuse of peopleView.ts's
 * getPeopleView/buildEntityDossier: those are scoped to relationships
 * WITH THE PRIMARY USER only (capped, for prompt-injection purposes).
 * This view needs the full bond CONSTELLATION — including alter-to-alter
 * bonds neither side of which is the primary user — which those two
 * functions never compute. resolveEntityAttribute (R37's shared
 * resolver) is reused as-is for attribute fill rates, same conflict
 * handling as everywhere else in this project.
 */

/** Same threshold Part 1's network markers use — a single named constant, not two independently-tuned ones, since both answer the same underlying question ("has this tie gone quiet"). */
export const DORMANCY_THRESHOLD_DAYS = 21;

export interface EntityBondView {
  otherEntityId: string;
  otherEntityName: string;
  relationshipClass: string;
  direction: "from" | "to";
  withPrimary: boolean;
}

export interface EntityDirectoryEntry {
  entityId: string;
  canonicalName: string;
  /** Every observed alias EXCEPT the canonical name itself, deduped. */
  nameVariants: string[];
  attributes: Record<AttributeType, string | null>;
  /** The full constellation this entity participates in — including bonds where neither side is the primary user. */
  bonds: EntityBondView[];
  /** This entity's own relationship class to the primary user specifically, if any — the first one found, since accretion means there can be more than one (see social_bonds' own "bonds accrete" note). */
  relationshipClassToPrimary: string | null;
  /** Role-word placeholder fix: 'role_word' for an unnamed kinship/role placeholder ("father", "older sister"), null for an ordinary named entity. Deliberately NOT excluded from this view — an admin auditing entity quality needs to see exactly these to verify the fix is working, the opposite of peopleView's dossier, which excludes them from what Enso can present as a named person (see retrievalInvocation.ts's findAllMentionedEntityIds). */
  nameKind: "role_word" | null;
  /** Role-word placeholder fix: which entity this placeholder was derived to belong to (structural_atoms/social_bonds' other, already-resolved side), or null when no owner could be determined. */
  ownerEntityId: string | null;
  mentionCount: number;
  firstMentionAt: string | null;
  lastMentionAt: string | null;
  daysSinceLastMention: number | null;
  dormant: boolean;
}

export type FillRates = Record<AttributeType, number> & { totalEntities: number };

function sourceIdsOf(entity: { source_event_ids: string }): string[] {
  return (JSON.parse(entity.source_event_ids) as string[]).slice().sort();
}

/**
 * `recordedAtByMessageId` is caller-supplied from the event log (same
 * discipline as networkMarkers.ts — never decoded from a ULID; see that
 * file's own comment on why the event's own recorded_at is the field of
 * record).
 */
export function computeEntityDirectory(projections: ProjectionsDb, userId: string, recordedAtByMessageId: Map<string, string>, nowIso: string): EntityDirectoryEntry[] {
  const primary = primaryEntityId(userId);
  const entities = projections.listEntities(userId);
  const bonds = projections.listSocialBonds(userId).filter((b) => b.interval_end === null);
  const atoms = projections.listStructuralAtoms(userId).filter((a) => a.interval_end === null);
  const now = new Date(nowIso).getTime();
  const nameById = new Map(entities.map((e) => [e.id, e.name]));

  return entities.map((entity) => {
    const aliasRows = projections.listEntityAliases(userId, entity.id);
    const nameVariants = [...new Set(aliasRows.map((a) => a.alias))].filter((alias) => alias !== entity.name);

    const attributes = Object.fromEntries(
      ATTRIBUTE_TYPES.map((attribute) => [attribute, resolveEntityAttribute(projections, userId, entity.id, attribute)?.value ?? null])
    ) as Record<AttributeType, string | null>;

    const entityBonds: EntityBondView[] = [];
    let relationshipClassToPrimary: string | null = null;
    for (const bond of bonds) {
      if (bond.from_entity_id !== entity.id && bond.to_entity_id !== entity.id) continue;
      const otherId = bond.from_entity_id === entity.id ? bond.to_entity_id : bond.from_entity_id;
      const withPrimary = otherId === primary;
      if (withPrimary && relationshipClassToPrimary === null) relationshipClassToPrimary = bond.type;
      entityBonds.push({
        otherEntityId: otherId,
        otherEntityName: withPrimary ? "(you)" : (nameById.get(otherId) ?? "unknown"),
        relationshipClass: bond.type,
        direction: bond.from_entity_id === entity.id ? "from" : "to",
        withPrimary
      });
    }
    for (const atom of atoms) {
      if (atom.from_entity_id !== entity.id && atom.to_entity_id !== entity.id) continue;
      const otherId = atom.from_entity_id === entity.id ? atom.to_entity_id : atom.from_entity_id;
      const withPrimary = otherId === primary;
      if (withPrimary && relationshipClassToPrimary === null) relationshipClassToPrimary = atom.type;
      entityBonds.push({
        otherEntityId: otherId,
        otherEntityName: withPrimary ? "(you)" : (nameById.get(otherId) ?? "unknown"),
        relationshipClass: atom.type,
        direction: atom.from_entity_id === entity.id ? "from" : "to",
        withPrimary
      });
    }

    const ids = sourceIdsOf(entity);
    const resolvedTimestamps = ids.map((id) => recordedAtByMessageId.get(id)).filter((t): t is string => t !== undefined);
    const firstMentionAt = resolvedTimestamps[0] ?? null;
    const lastMentionAt = resolvedTimestamps[resolvedTimestamps.length - 1] ?? null;
    const daysSinceLastMention = lastMentionAt ? (now - new Date(lastMentionAt).getTime()) / (24 * 60 * 60 * 1000) : null;

    return {
      entityId: entity.id,
      canonicalName: entity.name,
      nameVariants,
      attributes,
      bonds: entityBonds,
      relationshipClassToPrimary,
      nameKind: entity.name_kind ?? null,
      ownerEntityId: entity.owner_entity_id ?? null,
      mentionCount: ids.length,
      firstMentionAt,
      lastMentionAt,
      daysSinceLastMention,
      dormant: daysSinceLastMention !== null && daysSinceLastMention >= DORMANCY_THRESHOLD_DAYS
    };
  });
}

export function computeFillRates(projections: ProjectionsDb, userId: string): FillRates {
  const entities = projections.listEntities(userId);
  const total = entities.length;
  const counts = Object.fromEntries(ATTRIBUTE_TYPES.map((attribute) => [attribute, 0])) as Record<AttributeType, number>;
  for (const entity of entities) {
    for (const attribute of ATTRIBUTE_TYPES) {
      if (resolveEntityAttribute(projections, userId, entity.id, attribute) !== null) counts[attribute]++;
    }
  }
  const rates = Object.fromEntries(ATTRIBUTE_TYPES.map((attribute) => [attribute, total > 0 ? counts[attribute] / total : 0])) as Record<AttributeType, number>;
  return { ...rates, totalEntities: total };
}
