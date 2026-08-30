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

/**
 * Sexual_orientation deprecation batch: the detector originally checked
 * only for the vocabulary's LAST marker's presence — a real, live gap,
 * since sexual_orientation sat BEFORE life_stage (the marker) in
 * ATTRIBUTE_TYPES, so a mid-list removal never changed what that check
 * looked at and an already-EN-114-migrated production database was never
 * re-detected as stale. Widened to match the full, exact generated CHECK
 * clause text instead — these tests prove that directly, both directions.
 */
describe("entity_attributes CHECK-constraint migration: exact-clause detection (deprecation batch)", () => {
  it("a stored CHECK containing a value no longer in ATTRIBUTE_TYPES (mid-list, not the last marker) triggers a rebuild — deprecated rows dropped, everything else survives with its real column values intact", () => {
    const dbPath = freshTestDbPath(import.meta.url, "stale-mid-list-value");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    // Exactly today's real production shape: sexual_orientation still in
    // the stored CHECK, all four EN-115/116/Phase-2 columns already
    // present with REAL, non-default values on some rows — the shape
    // that would have silently lost data under the ORIGINAL copy step
    // (which only ever selected the base seven columns).
    raw.exec(`
      CREATE TABLE entity_attributes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL CHECK (attribute IN ('birthdate', 'location', 'occupation', 'gender', 'sexual_orientation', 'life_stage')),
        value TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance_kind TEXT NOT NULL DEFAULT 'stated',
        matching_eligible INTEGER NOT NULL DEFAULT 0,
        interval_start TEXT,
        interval_end TEXT
      );
    `);
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at, provenance_kind, matching_eligible, interval_start, interval_end)
       VALUES ('keep-1', ?, ?, 'location', 'Seattle', '[]', '2026-01-01T00:00:00.000Z', 'stated', 0, '1993-01-01', NULL)`
    ).run(PRIMARY_USER_ID, entityId);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at, provenance_kind, matching_eligible, interval_start, interval_end)
       VALUES ('keep-2', ?, ?, 'occupation', 'Engineer', '[]', '2026-01-01T00:00:00.000Z', 'stated', 0, NULL, '2026-06-01T00:00:00.000Z')`
    ).run(PRIMARY_USER_ID, entityId);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at, provenance_kind, matching_eligible, interval_start, interval_end)
       VALUES ('drop-1', ?, ?, 'sexual_orientation', 'gay', '[]', '2026-01-01T00:00:00.000Z', 'stated', 0, NULL, NULL)`
    ).run(PRIMARY_USER_ID, entityId);
    raw.close();

    const projections = new ProjectionsDb(dbPath);

    // The deprecated-attribute row is gone.
    expect(projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "sexual_orientation" as never)).toHaveLength(0);

    // Everything else survived, INCLUDING its non-default column values —
    // the exact thing the original seven-column-only copy would have lost.
    const location = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "location");
    expect(location).toHaveLength(1);
    expect(location[0]!.id).toBe("keep-1");
    expect(location[0]!.interval_start).toBe("1993-01-01");
    expect(location[0]!.interval_end).toBeNull();

    const occupation = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "occupation");
    expect(occupation).toHaveLength(1);
    expect(occupation[0]!.id).toBe("keep-2");
    expect(occupation[0]!.interval_end).toBe("2026-06-01T00:00:00.000Z");

    // The new, narrower constraint genuinely rejects the deprecated value now.
    expect(() =>
      projections.insertEntityAttribute({
        id: "post-1",
        user_id: PRIMARY_USER_ID,
        entity_id: entityId,
        attribute: "sexual_orientation" as never,
        value: "test",
        source_event_ids: "[]",
        created_at: new Date().toISOString()
      })
    ).toThrow();
  });

  it("a stored CHECK matching the current vocabulary EXACTLY does not trigger a rebuild — a hand-seeded table, not just ProjectionsDb's own fresh-create", () => {
    const dbPath = freshTestDbPath(import.meta.url, "already-exact-match");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE entity_attributes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL CHECK (attribute IN ('birthdate', 'location', 'occupation', 'gender', 'life_stage')),
        value TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance_kind TEXT NOT NULL DEFAULT 'stated',
        matching_eligible INTEGER NOT NULL DEFAULT 0,
        interval_start TEXT,
        interval_end TEXT
      );
    `);
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at)
       VALUES ('untouched-1', ?, ?, 'location', 'Portland', '[]', '2026-01-01T00:00:00.000Z')`
    ).run(PRIMARY_USER_ID, entityId);
    const sqlBefore = (raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_attributes'`).get() as { sql: string }).sql;
    raw.close();

    const projections = new ProjectionsDb(dbPath);

    // The row survived either way (a rebuild preserves ids too), so that
    // alone wouldn't prove non-rebuild — the real proof is that the
    // table's OWN stored SQL is byte-identical before and after: a rebuild
    // would replace it with the code's own generated CREATE TABLE text
    // (different formatting from this hand-seeded one), so exact equality
    // here is only possible if no rename/recreate/copy ever ran.
    const sqlAfter = (projections.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_attributes'`).get() as { sql: string }).sql;
    expect(sqlAfter).toBe(sqlBefore);

    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "location");
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe("untouched-1");
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

describe("entity_attributes ADD COLUMN migration (Phase 2 temporal markers)", () => {
  it("a table with no interval_start/interval_end columns gets both added; every pre-existing row reads back as OPEN, never breaking during a rebuild", () => {
    const dbPath = freshTestDbPath(import.meta.url, "pre-phase2");
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
        created_at TEXT NOT NULL,
        provenance_kind TEXT NOT NULL DEFAULT 'stated',
        matching_eligible INTEGER NOT NULL DEFAULT 0
      );
    `);
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    raw.prepare(
      `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at)
       VALUES ('pre-1', ?, ?, 'location', 'Toledo', '[]', '2026-01-01T00:00:00.000Z')`
    ).run(PRIMARY_USER_ID, entityId);
    raw.close();

    const projections = new ProjectionsDb(dbPath);
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, entityId, "location");
    expect(history).toHaveLength(1);
    expect(history[0]!.interval_start ?? null).toBeNull();
    expect(history[0]!.interval_end ?? null).toBeNull(); // NULL = open — never a breaking distinction for legacy data

    // A fresh insert with a real closed interval now works.
    projections.insertEntityAttribute({
      id: "post-1",
      user_id: PRIMARY_USER_ID,
      entity_id: entityId,
      attribute: "location",
      value: "Seattle",
      source_event_ids: "[]",
      created_at: new Date().toISOString(),
      interval_start: "2020-01-01",
      interval_end: "2022-01-01"
    });
    const updated = projections.getEntityAttributeById("post-1")!;
    expect(updated.interval_start).toBe("2020-01-01");
    expect(updated.interval_end).toBe("2022-01-01");
  });
});
