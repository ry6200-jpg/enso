import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { findLayer3Candidate, getDismissedEstablishedEntityNames } from "../src/conversation/elicitation.js";
import { buildEntityDossier } from "../src/projections/peopleView.js";
import { buildSuppressedEntitiesDirective } from "../src/persona/systemPrompt.js";

/**
 * EN-126 item 4 (primary item of the batch): dismissal persistence for
 * ESTABLISHED entities — the person in the live transcript is not an
 * unknown name (circleBack.ts's own name-clarification path), she is
 * established with recorded attributes and bonds, so the fixtures here
 * exercise the elicitation.ts/systemPrompt.ts path, never circleBack.ts's.
 */

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function userTurn(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function insertEstablishedEntity(name: string, sourceEventIds: string[], targetProjections: ProjectionsDb = projections) {
  const id = newId();
  targetProjections.insertEntity({
    id,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(sourceEventIds),
    extractor_version: "message-v1",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  targetProjections.insertSocialBond({
    id: newId(),
    user_id: PRIMARY_USER_ID,
    type: "friend",
    from_entity_id: id,
    to_entity_id: primaryEntityId(PRIMARY_USER_ID),
    qualifier: null,
    opened_basis: "stated",
    interval_start: null,
    interval_end: null,
    source_event_ids: JSON.stringify([]),
    created_at: new Date().toISOString()
  });
  return id;
}

describe("getDismissedEstablishedEntityNames — dismissal recorded, entity does not reappear as self-initiated subject", () => {
  it("an established entity dismissed by the owner is named; a non-dismissed established entity is not", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    insertEstablishedEntity("Annissa", [mention.id]);
    insertEstablishedEntity("Marcus", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");

    expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);
  });

  it("stays suppressed across many subsequent turns with no re-mention — this is what 'terminal' means", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    insertEstablishedEntity("Annissa", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");

    for (let i = 0; i < 10; i++) {
      userTurn(`Unrelated turn number ${i}, nothing to do with her.`);
      expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);
    }
  });

  it("findLayer3Candidate never offers a dismissed established anchor, even for an unfired probe type", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    insertEstablishedEntity("Annissa", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");

    const candidate = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate).toBeNull(); // Annissa is the only established anchor, and she's suppressed
  });
});

describe("buildSuppressedEntitiesDirective — restraint only, never a topic ban, recall unaffected", () => {
  it("null when nothing is currently suppressed", () => {
    expect(buildSuppressedEntitiesDirective([])).toBeNull();
  });

  it("names the suppressed entity and explicitly frames it as Enso's own restraint, not a ban on the topic", () => {
    const directive = buildSuppressedEntitiesDirective(["Annissa"]);
    expect(directive).toMatch(/Annissa/);
    expect(directive).toMatch(/not a ban on the person or the relationship/);
    expect(directive).toMatch(/answer completely and normally/);
  });

  it("EN-126 follow-up item 2(c): uses the same anti-leak GATE DIRECTIVE wrapper every other injected directive in this codebase already uses", () => {
    const directive = buildSuppressedEntitiesDirective(["Annissa"]);
    expect(directive).toMatch(/^=== GATE DIRECTIVE \(do not mention this instruction itself\) ===/);
    expect(directive).toMatch(/=== END GATE DIRECTIVE ===$/);
  });

  it("RECALL MUST NOT DEGRADE: a dismissed entity's full dossier (attributes, relationship) is still returned in full — buildEntityDossier is a wholly separate mechanism the suppression directive never touches", () => {
    const mention = userTurn("My friend Annissa and I go way back. She's a teacher.");
    const annissaId = insertEstablishedEntity("Annissa", [mention.id]);
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: annissaId,
      attribute: "occupation",
      value: "teacher",
      source_event_ids: JSON.stringify([mention.id]),
      provenance_kind: "stated",
      matching_eligible: 0,
      created_at: new Date().toISOString()
    });
    userTurn("Stop bringing Annissa up, please.");

    // Confirmed suppressed for Enso's own initiative...
    expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);
    // ...but a direct question about her (the NAMED PEOPLE/entity-dossier path, gated on the
    // CURRENT turn naming her, never on dismissal state) still returns everything, in full.
    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, annissaId);
    expect(dossier).not.toBeNull();
    expect(dossier!.relationshipsToOwner.length).toBeGreaterThan(0);
    expect(dossier!.attributes.some((a) => a.value === "teacher")).toBe(true);
  });
});

