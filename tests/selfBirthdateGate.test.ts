import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import {
  buildSelfBirthdateDirective,
  isSelfBirthdateEligible,
  MAX_SELF_BIRTHDATE_ATTEMPTS,
  verifySelfBirthdateAskExecuted
} from "../src/conversation/selfBirthdateGate.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(":memory:");
  projections = new ProjectionsDb(":memory:");
});

function appendSelfBirthdateFiredReply(): void {
  eventLog.append({ type: "message_sent", actor: "user", payload: { text: "some update", attachmentOnly: false }, userId: PRIMARY_USER_ID });
  const payload: Partial<ReplySentPayload> = { gateActions: { circleBackFired: null, attestationConfirmedEventId: null, selfBirthdateAskFired: true } };
  eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
}

describe("isSelfBirthdateEligible (item 1: self-entity establishment)", () => {
  it("is eligible when the birthdate is unknown and the message isn't a question", () => {
    expect(isSelfBirthdateEligible(eventLog, projections, PRIMARY_USER_ID, "another update")).toBe(true);
  });

  it("is NOT eligible once the birthdate is already known", () => {
    projections.insertEntityAttribute({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      entity_id: primaryEntityId(PRIMARY_USER_ID),
      attribute: "birthdate",
      value: "1970-04-24",
      source_event_ids: JSON.stringify(["x"]),
      created_at: new Date().toISOString()
    });
    expect(isSelfBirthdateEligible(eventLog, projections, PRIMARY_USER_ID, "another update")).toBe(false);
  });

  it("is NOT eligible on a message that's itself a question — same restraint as circle-back's own heuristic", () => {
    expect(isSelfBirthdateEligible(eventLog, projections, PRIMARY_USER_ID, "what do you think about that?")).toBe(false);
  });

  it("is NOT eligible once MAX_SELF_BIRTHDATE_ATTEMPTS has already fired — a one-shot ask, not a repeatable gate", () => {
    expect(MAX_SELF_BIRTHDATE_ATTEMPTS).toBe(1);
    appendSelfBirthdateFiredReply();
    expect(isSelfBirthdateEligible(eventLog, projections, PRIMARY_USER_ID, "another update")).toBe(false);
  });
});

describe("verifySelfBirthdateAskExecuted (EN-073-style directive verification)", () => {
  it("recognizes a reply that actually asked about the birthday", () => {
    expect(verifySelfBirthdateAskExecuted("By the way, when's your birthday?")).toBe(true);
    expect(verifySelfBirthdateAskExecuted("Out of curiosity, when were you born?")).toBe(true);
  });

  it("returns false for a reply that never asked", () => {
    expect(verifySelfBirthdateAskExecuted("That sounds like a busy week.")).toBe(false);
  });
});

describe("buildSelfBirthdateDirective", () => {
  it("explicitly instructs against a direct database-style question", () => {
    const directive = buildSelfBirthdateDirective();
    expect(directive).toMatch(/never as a direct database-style question/);
    expect(directive.toLowerCase()).toContain("birthdate");
  });
});
