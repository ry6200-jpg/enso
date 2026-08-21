import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Cache for Enso-generated daily zodiac copy (Phase 7 Part 3) — a
 * dedicated, physically separate SQLite file (same separation principle as
 * events/projections/retrieval, EN-052), because this content has no
 * event-log basis at all: it's freshly generated writing, not derived from
 * anything the user said. `generate` only ever runs on a cache miss —
 * once a key's content is written for a given day it's fixed for that day,
 * never re-rolled on every page view.
 */
export class DailyContentCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS daily_content_cache (cache_key TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }

  async getOrGenerate(cacheKey: string, generate: () => Promise<string>): Promise<string> {
    const row = this.db.prepare(`SELECT content FROM daily_content_cache WHERE cache_key = ?`).get(cacheKey) as { content: string } | undefined;
    if (row) return row.content;

    const content = await generate();
    this.db
      .prepare(`INSERT INTO daily_content_cache (cache_key, content, created_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET content = excluded.content`)
      .run(cacheKey, content, new Date().toISOString());
    return content;
  }

  close(): void {
    this.db.close();
  }
}

/** ISO date (UTC) — the day component of every cache key, so content naturally rolls over at midnight UTC with no explicit expiry logic. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
