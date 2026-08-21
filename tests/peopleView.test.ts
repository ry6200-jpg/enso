import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { getPeopleView } from "../src/projections/peopleView.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

describe("getPeopleView (Phase 7 Part 2 — provenance-traceable memory surface)", () => {
  it("resolves an attribute's 'told on' date to the earliest message_sent event in its provenance, never a later one", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Elena lives in Seattle.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const extraction = eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId: msg.id },
      userId: PRIMARY_USER_ID
    });
    const elenaId = newId();
    projections.insertEntity({
      id: elenaId,
      user_id: PRIMARY_USER_ID,
      name: "Elena",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg.id, extraction.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: elenaId,
      attribute: "location",
      value: "Seattle",
      source_event_ids: JSON.stringify([msg.id, extraction.id]),
      created_at: new Date().toISOString()
    });

    const view = getPeopleView(eventLog, projections, PRIMARY_USER_ID);

    expect(view).toHaveLength(1);
    expect(view[0]!.name).toBe("Elena");
    expect(view[0]!.attributes).toEqual([{ attribute: "location", facts: [{ value: "Seattle", toldOn: msg.occurredAt ?? msg.recordedAt, sourceEventIds: [msg.id, extraction.id] }] }]);
  });

  it("surfaces a structural relationship to the primary user, with direction and provenance", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My mother Elena lives in Seattle.", attachmentOnly: false }, userId: PRIMARY_USER_ID });
    const elenaId = newId();
    projections.insertEntity({
      id: elenaId,
      user_id: PRIMARY_USER_ID,
      name: "Elena",
      confirmed: 0,
      source_event_ids: JSON.stringify([msg.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projections.insertStructuralAtom({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      type: "parent_of",
      from_entity_id: elenaId,
      to_entity_id: primaryEntityId(PRIMARY_USER_ID),
      basis: "stated",
      interval_start: null,
      interval_end: null,
      source_event_ids: JSON.stringify([msg.id]),
      created_at: new Date().toISOString()
    });

    const view = getPeopleView(eventLog, projections, PRIMARY_USER_ID);

    expect(view[0]!.relationships).toEqual([{ type: "parent_of", direction: "from", basis: "stated", toldOn: msg.occurredAt ?? msg.recordedAt, sourceEventIds: [msg.id] }]);
  });

  it("a person with no message_sent provenance (extraction-only source ids) resolves toldOn to null, never a guess", () => {
    const extraction = eventLog.append({ type: "extraction_completed", actor: "system", payload: { sourceEventId: "nonexistent" }, userId: PRIMARY_USER_ID });
    const marcusId = newId();
    projections.insertEntity({
      id: marcusId,
      user_id: PRIMARY_USER_ID,
      name: "Marcus",
      confirmed: 0,
      source_event_ids: JSON.stringify([extraction.id]),
      extractor_version: "message-v1",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: marcusId,
      attribute: "occupation",
      value: "teacher",
      source_event_ids: JSON.stringify([extraction.id]),
      created_at: new Date().toISOString()
    });

    const view = getPeopleView(eventLog, projections, PRIMARY_USER_ID);

    expect(view[0]!.attributes[0]!.facts[0]!.toldOn).toBeNull();
  });
});
