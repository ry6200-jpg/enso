import { newId } from "../ids.js";
import type { EntityAttributeRow, ProjectionsDb } from "../projections/db.js";
import type { AttributeType, ProvenanceKind } from "../projections/attributeVocabulary.js";
import { MONTH_NAMES, parseIsoDate } from "../zodiac/zodiac.js";

/**
 * TWO DELIBERATELY DIFFERENT TIERS — ambient/register/zodiac batch, item
 * 5(b), read this before touching either isValidAttributeValue or
 * isPlausibleWriteTimeValue below. They answer two different questions
 * and must NEVER be collapsed into one check:
 *
 *   - isValidAttributeValue (READ-TIME): "is this the attribute's CURRENT
 *     value?" — strict, unchanged. resolveAttribute uses this to decide
 *     what's authoritative and what merely CONFLICTS with it.
 *   - isPlausibleWriteTimeValue (WRITE-TIME, below): "is this even worth
 *     recording as a candidate at all?" — deliberately looser for
 *     birthdate specifically. A real, deliberately-tested design decision
 *     (tests/attributeResolution.test.ts's R36/R37 replay) keeps an
 *     implausible-but-DATE-SHAPED birthdate (a bare year like "1983",
 *     really misextracted answering "what year did you turn 13?") written
 *     to storage precisely so resolveAttribute's `conflicting` field can
 *     surface it — Enso or the owner can then see the discrepancy and
 *     resolve it, instead of that evidence being silently discarded.
 *     Only a value that isn't even ATTEMPTING to be a date — contains a
 *     word that isn't a month name, the real, live, confirmed failure was
 *     "Richard" landing as a birthdate — gets rejected at write time.
 *     location/occupation have no such conflict-surfacing benefit (see
 *     ATTRIBUTE_MUTABILITY below: only an IMMUTABLE attribute's
 *     `conflicting` field is ever populated) — an invalid value there is
 *     pure clutter with nothing to preserve, so write-time rejection for
 *     those two stays exactly as strict as read-time, no loosening at all.
 */

/**
 * Third-party attribute persistence (EN-015): attributes stated about
 * *other people* must persist to that person's entity — R2 is the
 * regression this exists to prevent forever. Never updated in place: each
 * assertion is a new row, so "what did I used to believe her birthdate
 * was" stays answerable (EN-017's versioning philosophy applied here too).
 *
 * WRITE-TIME validation (item 5b), not just read-time. Real production
 * evidence showed the extractor can bind a reply to whatever question was
 * pending rather than to what the reply actually says — a name landing as
 * a "birthdate" value, a date landing as an "occupation" value. A prompt
 * guard is probabilistic (extensively verified against real API calls
 * this same investigation — even a narrow, carefully-tuned one only
 * partially holds); this check is structural: it doesn't matter WHY the
 * extractor got it wrong, only THAT the resulting value doesn't even
 * plausibly fit the claimed attribute's shape. A rejected value is never
 * written at all, and the rejection is logged loudly (not a silent skip)
 * so corruption is visible in the moment, not discovered weeks later by
 * inspecting the database directly.
 */
/**
 * provenanceKind (EN-115) defaults to 'stated' — every call site in this
 * codebase today extracts from something the owner actually said, so
 * 'stated' is correct with no caller changes needed. A future
 * inference-writer (e.g. residence inference, blocked on this column
 * existing — see enso-rebuild-requirements.md's "Residence inference"
 * note) passes 'inferred' explicitly.
 */
