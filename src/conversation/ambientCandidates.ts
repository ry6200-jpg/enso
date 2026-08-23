import type { ProjectionsDb } from "../projections/db.js";
import { primaryEntityId } from "../projections/rebuild.js";
import { resolveEntityAttribute } from "../perception/attributes.js";

/**
 * Ambient context batch, item 1: the candidate pool of THIRD PARTIES the
 * router may pick for weather/local-time context (case b: "stated because
 * they can't know it" — the owner's mother's weather, say). Same
 * discipline as attestation.ts's recentAttributeClaims and circleBack.ts's
 * own candidate lists: the router only ever picks an entityId FROM this
 * list, validated against it after the call returns — it can never invent
 * one. The primary user's own entity is deliberately excluded here; "own
 * situation" is a separate, unconditional boolean in the router's
 * decision (RouterDecision.ambientContext.ownSituation), not a candidate
 * to select from this pool.
 */
export interface AmbientLocationCandidate {
  entityId: string;
  name: string;
  /** The resolved location value as stored (e.g. "Taman Mutiara Rini") — geocoded fresh, per turn, by the caller; never itself a coordinate and never persisted here. */
  location: string;
}

export function ambientLocationCandidates(projections: ProjectionsDb, userId: string): AmbientLocationCandidate[] {
  const primary = primaryEntityId(userId);
  const candidates: AmbientLocationCandidate[] = [];
  for (const entity of projections.listEntities(userId)) {
    if (entity.id === primary) continue;
    const resolved = resolveEntityAttribute(projections, userId, entity.id, "location");
    if (resolved) candidates.push({ entityId: entity.id, name: entity.name, location: resolved.value });
  }
  return candidates;
}
