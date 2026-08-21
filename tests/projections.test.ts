import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

describe("ProjectionsDb (EN-052/053)", () => {
  it("stores provenance (source event ids) and extractor_version on every row", () => {
    projections.insertEntity({
      id: "01ENTITY0000000000000000",
      user_id: PRIMARY_USER_ID,
      name: "Sarah",
      confirmed: 0,
      source_event_ids: JSON.stringify(["01MSG0000000000000000000"]),
      extractor_version: "stub-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });

    const rows = projections.listEntities(PRIMARY_USER_ID);
    const row = rows[0]!;
    expect(rows).toHaveLength(1);
    expect(row.name).toBe("Sarah");
    expect(JSON.parse(row.source_event_ids)).toEqual(["01MSG0000000000000000000"]);
    expect(row.extractor_version).toBe("stub-v1");
  });

  it("clearProjections drops all entity rows", () => {
    projections.insertEntity({
      id: "01ENTITY0000000000000001",
      user_id: PRIMARY_USER_ID,
      name: "Sarah",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "stub-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    expect(projections.listEntities(PRIMARY_USER_ID)).toHaveLength(1);

    projections.clearProjections();
    expect(projections.listEntities(PRIMARY_USER_ID)).toHaveLength(0);
  });

  it("scopes listEntities to the given user_id", () => {
    projections.insertEntity({
      id: "01ENTITY0000000000000002",
      user_id: PRIMARY_USER_ID,
      name: "Sarah",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "stub-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projections.insertEntity({
      id: "01ENTITY0000000000000003",
      user_id: "someone-else",
      name: "Other",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "stub-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    expect(projections.listEntities(PRIMARY_USER_ID)).toHaveLength(1);
  });
});
