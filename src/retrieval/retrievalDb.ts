import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIMENSIONS } from "../embeddings/embedder.js";

/**
 * Retrieval indexes (EN-035/062): FTS5 + a local vector index, physically
 * separate from both the event log and the core projections file (EN-052's
 * separation principle applied again — this is derived, disposable data,
 * rebuildable from the log like everything else).
 *
 * content_chunks is the provenance-carrying row per indexed chunk (EN-053):
 * every chunk traces back to the event(s) it came from. content_fts and
 * content_vec are the two search indexes over the same chunks — id is a
 * proper ULID (EN-050's "ULIDs everywhere"), but FTS5/vec0 each have their
 * own internal integer rowid space that a caller can't set explicitly for
 * vec0 (better-sqlite3 binding a param there fails — confirmed live), so
 * fts_rowid/vec_rowid are recorded as mapping columns after each insert.
 */
export interface ContentChunkRow {
  id: string;
  user_id: string;
  source_type: "message" | "document" | "image_description";
  source_event_id: string; // message_sent or file_uploaded event id
  extraction_event_id: string | null; // the extraction_completed event id, if any
  chunk_index: number;
  char_start: number;
  char_end: number;
  text: string;
  occurred_at: string | null;
  recorded_at: string;
  fts_rowid: number;
  vec_rowid: number;
  created_at: string;
}

export class RetrievalDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_chunks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('message', 'document', 'image_description')),
        source_event_id TEXT NOT NULL,
        extraction_event_id TEXT,
        chunk_index INTEGER NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        text TEXT NOT NULL,
        occurred_at TEXT,
        recorded_at TEXT NOT NULL,
        fts_rowid INTEGER NOT NULL,
        vec_rowid INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_user_id ON content_chunks(user_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_source_event ON content_chunks(source_event_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(text);
    `);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content_vec USING vec0(embedding float[${EMBEDDING_DIMENSIONS}]);`);
  }

  clear(): void {
    this.db.exec(`DELETE FROM content_chunks; DELETE FROM content_fts; DELETE FROM content_vec;`);
  }

  /** Inserts a chunk plus its FTS and vector entries in one go, recording the rowids sqlite assigned for each. */
  insertChunk(row: Omit<ContentChunkRow, "fts_rowid" | "vec_rowid">, embedding: Float32Array): ContentChunkRow {
    const ftsInfo = this.db.prepare(`INSERT INTO content_fts (text) VALUES (?)`).run(row.text);
    const vecInfo = this.db.prepare(`INSERT INTO content_vec (embedding) VALUES (?)`).run(Buffer.from(embedding.buffer));

    const full: ContentChunkRow = { ...row, fts_rowid: Number(ftsInfo.lastInsertRowid), vec_rowid: Number(vecInfo.lastInsertRowid) };
    this.db
      .prepare(
        `INSERT INTO content_chunks (id, user_id, source_type, source_event_id, extraction_event_id, chunk_index, char_start, char_end, text, occurred_at, recorded_at, fts_rowid, vec_rowid, created_at)
         VALUES (@id, @user_id, @source_type, @source_event_id, @extraction_event_id, @chunk_index, @char_start, @char_end, @text, @occurred_at, @recorded_at, @fts_rowid, @vec_rowid, @created_at)`
      )
      .run(full);
    return full;
  }

  listChunks(userId: string): ContentChunkRow[] {
    return this.db.prepare(`SELECT * FROM content_chunks WHERE user_id = ? ORDER BY id ASC`).all(userId) as ContentChunkRow[];
  }

  getChunkById(id: string): ContentChunkRow | undefined {
    return this.db.prepare(`SELECT * FROM content_chunks WHERE id = ?`).get(id) as ContentChunkRow | undefined;
  }

  getChunkByFtsRowid(ftsRowid: number): ContentChunkRow | undefined {
    return this.db.prepare(`SELECT * FROM content_chunks WHERE fts_rowid = ?`).get(ftsRowid) as ContentChunkRow | undefined;
  }

  getChunkByVecRowid(vecRowid: number): ContentChunkRow | undefined {
    return this.db.prepare(`SELECT * FROM content_chunks WHERE vec_rowid = ?`).get(vecRowid) as ContentChunkRow | undefined;
  }

  getChunksBySourceEventId(sourceEventId: string): ContentChunkRow[] {
    return this.db.prepare(`SELECT * FROM content_chunks WHERE source_event_id = ? ORDER BY chunk_index ASC`).all(sourceEventId) as ContentChunkRow[];
  }

  /** Reads back the embedding vector for a chunk — used by strict-exact rebuild verification, which checks embeddings are byte-identical across independent rebuilds (EN-057 v1.5). */
  getEmbeddingForChunk(chunkId: string): Float32Array | undefined {
    const chunk = this.db.prepare(`SELECT vec_rowid FROM content_chunks WHERE id = ?`).get(chunkId) as { vec_rowid: number } | undefined;
    if (!chunk) return undefined;
    const row = this.db.prepare(`SELECT embedding FROM content_vec WHERE rowid = ?`).get(chunk.vec_rowid) as { embedding: Buffer } | undefined;
    if (!row) return undefined;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  close(): void {
    this.db.close();
  }
}
