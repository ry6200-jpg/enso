import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ATTRIBUTE_TYPES, type AttributeType, type ProvenanceKind } from "./attributeVocabulary.js";

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  confirmed: 0 | 1;
  source_event_ids: string; // JSON array of event ULIDs
  extractor_version: string;
  /**
   * Ported from old Enso's entity resolution cascade (EN-012): set when a
   * name resolves via the lowest-confidence path (a fuzzy/phonetic match,
   * or a same-counterparty kinship conflict that still shares a name with
   * an existing entity) — a candidate that MIGHT be the same person as
   * `pending_disambiguation.existingEntityId`, recorded for a future
   * clarifying question. Surfacing that question is chat/persona work
   * (not built this phase); this column exists so the data survives until
   * that surface exists.
   */
  pending_disambiguation: string | null; // JSON PendingDisambiguation, or null
  created_at: string;
}

export interface EntityAliasRow {
  id: string;
  user_id: string;
  entity_id: string;
  alias: string;
  source_event_ids: string; // JSON array of event ULIDs
  created_at: string;
}

export interface StructuralAtomRow {
  id: string;
  user_id: string;
  type: "parent_of" | "spouse_of" | "sibling_of";
  from_entity_id: string;
  to_entity_id: string;
  basis: "stated" | "derived_from_parents";
  interval_start: string | null;
  interval_end: string | null;
  source_event_ids: string; // JSON array of event ULIDs
  created_at: string;
}

export interface SocialBondRow {
  id: string;
  user_id: string;
  type: "friend" | "colleague" | "mentor_of" | "neighbor" | "classmate" | "romantic";
  from_entity_id: string;
  to_entity_id: string;
  qualifier: string | null;
  opened_basis: "inferred" | "stated";
  interval_start: string | null;
  interval_end: string | null;
  source_event_ids: string; // JSON array of event ULIDs
  created_at: string;
}

/**
 * Third-party attribute persistence (EN-015). Never overwritten in place —
 * a new assertion is a new row, so history is versioned for free
 * (EN-017's philosophy extended to attributes generally); "current value"
 * queries pick the latest row for that (entity, attribute) pair.
 */
export interface EntityAttributeRow {
  id: string;
  user_id: string;
  entity_id: string;
  attribute: AttributeType;
  value: string;
  source_event_ids: string; // JSON array of event ULIDs
  created_at: string;
  /**
   * EN-115: 'stated' (the owner said it directly) or 'inferred' (Enso
   * derived it from a pattern of other evidence — nothing writes this yet;
   * see attributeVocabulary.ts). Optional on this interface — not because a
   * row read back from SQLite is ever actually missing it (the column is
   * NOT NULL DEFAULT 'stated'), but so the many existing call sites across
   * the test suite that construct a row literal before this field existed
   * keep compiling unchanged. insertEntityAttribute defaults it to
   * 'stated' when omitted — correct for every writer that exists today.
   */
  provenance_kind?: ProvenanceKind;
  /**
   * EN-116: whether this fact may be used by the future cross-user "En"
   * layer to surface a possible connection to another user. Same
   * optionality reasoning as provenance_kind above; insertEntityAttribute
   * defaults it to 0 (false) when omitted — no writer anywhere can
   * currently set it true (no consent flow exists yet).
   */
  matching_eligible?: 0 | 1;
}

/**
 * Perception logs (EN-016): dual time on every extracted fact this table
 * covers. told_at is when the user said it (the source message's own
 * recorded_at); event_at is when it happened, if determinable, so "she
 * moved last year" said in 2026 doesn't get misread as 2028 two years on.
 */
export interface PerceptionLogRow {
  id: string;
  user_id: string;
  fact_type: "entity_attribute";
  fact_ref: string; // id of the row in entity_attributes this log entry is about
  told_at: string;
  event_at: string | null;
  source_event_ids: string; // JSON array of event ULIDs
  raw_value: string;
  created_at: string;
}

