import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { newId } from "../ids.js";
import {
  ACTORS,
  CURRENT_SCHEMA_VERSION,
  EVENT_TYPES,
  isActor,
  isEventType,
  type EventRecord,
  type NewEventInput
} from "./schema.js";

interface EventRow {
  id: string;
  recorded_at: string;
  occurred_at: string | null;
  type: string;
  actor: string;
  payload: string;
  schema_version: number;
  user_id: string;
}

function rowToRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    recordedAt: row.recorded_at,
    occurredAt: row.occurred_at,
    type: row.type as EventRecord["type"],
    actor: row.actor as EventRecord["actor"],
    payload: JSON.parse(row.payload),
    schemaVersion: row.schema_version,
    userId: row.user_id
  };
}

/**
 * The append-only event log (EN-050). The `events` table is the system of
 * record: every write goes through `append`, which validates the event type
 * against the closed, ten-member vocabulary before anything touches SQLite.
 * Append-only-ness is additionally enforced mechanically via triggers that
 * abort any UPDATE or DELETE, so a bug elsewhere in the app can't silently
 * mutate history even if it bypasses this class.
 */
export class EventLog {
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
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        occurred_at TEXT,
        type TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN (${ACTORS.map((a) => `'${a}'`).join(", ")})),
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        user_id TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

      CREATE TRIGGER IF NOT EXISTS events_no_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events table is append-only: UPDATE is not allowed');
      END;

      CREATE TRIGGER IF NOT EXISTS events_no_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events table is append-only: DELETE is not allowed');
      END;
    `);
  }

  /**
   * Appends a new event. Rejects unknown event types and actors before any
   * SQL runs — the ten-type vocabulary (Section 12, Q1) is closed by design.
   */
  append(input: NewEventInput): EventRecord {
    if (!isEventType(input.type)) {
      throw new Error(
        `Unknown event type "${input.type}". The event vocabulary is closed to exactly ` +
          `these ten types: ${EVENT_TYPES.join(", ")}. New types require the user's explicit decision.`
      );
    }
    if (!isActor(input.actor)) {
      throw new Error(`Unknown actor "${input.actor}". Must be one of: ${ACTORS.join(", ")}.`);
    }
    if (!input.userId || input.userId.trim() === "") {
      throw new Error("Events must carry a non-empty user_id.");
    }

    const record: EventRecord = {
      id: newId(),
      recordedAt: new Date().toISOString(),
      occurredAt: input.occurredAt ?? null,
      type: input.type,
      actor: input.actor,
      payload: input.payload,
      schemaVersion: input.schemaVersion ?? CURRENT_SCHEMA_VERSION[input.type],
      userId: input.userId
    };

    this.db
      .prepare(
        `INSERT INTO events (id, recorded_at, occurred_at, type, actor, payload, schema_version, user_id)
         VALUES (@id, @recordedAt, @occurredAt, @type, @actor, @payload, @schemaVersion, @userId)`
      )
      .run({
        id: record.id,
        recordedAt: record.recordedAt,
        occurredAt: record.occurredAt,
        type: record.type,
        actor: record.actor,
        payload: JSON.stringify(record.payload),
        schemaVersion: record.schemaVersion,
        userId: record.userId
      });

    return record;
  }

  /** All events for a user, in log order (ULIDs sort lexicographically by time). */
  listForUser(userId: string): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE user_id = ? ORDER BY id ASC`)
      .all(userId) as EventRow[];
    return rows.map(rowToRecord);
  }

  getById(id: string): EventRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
      | EventRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM events`).get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
