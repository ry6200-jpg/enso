import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ProjectionsDb } from "../src/projections/db.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { primaryEntityId } from "../src/projections/rebuild.js";

/**
 * EN-114: proves the CHECK-constraint migration actually works against a
 * database shaped like real pre-existing data — not just a freshly created
 * one, which would never exercise the migration path at all (CREATE TABLE
 * IF NOT EXISTS already has the current schema from the moment a fresh
 * table is created). Seeds a table with the OLD three-value CHECK
 * constraint and the OLD 7-column shape (no provenance_kind/
 * matching_eligible — those land in EN-115/116), the way a real on-disk
 * projections.db predating this batch looks, then opens it through the
 * real ProjectionsDb constructor and asserts the migration ran correctly.
 */
describe("entity_attributes CHECK-constraint migration (EN-114)", () => {
  it("a pre-existing table with the old 3-value CHECK is rebuilt in place: old rows survive, a new attribute type becomes insertable", () => {
    const dbPath = freshTestDbPath(import.meta.url, "pre-migration");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE entity_attributes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL CHECK (attribute IN ('birthdate', 'location', 'occupation')),
        value TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at)
       VALUES ('pre-1', ?, ?, 'location', 'Seattle', '[]', '2026-01-01T00:00:00.000Z')`
    ).run(PRIMARY_USER_ID, entityId);
    raw.close();

    // Confirm the OLD constraint really is in effect before migration —
    // otherwise this test wouldn't be exercising anything real.
    const preCheck = new Database(dbPath);
    expect(() => preCheck.prepare(`INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at) VALUES ('x', ?, ?, 'gender', 'y', '[]', '2026-01-01T00:00:00.000Z')`).run(PRIMARY_USER_ID, entityId)).toThrow();
    preCheck.close();

    const projections = new ProjectionsDb(dbPath);

    // The pre-existing row survived the rebuild unchanged, and picked up
    // provenance_kind='stated'/matching_eligible=0 via the ADD COLUMN
    // migrations (EN-115/116) that run immediately after — correct, since
    // every row that predates those columns came from a real stated
    // assertion and no consent flow has ever existed to set the latter.
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "location");
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe("pre-1");
    expect(history[0]!.value).toBe("Seattle");
    expect(history[0]!.provenance_kind).toBe("stated");
    expect(history[0]!.matching_eligible).toBe(0);

    // A new attribute type — impossible under the old CHECK — now works.
    expect(() =>
      projections.insertEntityAttribute({
        id: "post-1",
        user_id: PRIMARY_USER_ID,
        entity_id: entityId,
        attribute: "gender",
        value: "test",
        source_event_ids: "[]",
        created_at: new Date().toISOString()
      })
    ).not.toThrow();
    expect(projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "gender")).toHaveLength(1);
  });

  it("migration is idempotent — opening an already-current database a second time is a no-op, not an error", () => {
    const dbPath = freshTestDbPath(import.meta.url, "already-current");
    new ProjectionsDb(dbPath); // first open: fresh table, already current
    expect(() => new ProjectionsDb(dbPath)).not.toThrow(); // second open: must detect "already current" and skip the rebuild
  });
});

describe("entity_attributes ADD COLUMN migrations (EN-115/116)", () => {
  it("a table with the CURRENT CHECK constraint but no provenance_kind/matching_eligible columns gets both added, existing rows backfilled correctly", () => {
    const dbPath = freshTestDbPath(import.meta.url, "post-en114-pre-en115");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE entity_attributes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL CHECK (attribute IN ('birthdate', 'location', 'occupation', 'gender', 'sexual_orientation', 'life_stage')),
        value TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at)
       VALUES ('pre-1', ?, ?, 'occupation', 'Engineer', '[]', '2026-01-01T00:00:00.000Z')`
    ).run(PRIMARY_USER_ID, entityId);
    raw.close();

    const projections = new ProjectionsDb(dbPath);
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "occupation");
    expect(history).toHaveLength(1);
    expect(history[0]!.provenance_kind).toBe("stated");
    expect(history[0]!.matching_eligible).toBe(0);
  });
});