export function assertAttribute(
  projections: ProjectionsDb,
  userId: string,
  entityId: string,
  attribute: EntityAttributeRow["attribute"],
  value: string,
  sourceEventIds: string[],
  provenanceKind: ProvenanceKind = "stated"
): EntityAttributeRow | null {
  if (!isPlausibleWriteTimeValue(attribute, value)) {
    // eslint-disable-next-line no-console
    console.error(
      `assertAttribute: rejected implausible ${attribute} value ${JSON.stringify(value)} for entity ${entityId} (user ${userId}) — never written to entity_attributes. Source events: ${JSON.stringify(sourceEventIds)}.`
    );
    return null;
  }
  const row: EntityAttributeRow = {
    id: newId(),
    user_id: userId,
    entity_id: entityId,
    attribute,
    value,
    source_event_ids: JSON.stringify([...new Set(sourceEventIds)].sort()),
    created_at: new Date().toISOString(),
    provenance_kind: provenanceKind,
    // EN-116: always 0 — no caller of assertAttribute (the only real
    // application-level writer) can currently set this true. No UI, no
    // consent flow exists yet; that's a separate, later decision.
    matching_eligible: 0
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
 * A plain data map, kept in sync with the vocabulary by the compiler, not
 * by hand: it's typed as Record<AttributeType, ...>, so TypeScript itself
 * fails to build if attributeVocabulary.ts's ATTRIBUTE_TYPES gains a value
 * with no corresponding mutability decision made here — one of the two
 * places (this map, and ATTRIBUTE_TYPES itself) that genuinely must be
 * touched to add an attribute; see attributeVocabulary.ts's own header
 * comment for why mutability is deliberately not folded into that array.
 */
export type AttributeMutability = "immutable" | "mutable";

export const ATTRIBUTE_MUTABILITY: Record<AttributeType, AttributeMutability> = {
  birthdate: "immutable",
  location: "mutable",
  occupation: "mutable",
  // gender/sexual_orientation/life_stage (EN-114): deliberately mutable,
  // NOT birthdate's immutable model — a later clarification is an update,
  // not a conflict to surface. The immutable model has already failed
  // once in production (a corrupted birthdate row it structurally cannot
  // repair); these three don't get the same trap.
  gender: "mutable",
  sexual_orientation: "mutable",
  life_stage: "mutable"
};

/**
 * READ-TIME tier. Exported (was private) so resolveAttribute's read-time
 * filter below and isPlausibleWriteTimeValue's own strict path (for
 * location/occupation, and as the always-accept fast path for birthdate)
 * both call the exact same check — one definition of "a genuinely valid,
 * resolvable value," never two that could drift apart. This is STRICTER
 * than write-time for birthdate specifically — see the two-tier comment
 * at the top of this file for why they must stay different.
 *
 * birthdate must actually parse as a date (zodiac.ts's parseIsoDate,
 * reused rather than a second date parser). location/occupation are free
 * text with no fixed shape of their own, but a real place or job title is
 * never JUST a bare date — the confirmed live failure was a date-shaped
 * value ("4/24/1970") landing as an occupation purely because that's what
 * the preceding question asked about. Reusing parseIsoDate's own
 * detector, inverted, catches this the same structural way regardless of
 * which attribute the misbinding lands on, without hand-writing a second
 * pattern that could disagree with what "date-shaped" already means here.
 */
export function isValidAttributeValue(attribute: EntityAttributeRow["attribute"], value: string): boolean {
  if (attribute === "birthdate") return parseIsoDate(value) !== null;
  return parseIsoDate(value) === null;
}

/**
 * WRITE-TIME tier — see the two-tier comment at the top of this file.
 * location/occupation: no conflict-surfacing benefit exists for a mutable
 * attribute (ATTRIBUTE_MUTABILITY above — only an immutable attribute's
 * `conflicting` field is ever populated), so write-time rejection here is
 * exactly as strict as read-time; nothing worth preserving is lost.
 *
 * birthdate: a fully valid date always passes, obviously. Otherwise,
 * reject ONLY when the value contains a word that isn't a recognized
 * month name — i.e., isn't even attempting to look like a date. A bare
 * number ("1983") has no such word and passes, so it's still written and
 * can surface as a conflict via resolveAttribute, per R36/R37's
 * deliberate, tested design (tests/attributeResolution.test.ts) — do not
 * change this test's expectations to make this function stricter.
 * "Richard" — the real, live, confirmed failure — has one, and is
 * rejected.
 */
function isPlausibleWriteTimeValue(attribute: EntityAttributeRow["attribute"], value: string): boolean {
  if (attribute !== "birthdate") return isValidAttributeValue(attribute, value);
  if (isValidAttributeValue("birthdate", value)) return true;
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.every((word) => word in MONTH_NAMES);
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

  // EN-115: provenance decides which SUBSET of history is even eligible to
  // resolve or conflict. A stated value always wins over an inferred one
  // for the same (entity, attribute): inferred rows are excluded entirely
  // from resolution whenever ANY stated row exists, so an inferred value
  // disagreeing with a stated one is never even compared, let alone
  // surfaced as a conflict — it's silently superseded. Falls back to
  // inferred-only resolution only when no stated row exists at all (today:
  // never, since nothing writes 'inferred' yet — every row defaults to
  // 'stated', so eligibleHistory === history for all real data right now).
  const statedHistory = history.filter((row) => (row.provenance_kind ?? "stated") === "stated");
  const eligibleHistory = statedHistory.length > 0 ? statedHistory : history.filter((row) => row.provenance_kind === "inferred");
  if (eligibleHistory.length === 0) return null;

  const valid = eligibleHistory.filter((row) => isValidAttributeValue(attribute, row.value));
  if (valid.length === 0) return null;

  const resolvedRow = ATTRIBUTE_MUTABILITY[attribute] === "mutable" ? valid[valid.length - 1]! : valid[0]!;
  const conflicting = ATTRIBUTE_MUTABILITY[attribute] === "immutable" ? eligibleHistory.filter((row) => row.id !== resolvedRow.id && row.value !== resolvedRow.value) : [];

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
