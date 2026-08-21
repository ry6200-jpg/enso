import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { EVENT_TYPES } from "../src/events/schema.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let log: EventLog;

beforeEach(() => {
  log = new EventLog(freshTestDbPath(import.meta.url, "events"));
});

afterEach(() => {
  log.close();
});

describe("EventLog (EN-050)", () => {
  it("appends an event and assigns a ULID id and recorded_at", () => {
    const before = Date.now();
    const event = log.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "hello" },
      userId: PRIMARY_USER_ID
    });
    expect(event.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(new Date(event.recordedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(event.occurredAt).toBeNull();
    expect(event.schemaVersion).toBe(1);
  });

  it("accepts all ten resolved event types", () => {
    for (const type of EVENT_TYPES) {
      const event = log.append({
        type,
        actor: type === "reply_sent" ? "enso" : type.startsWith("extraction") || type === "external_lookup_performed" ? "system" : "user",
        payload: { note: type },
        userId: PRIMARY_USER_ID
      });
      expect(event.type).toBe(type);
    }
    expect(log.count()).toBe(EVENT_TYPES.length);
  });

  it("rejects an unknown event type at the write path", () => {
    expect(() =>
      log.append({
        type: "entities_merged",
        actor: "system",
        payload: {},
        userId: PRIMARY_USER_ID
      })
    ).toThrow(/Unknown event type/);
    expect(log.count()).toBe(0);
  });

  it("rejects an unknown actor", () => {
    expect(() =>
      log.append({
        type: "message_sent",
        actor: "admin",
        payload: {},
        userId: PRIMARY_USER_ID
      })
    ).toThrow(/Unknown actor/);
  });

  it("requires a user_id", () => {
    expect(() =>
      log.append({ type: "message_sent", actor: "user", payload: {}, userId: "" })
    ).toThrow(/user_id/);
  });

  it("is mechanically append-only: UPDATE is rejected at the DB layer", () => {
    const event = log.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "original" },
      userId: PRIMARY_USER_ID
    });
    expect(() =>
      log.db.prepare(`UPDATE events SET payload = ? WHERE id = ?`).run("{}", event.id)
    ).toThrow(/append-only/);

    const reread = log.getById(event.id)!;
    expect(reread.payload).toEqual({ text: "original" });
  });

  it("is mechanically append-only: DELETE is rejected at the DB layer", () => {
    const event = log.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "keep me" },
      userId: PRIMARY_USER_ID
    });
    expect(() => log.db.prepare(`DELETE FROM events WHERE id = ?`).run(event.id)).toThrow(
      /append-only/
    );
    expect(log.count()).toBe(1);
  });

  it("returns events for a user in log order", () => {
    const a = log.append({ type: "message_sent", actor: "user", payload: { n: 1 }, userId: PRIMARY_USER_ID });
    const b = log.append({ type: "reply_sent", actor: "enso", payload: { n: 2 }, userId: PRIMARY_USER_ID });
    const events = log.listForUser(PRIMARY_USER_ID);
    expect(events.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it("scopes listForUser to the given user_id", () => {
    log.append({ type: "message_sent", actor: "user", payload: {}, userId: PRIMARY_USER_ID });
    log.append({ type: "message_sent", actor: "user", payload: {}, userId: "someone-else" });
    expect(log.listForUser(PRIMARY_USER_ID)).toHaveLength(1);
  });
});
