import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { recentAttributeClaims, resolveAttestation } from "../src/conversation/attestation.js";
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

describe("recentAttributeClaims", () => {
  it("returns a claim with its extraction_completed event id resolved (never the message_sent id)", () => {
    const { extractionEventId } = seedAttribute("Elena", "location", "Seattle");

    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    expect(claims).toEqual([{ entityName: "Elena", attribute: "location", value: "Seattle", extractionEventId }]);
  });

  it("returns the most recent claims first, capped", () => {
    seedAttribute("Elena", "location", "Seattle");
    seedAttribute("Christine", "occupation", "nurse");

    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    expect(claims[0]!.entityName).toBe("Christine");
    expect(claims[1]!.entityName).toBe("Elena");
  });

  it("returns an empty list when nothing is on record", () => {
    expect(recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID)).toEqual([]);
  });
});

describe("resolveAttestation (EN-055/066 — resolves to a real event ULID, never a projection id)", () => {
  it("resolves an exact match to the extraction event id as targetEventId", () => {
    const { extractionEventId } = seedAttribute("Elena", "location", "Seattle");
    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    const resolved = resolveAttestation(claims, "Elena", "location", "Seattle");

    expect(resolved).toEqual({ targetEventId: extractionEventId, entityName: "Elena", attribute: "location", value: "Seattle" });
  });

  it("returns null when the value doesn't exactly match — never guesses the nearest claim", () => {
    seedAttribute("Elena", "location", "Seattle");
    const claims = recentAttributeClaims(eventLog, projections, PRIMARY_USER_ID);

    expect(resolveAttestation(claims, "Elena", "location", "Portland")).toBeNull();
  });

  it("returns null for an entity/attribute pair not present at all", () => {
    expect(resolveAttestation([], "Elena", "location", "Seattle")).toBeNull();
  });
});
