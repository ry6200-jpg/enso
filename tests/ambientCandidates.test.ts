import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { ambientLocationCandidates } from "../src/conversation/ambientCandidates.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function seedEntityWithLocation(name: string, location: string | null) {
  const entityId = newId();
  projections.insertEntity({
    id: entityId,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(["ev1"]),
    extractor_version: "message-v1",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  if (location) {
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: entityId,
      attribute: "location",
      value: location,
      source_event_ids: JSON.stringify(["ev1"]),
      created_at: new Date().toISOString()
    });
  }
  return entityId;
}

describe("ambientLocationCandidates (item 1) — the router's third-party candidate pool", () => {
  it("returns an empty list when no one on record has a location", () => {
    seedEntityWithLocation("Marcus", null);
    expect(ambientLocationCandidates(projections, PRIMARY_USER_ID)).toEqual([]);
  });

  it("includes an entity with a resolved location", () => {
    const entityId = seedEntityWithLocation("Elena", "Seattle");
    expect(ambientLocationCandidates(projections, PRIMARY_USER_ID)).toEqual([{ entityId, name: "Elena", location: "Seattle" }]);
  });

  it("excludes entities without a location, includes only those with one, in the same call", () => {
    seedEntityWithLocation("Marcus", null);
    const elenaId = seedEntityWithLocation("Elena", "Seattle");
    const candidates = ambientLocationCandidates(projections, PRIMARY_USER_ID);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.entityId).toBe(elenaId);
  });

  it("never includes the primary user's own entity — 'own situation' is a separate router field, not a candidate", () => {
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "location",
      value: "Los Angeles",
      source_event_ids: JSON.stringify(["ev1"]),
      created_at: new Date().toISOString()
    });
    expect(ambientLocationCandidates(projections, PRIMARY_USER_ID)).toEqual([]);
  });
});
