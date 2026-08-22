import { newId } from "../ids.js";
import type { EntityAttributeRow, ProjectionsDb } from "../projections/db.js";
import { parseIsoDate } from "../zodiac/zodiac.js";

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

/**
 * R36/R37 (regression ledger): whether a later, DIFFERENT assertion for an
 * attribute is a legitimate update or evidence of an extraction error is a
 * property of the attribute itself, not of who it's about. A birthdate
 * cannot legitimately change for anyone, self or third party — a live bug
 * found a bare "1983" (answering "what year did you turn 13?") extracted
 * as a second `birthdate` for the primary user, and because every prior
 * reader took "the last row" as current, it silently overrode a correct
 * "1970-04-24" with no signal anything had gone wrong. location and
 * occupation genuinely do change over time and keep "latest wins."
 *
 * A plain data map, not a schema change: entity_attributes' CHECK
 * constraint (db.ts) still lists exactly these three types, so adding a
 * fourth attribute later means adding one line here too.
 */
export type AttributeMutability = "immutable" | "mutable";

export const ATTRIBUTE_MUTABILITY: Record<EntityAttributeRow["attribute"], AttributeMutability> = {
  birthdate: "immutable",
  location: "mutable",
  occupation: "mutable"
};

/** Format validation, birthdate only — location/occupation are free text with no fixed shape. Reuses zodiac.ts's parseIsoDate rather than a second date parser. */
function isValidAttributeValue(attribute: EntityAttributeRow["attribute"], value: string): boolean {
  if (attribute === "birthdate") return parseIsoDate(value) !== null;
  return true;
}

export interface ResolvedAttribute {
  value: string;
  /** The row resolveAttribute picked as current. */
  row: EntityAttributeRow;
  /**
   * Other rows asserting a DIFFERENT value than the resolved one, oldest
   * first. Always empty for a mutable attribute (a later value there is a
   * real update, not a conflict). Never discarded for an immutable one,
   * valid-format or not — Part B's self-profile block surfaces these so
   * Enso can ask the owner which is right, instead of silently picking one
   * the way every reader did before this fix.
   */
  conflicting: EntityAttributeRow[];
}

/**
 * The ONE place "the current value of an attribute" is decided — every
 * reader (peopleView's getPrimaryUserBirthdate/getPrimaryUserAttribute,
 * getCurrentAttribute below, the zodiac-sidebar route, selfBirthdateGate,
 * circleBack's self-fact candidates, and Part B's self-profile block) goes
 * through this, never a locally re-derived "take the last row," so they
 * can never disagree — same discipline as
 * src/attachments/uploadDeletion.ts's computeEclipsedEventIds.
 *
 * Pure over already-fetched history (ProjectionsDb.listEntityAttributeHistory
 * / listEntityAttributes both return `ORDER BY id ASC`, i.e. oldest-first —
 * required here, not just convenient, since "first valid value wins" for an
 * immutable attribute depends on that ordering).
 */
export function resolveAttribute(history: EntityAttributeRow[]): ResolvedAttribute | null {
  if (history.length === 0) return null;
  const attribute = history[0]!.attribute;
  const valid = history.filter((row) => isValidAttributeValue(attribute, row.value));
  if (valid.length === 0) return null;

  const resolvedRow = ATTRIBUTE_MUTABILITY[attribute] === "mutable" ? valid[valid.length - 1]! : valid[0]!;
  const conflicting = ATTRIBUTE_MUTABILITY[attribute] === "immutable" ? history.filter((row) => row.id !== resolvedRow.id && row.value !== resolvedRow.value) : [];

  return { value: resolvedRow.value, row: resolvedRow, conflicting };
}

/** Convenience wrapper: fetches the (entity, attribute) history and resolves it in one call. */
export function resolveEntityAttribute(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"]
): ResolvedAttribute | null {
  return resolveAttribute(projections.listEntityAttributeHistory(userId, entityId, attribute));
}

/** The current value — mutability-aware (see resolveAttribute above). Kept as its own name/shape since existing callers want just the row, not conflict info. */
export function getCurrentAttribute(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"]
): EntityAttributeRow | undefined {
  return resolveEntityAttribute(projections, userId, entityId, attribute)?.row;
}

/**
 * The value that was current as of a given told-date — i.e. the latest
 * assertion whose perception log's told_at is on or before asOfDate. Falls
 * back to created_at ordering if no perception log exists for a row (older
 * data written before perception logging existed, or written directly in
 * tests without one).
 *
 * Not yet wired to any caller (built ahead of the reprocess-diff work it's
 * for) and NOT mutability-aware like resolveAttribute above — still plain
 * "latest wins as of a date." Left alone deliberately: with no real caller
 * today there is no live disagreement risk, and this function's own
 * "as of a past date" semantics may not map cleanly onto "first valid value
 * wins" once it does get used. Revisit before wiring this up for real.
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
