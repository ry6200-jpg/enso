import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { contentHash } from "./contentHash.js";
import type { ExtractionStructure } from "./types.js";

export interface CacheKey {
  contentHash: string;
  extractorVersion: string;
  modelId: string;
}

interface CacheRow {
  output: string;
}

/**
 * Extraction cache (EN-056), keyed on (content hash, extractor_version,
 * model id). This is deliberately its own SQLite file, separate from both
 * the event log and the projections file: it is not itself a projection
 * (rebuild's "drop all projections" must never touch it — the whole point
 * is that it survives rebuilds) and it is not the system of record either.
 */
export class ExtractionCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_cache (
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        model_id TEXT NOT NULL,
        output TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (content_hash, extractor_version, model_id)
      );
    `);
  }

  // Generic over the cached payload shape: storage is just JSON in a text
  // column, keyed on (content hash, extractor_version, model id) regardless
  // of which extractor produced it — the stub's ExtractionStructure (Phase
  // 1) and a real provider's richer taxonomy (Phase 2) are both just JSON to
  // this table. Defaults to ExtractionStructure so every existing call site
  // keeps inferring the same type without changes.
  get<T = ExtractionStructure>(key: CacheKey): T | undefined {
    const row = this.db
      .prepare(
        `SELECT output FROM extraction_cache WHERE content_hash = ? AND extractor_version = ? AND model_id = ?`
      )
      .get(key.contentHash, key.extractorVersion, key.modelId) as CacheRow | undefined;
    return row ? (JSON.parse(row.output) as T) : undefined;
  }

  put<T = ExtractionStructure>(key: CacheKey, output: T): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO extraction_cache (content_hash, extractor_version, model_id, output, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key.contentHash, key.extractorVersion, key.modelId, JSON.stringify(output), new Date().toISOString());
  }

  size(): number {
    return (this.db.prepare(`SELECT COUNT(*) as n FROM extraction_cache`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

export interface CachedExtractorStats {
  hits: number;
  misses: number;
}

/**
 * Wraps a raw extractor (stub today, a real one later) with the cache.
 * Replay re-runs extraction only for cache misses (EN-056) — this is what
 * makes rebuild (EN-054) cheap to run routinely instead of "scary."
 */
export function createCachedExtractor(
  cache: ExtractionCache,
  extractorVersion: string,
  modelId: string,
  rawExtract: (text: string) => ExtractionStructure
): { extract: (text: string) => ExtractionStructure; stats: CachedExtractorStats } {
  const stats: CachedExtractorStats = { hits: 0, misses: 0 };

  function extract(text: string): ExtractionStructure {
    const key: CacheKey = { contentHash: contentHash(text), extractorVersion, modelId };
    const cached = cache.get(key);
    if (cached) {
      stats.hits++;
      return cached;
    }
    stats.misses++;
    const result = rawExtract(text);
    cache.put(key, result);
    return result;
  }

  return { extract, stats };
}