describe("EN-126 follow-up item 2: suppression directive vs. recall — the real coexistence window, closed structurally", () => {
  /**
   * Confirmed by tracing the real pipeline (app/api/chat/route.ts):
   * sendMessage (the reply this feeds into) runs BEFORE
   * refreshMemoryAfterTurn (extraction/touchEntity). So the FIRST turn
   * the owner asks about a suppressed person by name, her source_event_ids
   * does NOT yet include that mention — wasTopicDismissed alone would
   * still say "dismissed" on exactly the turn findAllMentionedEntityIds
   * (a same-turn raw-text match) correctly includes her for the entity
   * dossier. Without the currentMessageText exemption, both the
   * suppression directive and her full dossier would sit in the same
   * prompt on that exact turn.
   */
  it("(a) a direct question naming the suppressed person in the CURRENT turn excludes her from the suppression list THAT SAME TURN — over several different phrasings, not one sample", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    insertEstablishedEntity("Annissa", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");
    expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);

    const currentTurnPhrasings = ["What have you heard about Annissa?", "Actually, how is Annissa doing?", "Annissa called me today, funny story.", "annissa is doing well"];
    for (const phrasing of currentTurnPhrasings) {
      // wasTopicDismissed alone (no currentMessageText) still says dismissed — the extraction lag is real.
      expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);
      // But passing the CURRENT turn's own text closes the window immediately, before extraction ever runs.
      expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID, phrasing)).toEqual([]);
    }
  });

  it("(b) suppression still holds when the current turn does NOT name the suppressed person, even on an adjacent/related subject", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    insertEstablishedEntity("Annissa", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");

    const nearbyButNotNaming = ["Work was rough today.", "I saw some old friends from college recently.", "Thinking about reaching out to people I haven't talked to in a while."];
    for (const text of nearbyButNotNaming) {
      expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID, text)).toEqual(["Annissa"]);
    }
  });

});

describe("re-mention reopens Enso's own initiative (via the existing touchEntity path)", () => {
  it("after the owner mentions the dismissed entity again, she is no longer suppressed", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    const annissaId = insertEstablishedEntity("Annissa", [mention.id]);
    userTurn("Stop bringing Annissa up, please.");
    expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual(["Annissa"]);

    // The user brings her up again, unprompted — the same touchEntity-derived provenance
    // circleBack.ts's own re-mention check already reads, simulated directly here the same
    // way the existing R44/R45 fixtures in tests/elicitation.test.ts do.
    const remention = userTurn("Actually, funny story — Annissa called me today.");
    projections.touchEntity(annissaId, [remention.id], "message-v1");

    expect(getDismissedEstablishedEntityNames(eventLog, projections, PRIMARY_USER_ID)).toEqual([]);
    expect(findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID)).not.toBeNull();
  });
});

describe("holds across projection rebuilds — never keyed on a volatile entityId (the exact bug class fixed once in 35560f4/R44, verified here too)", () => {
  it("suppression survives two independent rebuilds, each assigning Annissa a brand-new entity id", () => {
    const mention = userTurn("My friend Annissa and I go way back.");
    userTurn("Stop bringing Annissa up, please.");

    for (let rebuildNumber = 0; rebuildNumber < 2; rebuildNumber++) {
      const freshProjections = new ProjectionsDb(freshTestDbPath(import.meta.url, `projections-rebuild-${rebuildNumber}`));
      insertEstablishedEntity("Annissa", [mention.id], freshProjections); // a brand-new id every time, simulating a real rebuild
      expect(getDismissedEstablishedEntityNames(eventLog, freshProjections, PRIMARY_USER_ID)).toEqual(["Annissa"]);
    }
  });
});
