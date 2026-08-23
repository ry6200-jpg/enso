import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { recentAttributeClaims } from "../src/conversation/attestation.js";
import { resolveCorrection } from "../src/conversation/correction.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function seedAttribute(entityName: string, attribute: "birthdate" | "location" | "occupation", value: string) {
  const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: `${entityName}'s ${attribute} is ${value}.`, attachmentOnly: false }, userId: PRIMARY_USER_ID });
  const extraction = eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId: msg.id, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [{ entityName, attribute, value, eventDate: null }] },
    userId: PRIMARY_USER_ID
  });
  const entityId = newId();
  projections.insertEntity({
    id: entityId,
    user_id: PRIMARY_USER_ID,
    name: entityName,
    confirmed: 0,
    source_event_ids: JSON.stringify([msg.id, extraction.id]),
    extractor_version: "message-v1",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  projections.insertEntityAttribute({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    entity_id: entityId,
    attribute,
    value,
    source_event_ids: JSON.stringify([msg.id, extraction.id]),
    created_at: new Date().toISOString()
  });
  return { entityId, extractionEventId: extraction.id };
}

describe("resolveCorrection (item 4 #2 — resolves to a real event ULID, never a projection id)", () => {
  it("resolves to the extraction event id as targetEventId, carrying the NEW value even though it differs from what's on record", () => {
    const { extractionEventId } = seedAttribute("me", "birthdate", "Richard");
    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    const resolved = resolveCorrection(claims, "me", "birthdate", "1970-04-24");

    expect(resolved).toEqual({ targetEventId: extractionEventId, entityName: "me", attribute: "birthdate", correctedValue: "1970-04-24" });
  });

  it("matches on (entityName, attribute) only, unlike resolveAttestation — a correction's whole point is the value differs", () => {
    const { extractionEventId } = seedAttribute("me", "birthdate", "not-even-close-to-a-date");
    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    // The OLD value is nowhere in this call, unlike resolveAttestation which requires it — a correction replaces, it doesn't reassert.
    const resolved = resolveCorrection(claims, "me", "birthdate", "4/24/1970");
    expect(resolved?.targetEventId).toBe(extractionEventId);
  });

  it("returns null for an entity/attribute pair not present at all", () => {
    expect(resolveCorrection([], "me", "birthdate", "4/24/1970")).toBeNull();
  });

  it("returns null when the attribute doesn't match, even if the entity does", () => {
    seedAttribute("me", "occupation", "Engineer");
    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);
    expect(resolveCorrection(claims, "me", "birthdate", "4/24/1970")).toBeNull();
  });
});
