import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { getCurrentAttribute } from "../src/perception/attributes.js";
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

describe("rebuild folds structural atoms from recorded payloads (EN-013/054)", () => {
  it("resolves 'me' to the stable primary entity id and creates the sibling atom", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My sister Amy is great." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, { entities: [{ name: "Amy", type: "person" }], structuralAtoms: [{ type: "sibling_of", fromName: "me", toName: "Amy", action: "assert" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const amy = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Amy")!;
    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID, "sibling_of");
    expect(atoms).toHaveLength(1);
    const ids = [atoms[0]!.from_entity_id, atoms[0]!.to_entity_id];
    expect(ids).toContain(amy.id);
    expect(ids).toContain(primaryEntityId(PRIMARY_USER_ID));
  });

  it("closes a spouse_of atom when a later extraction reports a stated closure", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "I married Sam." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { entities: [{ name: "Sam", type: "person" }], structuralAtoms: [{ type: "spouse_of", fromName: "me", toName: "Sam", action: "assert" }] });

    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Sam and I got divorced." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { structuralAtoms: [{ type: "spouse_of", fromName: "me", toName: "Sam", action: "close" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const atoms = projections.listStructuralAtoms(PRIMARY_USER_ID, "spouse_of");
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.interval_end).not.toBeNull();
  });
});

describe("rebuild folds social bonds from recorded payloads, respecting the open/close asymmetry (EN-013/054)", () => {
  it("opens a colleague bond on inferred evidence, then closes it only on a later stated closure", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My coworker Priya helped me today." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, {
      entities: [{ name: "Priya", type: "person" }],
      socialBonds: [{ type: "colleague", fromName: "me", toName: "Priya", qualifier: null, basis: "inferred", action: "open" }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    let bonds = projections.listSocialBonds(PRIMARY_USER_ID);
    expect(bonds).toHaveLength(1);
    expect(bonds[0]!.interval_end).toBeNull();
    expect(bonds[0]!.opened_basis).toBe("inferred");

    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Priya and I don't talk anymore after she left the company." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { socialBonds: [{ type: "colleague", fromName: "me", toName: "Priya", qualifier: null, basis: "stated", action: "close" }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    bonds = projections.listSocialBonds(PRIMARY_USER_ID);
    expect(bonds).toHaveLength(1);
    expect(bonds[0]!.interval_end).not.toBeNull();
  });

  it("a bond mentioned only once (opened) and never closed stays open across rebuild — silence closes nothing", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "My friend Diego." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {
      entities: [{ name: "Diego", type: "person" }],
      socialBonds: [{ type: "friend", fromName: "me", toName: "Diego", qualifier: null, basis: "stated", action: "open" }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID); // rebuild again, as if time had passed

    const bonds = projections.listSocialBonds(PRIMARY_USER_ID);
    expect(bonds).toHaveLength(1);
    expect(bonds[0]!.interval_end).toBeNull();
  });
});

describe("rebuild persists third-party attributes with dual-time perception logs (EN-015/016/017)", () => {
  it("THE R2 ACCEPTANCE TEST (synthetic/projection level): a birthdate stated for a non-primary person is retrievable afterward", () => {
    const msg = eventLog.append({
      type: "message_sent",
      actor: "user",
      payload: { text: "Oh, my sister Amy's birthday is May 12, 1990." },
      userId: PRIMARY_USER_ID
    });
    appendExtraction(msg.id, {
      entities: [{ name: "Amy", type: "person" }],
      attributes: [{ entityName: "Amy", attribute: "birthdate", value: "1990-05-12", eventDate: null }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const amy = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Amy")!;
    const birthdate = getCurrentAttribute(projections, PRIMARY_USER_ID, amy.id, "birthdate");
    expect(birthdate).toBeDefined();
    expect(birthdate!.value).toBe("1990-05-12");
  });

  it("records dual time: told_at from the message, event_at from the extracted relative date", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Priya moved to Seattle last year." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {
      entities: [{ name: "Priya", type: "person" }],
      attributes: [{ entityName: "Priya", attribute: "location", value: "Seattle", eventDate: "2025-08-21" }]
    });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const priya = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Priya")!;
    const attr = getCurrentAttribute(projections, PRIMARY_USER_ID, priya.id, "location")!;
    const log = projections.getPerceptionLogForFact(attr.id)!;
    expect(log.event_at).toBe("2025-08-21");
    expect(log.told_at).toBeTruthy();
    expect(log.told_at).not.toBe(log.event_at); // told-time and event-time are genuinely different moments here
  });

  it("versions attribute changes rather than overwriting — history is preserved", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Priya lives in Austin." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { entities: [{ name: "Priya", type: "person" }], attributes: [{ entityName: "Priya", attribute: "location", value: "Austin", eventDate: null }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Priya just moved to Seattle." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { attributes: [{ entityName: "Priya", attribute: "location", value: "Seattle", eventDate: null }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const priya = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Priya")!;
    const history = projections.listEntityAttributeHistory(PRIMARY_USER_ID, priya.id, "location");
    expect(history.map((h) => h.value)).toEqual(["Austin", "Seattle"]);
    expect(getCurrentAttribute(projections, PRIMARY_USER_ID, priya.id, "location")!.value).toBe("Seattle");
  });
});

describe("structural atom semantic validation at rebuild time (Bug fix 3 of 3)", () => {
  it("rebuild completes rather than throwing when a historical extraction contains a semantic violation, and structuralAtomsRejected reflects it", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Mom and Kid, somehow both ways." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {
      entities: [
        { name: "Mom", type: "person" },
        { name: "Kid", type: "person" }
      ],
      structuralAtoms: [
        { type: "parent_of", fromName: "Mom", toName: "Kid", action: "assert" },
        { type: "parent_of", fromName: "Kid", toName: "Mom", action: "assert" } // inverted against the first — a cycle
      ]
    });

    let result: ReturnType<typeof rebuildProjections> | undefined;
    expect(() => {
      result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    }).not.toThrow();

    expect(result!.structuralAtomsApplied).toBe(1);
    expect(result!.structuralAtomsRejected).toBe(1);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(1);
  });

  it("a third parent_of for the same child is now accepted (no cap), and maxOpenParentsForAnyChild reflects it", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Birth mom, birth dad, and stepmom, all parents." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {
      entities: [
        { name: "BirthMom", type: "person" },
        { name: "BirthDad", type: "person" },
        { name: "StepMom", type: "person" },
        { name: "Kid", type: "person" }
      ],
      structuralAtoms: [
        { type: "parent_of", fromName: "BirthMom", toName: "Kid", action: "assert" },
        { type: "parent_of", fromName: "BirthDad", toName: "Kid", action: "assert" },
        { type: "parent_of", fromName: "StepMom", toName: "Kid", action: "assert" }
      ]
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.structuralAtomsApplied).toBe(3);
    expect(result.structuralAtomsRejected).toBe(0);
    expect(result.maxOpenParentsForAnyChild).toBe(3);
    expect(projections.listStructuralAtoms(PRIMARY_USER_ID, "parent_of")).toHaveLength(3);
  });
});
