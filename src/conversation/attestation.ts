import type { EventLog } from "../events/eventLog.js";
import type { ProjectionsDb } from "../projections/db.js";
import type { RecentAttributeClaim } from "./router/routerTypes.js";

/**
 * Attestation gate (EN-066), folded into the intent router's single call
 * rather than a fourth separate one (EN-075). This module supplies the
 * router's candidate list of claims it's allowed to confirm, and resolves
 * a validated affirmation back into a concrete fact_confirmed event — the
 * router only ever names an (entityName, attribute, value) triple it was
 * handed; it never sees or invents event ULIDs (EN-055's binding-by-ULID
 * rule is enforced here, in code, not trusted to the model).
 */

const RECENT_CLAIMS_LIMIT = 5;

/** The N most recent attribute assertions across this user's entities — bounded, cheap, no attempt to model "what's currently in the retrieved-memory block" (that's the router's own context window, passed separately). */
export function recentAttributeClaims(eventLog: EventLog, projections: ProjectionsDb, userId: string): RecentAttributeClaim[] {
  const entities = projections.listEntities(userId);
  const allClaims: (RecentAttributeClaim & { attributeRowId: string })[] = [];

  for (const entity of entities) {
    for (const row of projections.listEntityAttributes(userId, entity.id)) {
      const sourceIds = (JSON.parse(row.source_event_ids) as string[]).slice().sort();
      const extractionEventId = sourceIds.find((id) => eventLog.getById(id)?.type === "extraction_completed");
      if (!extractionEventId) continue; // no extraction provenance to bind a confirmation to — skip rather than guess
      allClaims.push({
        entityName: entity.name,
        attribute: row.attribute,
        value: row.value,
        extractionEventId,
        attributeRowId: row.id
      });
    }
  }

  // Most recent by attribute-row id (ULIDs sort by time — EN-050).
  allClaims.sort((a, b) => (a.attributeRowId < b.attributeRowId ? 1 : -1));
  return allClaims.slice(0, RECENT_CLAIMS_LIMIT).map(({ entityName, attribute, value, extractionEventId }) => ({ entityName, attribute, value, extractionEventId }));
}

export interface FactConfirmedPayload {
  targetEventId: string;
  entityName: string;
  attribute: "birthdate" | "location" | "occupation";
  value: string;
}

/**
 * Turns a router-validated attestation decision (already checked against
 * recentAttributeClaims by intentRouter.ts's validateDecision — this
 * function trusts that validation happened) into the event to append.
 * Returns null if the caller passes something that doesn't resolve — a
 * defensive second check, never relied upon as the only one.
 */
export function resolveAttestation(claims: RecentAttributeClaim[], entityName: string, attribute: string, value: string): FactConfirmedPayload | null {
  const match = claims.find((c) => c.entityName === entityName && c.attribute === attribute && c.value === value);
  if (!match) return null;
  return { targetEventId: match.extractionEventId, entityName: match.entityName, attribute: match.attribute, value: match.value };
}
