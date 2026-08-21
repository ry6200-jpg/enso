import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  confirmed: 0 | 1;
  source_event_ids: string; // JSON array of event ULIDs
  extractor_version: string;
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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
    `);
  }

  /**
   * Drops projection data ahead of a rebuild (EN-054). Deliberately does NOT
   * touch the extraction cache — the cache is not itself a projection, and
   * must survive rebuilds or EN-056's cost savings are pointless.
   */
  clearProjections(): void {
    this.db.exec(`DELETE FROM entities;`);
  }

  insertEntity(row: EntityRow): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, user_id, name, confirmed, source_event_ids, extractor_version, created_at)
         VALUES (@id, @user_id, @name, @confirmed, @source_event_ids, @extractor_version, @created_at)`
      )
      .run(row);
  }

  listEntities(userId: string): EntityRow[] {
    return this.db
      .prepare(`SELECT * FROM entities WHERE user_id = ? ORDER BY name ASC`)
      .all(userId) as EntityRow[];
  }

  close(): void {
    this.db.close();
  }
}