/**
 * EN-037 episode clustering, Phase 8.5: one clustered incident, built from
 * `episodeMarkers` (taxonomySchema.ts's day-one taxonomy — extraction
 * schema unchanged by this feature) rather than a new extraction category
 * — see src/projections/episodes.ts's clusterEpisodeMarkers for how
 * boundary_start/incident_reference/boundary_end markers fold into these
 * rows. told_start/told_end are the dual-time span's TOLD-time boundary
 * (always known — every marker traces to a real message's recordedAt);
 * narrative_year is the EVENT-time boundary, best-effort and often null
 * (see episodes.ts's extractNarrativeYear doc comment for the honest scope
 * limit: only an explicit year stated directly in a marker's own text is
 * ever captured — never a guessed/inferred relative date).
 */
export interface EpisodeRow {
  id: string;
  user_id: string;
  title: string;
  told_start: string;
  told_end: string;
  narrative_year: string | null;
  participant_entity_ids: string; // JSON array of entity ids
  source_event_ids: string; // JSON array of event ULIDs (extraction_completed + the message_sent events it traces to)
  created_at: string;
}

/**
 * Storage for derived, disposable projection data (EN-052). This is a
 * physically separate SQLite file from the event log, deliberately — the
 * authority boundary between "system of record" and "rebuildable cache"
 * stays visible at the filesystem level, not just in code conventions.
 *
 * `entities` is Phase 1's one real projection: a minimal fold over
 * extraction output, kept only to exercise provenance + extractor_version +
 * rebuild machinery (EN-052/053). It is not entity resolution (EN-012,
 * later phases).
 */
