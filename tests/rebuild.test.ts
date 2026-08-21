import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { compareStructural, snapshotFromEntityRows } from "../src/comparator/structuralEquivalence.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function seedScenario() {
  const msg1 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "I had lunch with Sarah and my sister Amy today." },
    userId: PRIMARY_USER_ID
  });
  const extraction1 = eventLog.append({
    type: "extraction_completed",
    actor: "system",
    payload: {
      sourceEventId: msg1.id,
      extractorVersion: "stub-v1",
      modelId: "stub-model",
      entities: [{ name: "Sarah" }, { name: "Amy" }],
      relationships: [],
      dates: []
    },
    userId: PRIMARY_USER_ID
  });
  const msg2 = eventLog.append({
    type: "message_sent",
    actor: "user",
    payload: { text: "Tried calling Priya but it timed out." },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "extraction_failed",
    actor: "system",
    payload: { sourceEventId: msg2.id, reason: "timeout" },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "fact_corrected",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Amy", correctedName: "Amelia" },
    userId: PRIMARY_USER_ID
  });
  eventLog.append({
    type: "fact_confirmed",
    actor: "user",
    payload: { targetEventId: extraction1.id, entityName: "Sarah" },
    userId: PRIMARY_USER_ID
  });
  return { msg1, extraction1, msg2 };
}

describe("rebuildProjections (EN-054)", () => {
  it("drops existing projection rows before replaying (rebuild is not additive)", () => {
    projections.insertEntity({
      id: "01STRAY00000000000000000",
      user_id: PRIMARY_USER_ID,
      name: "StaleGhost",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "old-version",
      created_at: new Date().toISOString()
    });

    seedScenario();
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).not.toContain("StaleGhost");
  });

  it("builds entities from extraction output with provenance and extractor_version", () => {
    const { msg1, extraction1 } = seedScenario();
    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.extractionsRun).toBe(1); // only msg1 has a completed extraction
    expect(result.messagesSkippedAsFailed).toBe(1); // msg2's extraction_failed

    const sarah = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sarah")!;
    expect(sarah).toBeDefined();
    expect(sarah.extractor_version).toBe("stub-v1");
    expect(JSON.parse(sarah.source_event_ids)).toEqual(
      expect.arrayContaining([msg1.id, extraction1.id])
    );
  });

  it("applies fact_corrected with precedence over extraction output, bound to the event ULID (EN-055)", () => {
    seedScenario();
    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.correctionsApplied).toBe(1);
    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).toContain("Amelia");
    expect(names).not.toContain("Amy");
  });

  it("applies fact_confirmed as an attestation flag bound to the event ULID", () => {
    seedScenario();
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const sarah = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Sarah")!;
    expect(sarah.confirmed).toBe(1);
    const amelia = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Amelia")!;
    expect(amelia.confirmed).toBe(0);
  });

  it("a rebuild never resurrects a name the user already corrected away (EN-055 launch-blocking guarantee)", () => {
    seedScenario();
    // Rebuild twice in a row, as if the recovery path were invoked repeatedly.
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const names = projections.listEntities(PRIMARY_USER_ID).map((e) => e.name);
    expect(names).not.toContain("Amy");
    expect(names).toContain("Amelia");
  });

  it("is deterministic: two independent rebuilds produce structurally equivalent projections", () => {
    seedScenario();
    const events = eventLog.listForUser(PRIMARY_USER_ID);

    const projectionsB = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections-b"));

    rebuildProjections(events, projections, PRIMARY_USER_ID);
    rebuildProjections(events, projectionsB, PRIMARY_USER_ID);

    const snapshotA = snapshotFromEntityRows(projections.listEntities(PRIMARY_USER_ID));
    const snapshotB = snapshotFromEntityRows(projectionsB.listEntities(PRIMARY_USER_ID));

    expect(compareStructural(snapshotA, snapshotB)).toEqual({ equivalent: true, differences: [] });
  });

  it("the structural comparator catches a planted difference between two rebuilds", () => {
    seedScenario();
    const events = eventLog.listForUser(PRIMARY_USER_ID);
    rebuildProjections(events, projections, PRIMARY_USER_ID);

    const snapshotA = snapshotFromEntityRows(projections.listEntities(PRIMARY_USER_ID));
    const mutated = {
      ...snapshotA,
      entities: snapshotA.entities.filter((e) => e.name.toLowerCase() !== "amelia")
    };

    const comparison = compareStructural(snapshotA, mutated);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.differences.some((d) => d.includes("amelia"))).toBe(true);
  });
});
