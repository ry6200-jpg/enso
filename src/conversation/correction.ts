import type { RecentAttributeClaim } from "./router/routerTypes.js";

/**
 * Correction gate (item 4 #2), mirroring attestation.ts's resolveAttestation
 * exactly on purpose — same shape of problem (turn a router-validated
 * decision naming an (entityName, attribute, value) triple into a real
 * event), same discipline (the router only ever names the triple; it
 * never sees or invents event ULIDs — EN-055's binding-by-ULID rule is
 * enforced here, in code, never trusted to the model). recentAttributeClaims
 * itself is NOT duplicated — attestation.ts's version already builds
 * exactly the candidate list this needs (entityName, attribute, value,
 * extractionEventId), reused directly.
 *
 * The one real difference from attestation: resolveAttestation matches on
 * (entityName, attribute, value) because it's CONFIRMING a claim the
 * model already sees verbatim. resolveCorrection matches on only
 * (entityName, attribute) because the whole point is the NEW value
 * differs from what's on record — requiring value equality here would
 * make a correction impossible to ever resolve.
 */

export interface FactCorrectedAttributePayload {
  targetEventId: string;
  entityName: string;
  attribute: "birthdate" | "location" | "occupation";
  correctedValue: string;
}

/**
 * Turns a router-validated correction decision into the fact_corrected
 * event to append. Returns null if the caller passes something that
 * doesn't resolve against a real recent claim — a defensive second check,
 * never relied upon as the only one (the router's own candidate list,
 * built from recentAttributeClaims, is the first).
 */
export function resolveCorrection(claims: RecentAttributeClaim[], entityName: string, attribute: string, correctedValue: string): FactCorrectedAttributePayload | null {
  const match = claims.find((c) => c.entityName === entityName && c.attribute === attribute);
  if (!match) return null;
  return { targetEventId: match.extractionEventId, entityName: match.entityName, attribute: match.attribute, correctedValue };
}
