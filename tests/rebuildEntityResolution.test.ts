import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function appendExtraction(sourceEventId: string, payload: Record<string, unknown>) {
  return eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: { sourceEventId, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], ...payload },
    userId: PRIMARY_USER_ID
  });
}

function msg(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text }, userId: PRIMARY_USER_ID });
}

describe("entity resolution cascade wired into rebuild (EN-012)", () => {
  it("resolves a first-name-only mention against an already-known fuller name, and upgrades the canonical name", () => {
    const m1 = msg("Irene Yap called.");
    appendExtraction(m1.id, { entities: [{ name: "Irene Yap", type: "person" }] });
    const m2 = msg("Irene called again.");
    appendExtraction(m2.id, { entities: [{ name: "Irene", type: "person" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const entities = projections.listEntities(PRIMARY_USER_ID);
    expect(entities).toHaveLength(1); // one person, not two
    expect(entities[0]!.name).toBe("Irene Yap"); // fuller name wins
  });

  it("a fuzzy/phonetic near-miss NEVER auto-merges — creates a new entity flagged pending_disambiguation instead", () => {
    const m1 = msg("Xiomara called.");
    appendExtraction(m1.id, { entities: [{ name: "Xiomara", type: "person" }] });
    const m2 = msg("Chiomara called.");
    appendExtraction(m2.id, { entities: [{ name: "Chiomara", type: "person" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const entities = projections.listEntities(PRIMARY_USER_ID);
    expect(entities).toHaveLength(2); // NOT merged
    const chiomara = entities.find((e) => e.name === "Chiomara")!;
    expect(chiomara.pending_disambiguation).not.toBeNull();
    const pending = JSON.parse(chiomara.pending_disambiguation!);
    expect(pending.candidateName).toBe("Chiomara");
  });

  it("SCENARIO 2 shape: a same-counterparty kinship conflict correctly splits two different people sharing a name — not one merged blob", () => {
    // "Sarah" the sister
    const m1 = msg("My sister Sarah is great.");
    appendExtraction(m1.id, {
      entities: [{ name: "Sarah", type: "person" }],
      structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Sarah", action: "assert", explicitlyNewPerson: false }]
    });
    // A DIFFERENT "Sarah" — stated as my mother. Can't be both sibling and parent to the same real person.
    const m2 = msg("My mom Sarah called.");
    appendExtraction(m2.id, {
      entities: [{ name: "Sarah", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "Sarah", toName: "me", action: "assert", explicitlyNewPerson: false }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const sarahs = projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === "Sarah");
    expect(sarahs).toHaveLength(2); // two distinct Sarahs, not one merged blob

    const me = primaryEntityId(PRIMARY_USER_ID);
    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID);
    const siblingSarahId = sarahs.find((s) => atoms.some((a) => a.type === "sibling_of" && (a.from_entity_id === s.id || a.to_entity_id === s.id)))!.id;
    const momSarahId = sarahs.find((s) => atoms.some((a) => a.type === "parent_of" && a.from_entity_id === s.id))!.id;
    expect(siblingSarahId).not.toBe(momSarahId);
    expect(atoms.some((a) => a.type === "sibling_of" && (a.from_entity_id === me || a.to_entity_id === me))).toBe(true);
    expect(atoms.some((a) => a.type === "parent_of" && a.to_entity_id === me && a.from_entity_id === momSarahId)).toBe(true);
  });

  it("explicitlyNewPerson overrides an otherwise-accepted match, even with no type conflict (bonds accrete and have no conflict concept on their own)", () => {
    const m1 = msg("My friend Amy is visiting.");
    appendExtraction(m1.id, {
      entities: [{ name: "Amy", type: "person" }],
      socialBonds: [{ type: "friend", fromName: "me", toName: "Amy", qualifier: null, basis: "stated", action: "open", explicitlyNewPerson: false }]
    });
    const m2 = msg("A totally different Amy from work said hi.");
    appendExtraction(m2.id, {
      entities: [{ name: "Amy", type: "person" }],
      socialBonds: [{ type: "colleague", fromName: "me", toName: "Amy", qualifier: null, basis: "inferred", action: "open", explicitlyNewPerson: true }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const amys = projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === "Amy");
    expect(amys).toHaveLength(2); // NOT merged despite bonds having no inherent conflict
    const second = amys.find((a) => a.pending_disambiguation !== null);
    expect(second).toBeDefined();
    expect(JSON.parse(second!.pending_disambiguation!).reason).toBe("explicitly_new_person");
  });

  it("same-message double-resolution protection: one name mentioned across entities/atoms/attributes in ONE message resolves to ONE entity", () => {
    const m1 = msg("My sister Amy's birthday is May 12.");
    appendExtraction(m1.id, {
      entities: [{ name: "Amy", type: "person" }],
      structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Amy", action: "assert", explicitlyNewPerson: false }],
      attributes: [{ entityName: "Amy", attribute: "birthdate", value: "1990-05-12", eventDate: null }]
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const amys = projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === "Amy");
    expect(amys).toHaveLength(1); // NOT three separate entities for one mention repeated three ways
    expect(result.attributesApplied).toBe(1);
    expect(result.structuralAtomsApplied).toBe(1);
  });

  it("stated evidence of the SAME kinship type toward the same counterparty is a reconfirmation, not a conflict", () => {
    const m1 = msg("My sister Amy called.");
    appendExtraction(m1.id, {
      entities: [{ name: "Amy", type: "person" }],
      structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Amy", action: "assert", explicitlyNewPerson: false }]
    });
    const m2 = msg("My sister Amy visited again.");
    appendExtraction(m2.id, {
      entities: [{ name: "Amy", type: "person" }],
      structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Amy", action: "assert", explicitlyNewPerson: false }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === "Amy")).toHaveLength(1);
  });
});
