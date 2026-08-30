/**
 * Single source of truth for the entity_attributes vocabulary (EN-113).
 * Before this file existed, "birthdate" | "location" | "occupation" was
 * hand-copied across roughly a dozen sites — db.ts's CHECK constraint,
 * nine separate TypeScript union re-declarations, three independent JSON
 * Schema enum copies (two of them live-API-enforced), a mutability map, a
 * runtime plausibility check, and an admin UI panel — with nothing
 * generated from a single definition. Every past addition required
 * editing all of them by hand, which is why this schema stalled on seven
 * separately stated requirements (EN-101) before this got fixed. Adding
 * attribute type N+1 now requires editing ONLY ATTRIBUTE_TYPES below (plus
 * a mutability decision in perception/attributes.ts's ATTRIBUTE_MUTABILITY
 * — mutable-vs-immutable is a genuine per-attribute judgment call, never
 * safe to infer automatically, so it deliberately stays a second,
 * separate, compiler-enforced step rather than being folded in here).
 *
 * Deliberately its own file with zero imports of its own. providers/types.ts
 * is a pure, dependency-free type file by design ("No provider-specific
 * types leak out of the adapter layer" — its own header comment), and
 * projections/db.ts / perception/attributes.ts / providers/types.ts would
 * otherwise risk an import cycle if this vocabulary lived inside any one
 * of them and the others imported it from there.
 *
 * NOT every site that mentions attribute names should import this array.
 * Several sites deliberately expose only a CURATED SUBSET as a matter of
 * product scope, not vocabulary fan-out — e.g. circleBack.ts's
 * SELF_FACT_ATTRIBUTES (proactive curiosity-asking, "location"|"occupation"
 * only), routerTypes.ts's CuriosityAskCandidate "selfFact" branch and
 * RouterDecision.curiosityTurn.attribute (same reason), and peopleView.ts's
 * SELF_PROFILE_ATTRIBUTE_ORDER (what's injected into the live persona
 * system prompt every turn). Deriving those from the full vocabulary would
 * silently start asking about / injecting gender, sexual_orientation, and
 * life_stage into live conversation with no product/wording decision ever
 * made about it — exactly the kind of behavior change this schema-and-
 * plumbing batch is not authorized to make. Those sites keep their own
 * explicit, hand-curated lists on purpose; only sites that legitimately
 * mean "the full current vocabulary" (storage, validation, attestation/
 * correction of anything already on record, admin/UI enumeration) import
 * from here.
 */
export const ATTRIBUTE_TYPES = ["birthdate", "location", "occupation", "gender", "sexual_orientation", "life_stage"] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export function isAttributeType(value: string): value is AttributeType {
  return (ATTRIBUTE_TYPES as readonly string[]).includes(value);
}

/**
 * Provenance kind (EN-114): whether an entity_attributes row came from the
 * owner directly stating it, or was inferred by Enso from a pattern of
 * other evidence. First real writer of 'inferred' is the gender-derivation
 * hook in rebuild.ts (role-word disambiguation batch) — this column and
 * the residence-inference note in the spec both predate it; this exists so
 * that and any future inference work has a column and resolution behavior
 * to write into, without a second schema-touching pass later.
 */
export const PROVENANCE_KINDS = ["stated", "inferred"] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export function isProvenanceKind(value: string): value is ProvenanceKind {
  return (PROVENANCE_KINDS as readonly string[]).includes(value);
}

/**
 * Gender value vocabulary (role-word disambiguation batch). Deliberately
 * minimal — "male" | "female" only, exactly what the named use (resolving
 * which of an owner's two parents a bare role word like "father" refers
 * to) needs, no wider. App-level validation only (perception/attributes.ts's
 * isValidAttributeValue), never a DB CHECK constraint on entity_attributes.
 * value — matching the existing precedent for birthdate/location/
 * occupation, none of which are CHECK-constrained on value either, and
 * keeping any future widening a plain array edit rather than the
 * rebuild-in-place CHECK-constraint migration EN-114's own precedent
 * required (see CLAUDE.md's migration-discipline note). sexual_orientation
 * deliberately has NO defined vocabulary and no derivation of any kind —
 * abandoned after the schema-decision investigation found the inferable
 * signals (spouse-gender pairing, pronoun resolution) too false-positive-
 * prone and resting on an extraction-schema gap (bare pronouns aren't
 * captured at all); it stays free text, stated-only, exactly as it always
 * was.
 */
export const GENDER_VALUES = ["male", "female"] as const;

export type GenderValue = (typeof GENDER_VALUES)[number];

export function isGenderValue(value: string): value is GenderValue {
  return (GENDER_VALUES as readonly string[]).includes(value);
}
