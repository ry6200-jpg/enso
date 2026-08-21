import { newId } from "../ids.js";
import type { EntityAttributeRow, ProjectionsDb } from "../projections/db.js";

/**
 * Third-party attribute persistence (EN-015): attributes stated about
 * *other people* must persist to that person's entity — R2 is the
 * regression this exists to prevent forever. Never updated in place: each
 * assertion is a new row, so "what did I used to believe her birthdate
 * was" stays answerable (EN-017's versioning philosophy applied here too).
 */
export function assertAttribute(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"],
  value: string,
  sourceEventIds: string[]
): EntityAttributeRow {
  const row: EntityAttributeRow = {
    id: newId(),
    user_id: userId,
    entity_id: entityId,
    attribute,
    value,
    source_event_ids: JSON.stringify([...new Set(sourceEventIds)].sort()),
    created_at: new Date().toISOString()
  };
  projections.insertEntityAttribute(row);
  return row;
}

/** The latest asserted value — "current" in the absence of any as-of constraint. */
export function getCurrentAttribute(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"]
): EntityAttributeRow | undefined {
  const history = projections.listEntityAttributeHistory(userId, entityId, attribute);
  return history.at(-1);
}

/**
 * The value that was current as of a given told-date — i.e. the latest
 * assertion whose perception log's told_at is on or before asOfDate. Falls
 * back to created_at ordering if no perception log exists for a row (older
 * data written before perception logging existed, or written directly in
 * tests without one).
 */
export function getAttributeAsOf(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"],
  asOfDate: string
): EntityAttributeRow | undefined {
  const history = projections.listEntityAttributeHistory(userId, entityId, attribute);
  const eligible = history.filter((row) => {
    const log = projections.getPerceptionLogForFact(row.id);
    const toldAt = log?.told_at ?? row.created_at;
    return toldAt <= asOfDate;
  });
  return eligible.at(-1);
}