export class ProjectionsDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        source_event_ids TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        pending_disambiguation TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);

      -- Entity resolution cascade (EN-012, ported from old Enso):
      -- every raw name/spelling that resolves to a canonical entity.
      CREATE TABLE IF NOT EXISTS entity_aliases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aliases_user_id ON entity_aliases(user_id);
      CREATE INDEX IF NOT EXISTS idx_aliases_entity_id ON entity_aliases(entity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_unique ON entity_aliases(user_id, alias COLLATE NOCASE);

      -- Class A structural atoms (EN-013): parent_of (directed) and
      -- spouse_of/sibling_of (symmetric — stored as one canonically-ordered
      -- row, queried bidirectionally). child_of is never stored. Derived
      -- relations (grandparent, cousin, in-law) are never stored here —
      -- only traversal produces them, at query time.
      CREATE TABLE IF NOT EXISTS structural_atoms (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('parent_of', 'spouse_of', 'sibling_of')),
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        basis TEXT NOT NULL CHECK (basis IN ('stated', 'derived_from_parents')),
        interval_start TEXT,
        interval_end TEXT,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_atoms_user_id ON structural_atoms(user_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_from ON structural_atoms(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_to ON structural_atoms(to_entity_id);

      -- Class B social bonds (EN-013): typed coexisting intervals, never
      -- graph edges — multiple bonds of different types may be concurrently
      -- open on the same pair (accretion, not transition). opened_basis may
      -- be 'inferred'; there is deliberately no 'inferred' option wired to
      -- any code path that sets interval_end — closing a bond always
      -- requires the caller to have stated evidence (see socialBonds.ts).
      CREATE TABLE IF NOT EXISTS social_bonds (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('friend', 'colleague', 'mentor_of', 'neighbor', 'classmate', 'romantic')),
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        qualifier TEXT,
        opened_basis TEXT NOT NULL CHECK (opened_basis IN ('inferred', 'stated')),
        interval_start TEXT,
        interval_end TEXT,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bonds_user_id ON social_bonds(user_id);
      CREATE INDEX IF NOT EXISTS idx_bonds_from ON social_bonds(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_bonds_to ON social_bonds(to_entity_id);

      -- Third-party attribute persistence (EN-015). Never updated in
      -- place — a new assertion is a new row, so history is versioned for
      -- free; "current" queries pick the latest row per (entity, attribute).
      CREATE TABLE IF NOT EXISTS entity_attributes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL CHECK (attribute IN (${ATTRIBUTE_TYPES.map((a) => `'${a}'`).join(", ")})),
        value TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance_kind TEXT NOT NULL DEFAULT 'stated',
        matching_eligible INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_attributes_user_id ON entity_attributes(user_id);
      CREATE INDEX IF NOT EXISTS idx_attributes_entity_id ON entity_attributes(entity_id);

      -- Perception logs (EN-016): dual time (told_at, event_at) on every
      -- fact this table covers.
      CREATE TABLE IF NOT EXISTS perception_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        fact_type TEXT NOT NULL CHECK (fact_type IN ('entity_attribute')),
        fact_ref TEXT NOT NULL,
        told_at TEXT NOT NULL,
        event_at TEXT,
        source_event_ids TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_perception_user_id ON perception_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_perception_fact_ref ON perception_logs(fact_ref);

      -- EN-037 episode clustering (Phase 8.5), built from the existing
      -- episodeMarkers taxonomy — see EpisodeRow's own doc comment above.
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        told_start TEXT NOT NULL,
        told_end TEXT NOT NULL,
        narrative_year TEXT,
        participant_entity_ids TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_user_id ON episodes(user_id);
    `);
    this.migrateEntityAttributesCheckConstraint();
    this.migrateEntityAttributesAddColumn("provenance_kind", `TEXT NOT NULL DEFAULT 'stated'`);
    this.migrateEntityAttributesAddColumn("matching_eligible", `INTEGER NOT NULL DEFAULT 0`);
  }

  /**
   * EN-115/116: adds one column to a pre-existing on-disk entity_attributes
   * table, idempotently. Unlike the CHECK-constraint change above (EN-114),
   * a new column with a constant DEFAULT is something SQLite's ALTER TABLE
   * supports directly — no rename/recreate/copy dance needed. Detected via
   * PRAGMA table_info rather than sqlite_master text (more precise for "does
   * this exact column exist" than substring-matching stored DDL).
   */
  private migrateEntityAttributesAddColumn(column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(entity_attributes)`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE entity_attributes ADD COLUMN ${column} ${definition}`);
  }

  /**
   * EN-114: a pre-existing on-disk entity_attributes table (real production
   * data included — this file round-trips via GCS checkout/checkin, it is
   * never rebuilt from scratch) has its OLD CHECK constraint baked into its
   * stored schema. `CREATE TABLE IF NOT EXISTS` above is a no-op against an
   * already-existing table — SQLite has no `ALTER TABLE` for changing a
   * CHECK constraint, unlike a simple new column (see the ADD COLUMN
   * migrations below, EN-115/116). Detected by checking the table's own
   * stored CREATE-TABLE SQL (sqlite_master) for the last entry in the
   * current vocabulary; if absent, the table predates this migration and is
   * rebuilt in place — SQLite's standard pattern for a CHECK-constraint
   * change: rename, recreate with the CURRENT schema, copy every row across
   * unchanged, drop the renamed original — inside one transaction so a
   * crash mid-migration can't leave both/neither table present. Idempotent:
   * a no-op on every open once the table is current (true for every fresh
   * test/dev database from the moment it's created, since CREATE TABLE
   * above already has the current CHECK).
   */
  private migrateEntityAttributesCheckConstraint(): void {
    const currentMarker = ATTRIBUTE_TYPES[ATTRIBUTE_TYPES.length - 1];
    const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_attributes'`).get() as { sql: string } | undefined;
    if (!existing || existing.sql.includes(`'${currentMarker}'`)) return;

    const rebuild = this.db.transaction(() => {
      this.db.exec(`ALTER TABLE entity_attributes RENAME TO entity_attributes_pre_en114`);
      this.db.exec(`
        CREATE TABLE entity_attributes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          attribute TEXT NOT NULL CHECK (attribute IN (${ATTRIBUTE_TYPES.map((a) => `'${a}'`).join(", ")})),
          value TEXT NOT NULL,
          source_event_ids TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      this.db.exec(`
        INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at)
        SELECT id, user_id, entity_id, attribute, value, source_event_ids, created_at FROM entity_attributes_pre_en114;
      `);
      this.db.exec(`DROP TABLE entity_attributes_pre_en114`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_attributes_user_id ON entity_attributes(user_id)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_attributes_entity_id ON entity_attributes(entity_id)`);
    });
    rebuild();
  }

  /**
   * Drops projection data ahead of a rebuild (EN-054). Deliberately does NOT
   * touch the extraction cache — the cache is not itself a projection, and
   * must survive rebuilds or EN-056's cost savings are pointless.
   */
  clearProjections(): void {
    this.db.exec(
      `DELETE FROM entities; DELETE FROM structural_atoms; DELETE FROM social_bonds; DELETE FROM entity_attributes; DELETE FROM perception_logs; DELETE FROM entity_aliases; DELETE FROM episodes;`
    );
  }

  insertEntity(row: EntityRow): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, user_id, name, confirmed, source_event_ids, extractor_version, pending_disambiguation, created_at)
         VALUES (@id, @user_id, @name, @confirmed, @source_event_ids, @extractor_version, @pending_disambiguation, @created_at)`
      )
      .run(row);
  }

  insertEntityAlias(row: EntityAliasRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_aliases (id, user_id, entity_id, alias, source_event_ids, created_at)
         VALUES (@id, @user_id, @entity_id, @alias, @source_event_ids, @created_at)`
      )
      .run(row);
  }

  findEntityIdByExactAlias(userId: string, alias: string): string | undefined {
    const row = this.db
      .prepare(`SELECT entity_id FROM entity_aliases WHERE user_id = ? AND alias = ? COLLATE NOCASE`)
      .get(userId, alias) as { entity_id: string } | undefined;
    return row?.entity_id;
  }

  listEntityAliases(userId: string, entityId?: string): EntityAliasRow[] {
    if (entityId) {
      return this.db.prepare(`SELECT * FROM entity_aliases WHERE user_id = ? AND entity_id = ?`).all(userId, entityId) as EntityAliasRow[];
    }
    return this.db.prepare(`SELECT * FROM entity_aliases WHERE user_id = ?`).all(userId) as EntityAliasRow[];
  }

  updateEntityName(id: string, name: string): void {
    this.db.prepare(`UPDATE entities SET name = ? WHERE id = ?`).run(name, id);
  }

  setEntityConfirmed(id: string): void {
    this.db.prepare(`UPDATE entities SET confirmed = 1 WHERE id = ?`).run(id);
  }

  setPendingDisambiguation(id: string, pendingJson: string | null): void {
    this.db.prepare(`UPDATE entities SET pending_disambiguation = ? WHERE id = ?`).run(pendingJson, id);
  }

  /** Unions new source event ids into an entity's provenance and updates its extractor_version, without touching name/confirmed. */
  touchEntity(id: string, newSourceEventIds: string[], extractorVersion: string): void {
    const row = this.getEntityById(id);
    if (!row) throw new Error(`No entity with id ${id}`);
    const merged = [...new Set([...(JSON.parse(row.source_event_ids) as string[]), ...newSourceEventIds])].sort();
    this.db
      .prepare(`UPDATE entities SET source_event_ids = ?, extractor_version = ? WHERE id = ?`)
      .run(JSON.stringify(merged), extractorVersion, id);
  }

  getEntityById(id: string): EntityRow | undefined {
    return this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
  }

  listEntities(userId: string): EntityRow[] {
    return this.db
      .prepare(`SELECT * FROM entities WHERE user_id = ? ORDER BY name ASC`)
      .all(userId) as EntityRow[];
  }

  insertStructuralAtom(row: StructuralAtomRow): void {
    this.db
      .prepare(
        `INSERT INTO structural_atoms (id, user_id, type, from_entity_id, to_entity_id, basis, interval_start, interval_end, source_event_ids, created_at)
         VALUES (@id, @user_id, @type, @from_entity_id, @to_entity_id, @basis, @interval_start, @interval_end, @source_event_ids, @created_at)`
      )
      .run(row);
  }

  closeStructuralAtom(id: string, intervalEnd: string, closingSourceEventId: string): void {
    const row = this.getStructuralAtomById(id);
    if (!row) throw new Error(`No structural atom with id ${id}`);
    const sourceEventIds = [...new Set([...(JSON.parse(row.source_event_ids) as string[]), closingSourceEventId])].sort();
    this.db
      .prepare(`UPDATE structural_atoms SET interval_end = ?, source_event_ids = ? WHERE id = ?`)
      .run(intervalEnd, JSON.stringify(sourceEventIds), id);
  }

  listStructuralAtoms(userId: string, type?: StructuralAtomRow["type"]): StructuralAtomRow[] {
    if (type) {
      return this.db
        .prepare(`SELECT * FROM structural_atoms WHERE user_id = ? AND type = ?`)
        .all(userId, type) as StructuralAtomRow[];
    }
    return this.db.prepare(`SELECT * FROM structural_atoms WHERE user_id = ?`).all(userId) as StructuralAtomRow[];
  }

  insertSocialBond(row: SocialBondRow): void {
    this.db
      .prepare(
        `INSERT INTO social_bonds (id, user_id, type, from_entity_id, to_entity_id, qualifier, opened_basis, interval_start, interval_end, source_event_ids, created_at)
         VALUES (@id, @user_id, @type, @from_entity_id, @to_entity_id, @qualifier, @opened_basis, @interval_start, @interval_end, @source_event_ids, @created_at)`
      )
      .run(row);
  }

  closeSocialBond(id: string, intervalEnd: string, closingSourceEventId: string): void {
    const row = this.getSocialBondById(id);
    if (!row) throw new Error(`No social bond with id ${id}`);
    const sourceEventIds = [...new Set([...(JSON.parse(row.source_event_ids) as string[]), closingSourceEventId])].sort();
    this.db
      .prepare(`UPDATE social_bonds SET interval_end = ?, source_event_ids = ? WHERE id = ?`)
      .run(intervalEnd, JSON.stringify(sourceEventIds), id);
  }

  listSocialBonds(userId: string): SocialBondRow[] {
    return this.db.prepare(`SELECT * FROM social_bonds WHERE user_id = ?`).all(userId) as SocialBondRow[];
  }

  getStructuralAtomById(id: string): StructuralAtomRow | undefined {
    return this.db.prepare(`SELECT * FROM structural_atoms WHERE id = ?`).get(id) as StructuralAtomRow | undefined;
  }

  getSocialBondById(id: string): SocialBondRow | undefined {
    return this.db.prepare(`SELECT * FROM social_bonds WHERE id = ?`).get(id) as SocialBondRow | undefined;
  }

  insertEntityAttribute(row: EntityAttributeRow): void {
    this.db
      .prepare(
        `INSERT INTO entity_attributes (id, user_id, entity_id, attribute, value, source_event_ids, created_at, provenance_kind, matching_eligible)
         VALUES (@id, @user_id, @entity_id, @attribute, @value, @source_event_ids, @created_at, @provenance_kind, @matching_eligible)`
      )
      .run({ ...row, provenance_kind: row.provenance_kind ?? "stated", matching_eligible: row.matching_eligible ?? 0 });
  }

  /**
   * Item 4 #2: removes one entity_attributes row by id — used ONLY when
   * rebuild.ts applies a fact_corrected attribute-value correction,
   * replacing the corrected-away row with a freshly write-time-validated
   * one (assertAttribute). Safe against the "never edited in place"
   * architecture invariant: that rule binds the EVENT LOG, which this
   * never touches — entity_attributes is a derived projection, fully
   * cleared and rebuilt from the event log on every rebuildProjections
   * call (see clearProjections), so removing a row here just means "this
   * rebuild pass decided not to keep it," never a mutation of history.
   */
  deleteEntityAttribute(id: string): void {
    this.db.prepare(`DELETE FROM entity_attributes WHERE id = ?`).run(id);
  }

  /** All versions, oldest first (created_at ascending — ULID ids sort the same way). */
  listEntityAttributeHistory(userId: string, entityId: string, attribute: EntityAttributeRow["attribute"]): EntityAttributeRow[] {
    return this.db
      .prepare(`SELECT * FROM entity_attributes WHERE user_id = ? AND entity_id = ? AND attribute = ? ORDER BY id ASC`)
      .all(userId, entityId, attribute) as EntityAttributeRow[];
  }

  listEntityAttributes(userId: string, entityId: string): EntityAttributeRow[] {
    return this.db
      .prepare(`SELECT * FROM entity_attributes WHERE user_id = ? AND entity_id = ? ORDER BY id ASC`)
      .all(userId, entityId) as EntityAttributeRow[];
  }

  /**
   * EN-065 deletion-impact scoping: every attribute row for a user,
   * regardless of entity — unlike listEntityAttributes above, this also
   * catches rows on the primary user's own synthetic entity id
   * (`primary:<userId>`, see rebuild.ts's primaryEntityId), which is never
   * a row in the `entities` table and so wouldn't be found by iterating
   * listEntities.
   */
  listAllEntityAttributes(userId: string): EntityAttributeRow[] {
    return this.db.prepare(`SELECT * FROM entity_attributes WHERE user_id = ? ORDER BY id ASC`).all(userId) as EntityAttributeRow[];
  }

  insertPerceptionLog(row: PerceptionLogRow): void {
    this.db
      .prepare(
        `INSERT INTO perception_logs (id, user_id, fact_type, fact_ref, told_at, event_at, source_event_ids, raw_value, created_at)
         VALUES (@id, @user_id, @fact_type, @fact_ref, @told_at, @event_at, @source_event_ids, @raw_value, @created_at)`
      )
      .run(row);
  }

  getPerceptionLogForFact(factRef: string): PerceptionLogRow | undefined {
    return this.db.prepare(`SELECT * FROM perception_logs WHERE fact_ref = ?`).get(factRef) as PerceptionLogRow | undefined;
  }

  insertEpisode(row: EpisodeRow): void {
    this.db
      .prepare(
        `INSERT INTO episodes (id, user_id, title, told_start, told_end, narrative_year, participant_entity_ids, source_event_ids, created_at)
         VALUES (@id, @user_id, @title, @told_start, @told_end, @narrative_year, @participant_entity_ids, @source_event_ids, @created_at)`
      )
      .run(row);
  }

  getEpisodeById(id: string): EpisodeRow | undefined {
    return this.db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as EpisodeRow | undefined;
  }

  /**
   * Chronological by the episode's real NARRATIVE date (narrative_year),
   * never by insertion/created_at — the requirement this exists for. A
   * dated row (narrative_year IS NOT NULL, sorts first per the boolean
   * ASC trick below) orders among other dated rows by that year; an
   * undated row has no real chronological anchor at all, so it sorts
   * after every dated row, ordered internally by told_start (the best
   * available fallback — when it was TALKED about, never when the SQLite
   * row happened to be written).
   */
  listEpisodesByNarrativeOrder(userId: string): EpisodeRow[] {
    return this.db
      .prepare(`SELECT * FROM episodes WHERE user_id = ? ORDER BY (narrative_year IS NULL) ASC, narrative_year ASC, told_start ASC`)
      .all(userId) as EpisodeRow[];
  }

  close(): void {
    this.db.close();
  }
}
