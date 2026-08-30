import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { newId } from "../src/ids.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";
import {
  findDismissedTypoMergePairs,
  findPendingTypoMergeQuestions,
  findTypoMergeCandidates,
  MAX_TYPO_MERGE_ATTEMPTS,
  resolveTypoMergeConfirmation,
  resolveTypoMergeDismissal,
  type TypoMergeCandidate
} from "../src/relationships/typoMerge.js";

let eventLog: EventLog;
let projections: ProjectionsDb;

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function userTurn(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function insertEntity(name: string, sourceEventIds: string[]) {
  const id = newId();
  projections.insertEntity({
    id,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(sourceEventIds),
    extractor_version: "message-v7",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  });
  return id;
}

function recordReply(inReplyToEventId: string, gateActions: Partial<ReplySentPayload["gateActions"]>) {
  const payload: Partial<ReplySentPayload> = {
    inReplyToEventId,
    gateActions: {
      circleBackFired: null,
      attestationConfirmedEventId: null,
      selfBirthdateAskFired: false,
      selfFactAskFired: null,
      connectDotFired: false,
      elicitationFired: null,
      coReferenceAskFired: null,
      coReferenceAnswerEventId: null,
      mergeProposalFired: null,
      mergeAnswerEventId: null,
      typoMergeAskFired: null,
      typoMergeAnswerEventId: null,
      relationshipRetractionEventId: null,
      ...gateActions
    }
  };
  return eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
}

describe("findTypoMergeCandidates", () => {
  it("fires on a real variant pair ('An Song'/'Ah Song', distance 1)", () => {
    const m1 = userTurn("An Song came by yesterday.");
    insertEntity("An Song", [m1.id]);
    const m2 = userTurn("Ah Song called this morning.");
    insertEntity("Ah Song", [m2.id]);

    const candidates = findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.firstName === "An Song" || candidates[0]!.secondName === "An Song").toBe(true);
    expect(candidates[0]!.firstName === "Ah Song" || candidates[0]!.secondName === "Ah Song").toBe(true);
  });

  it("does not fire on two ordinary, unrelated distinct names", () => {
    const m1 = userTurn("Elena stopped by.");
    insertEntity("Elena", [m1.id]);
    const m2 = userTurn("Marcus called.");
    insertEntity("Marcus", [m2.id]);

    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
  });

  it("excludes role-word entities from comparison, even when their placeholder strings are edit-distance-close", () => {
    const m1 = userTurn("Her mother called.");
    projections.insertEntity({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      name: "mother",
      confirmed: 0,
      source_event_ids: JSON.stringify([m1.id]),
      extractor_version: "message-v7",
      pending_disambiguation: null,
      created_at: new Date().toISOString(),
      name_kind: "role_word"
    });
    const m2 = userTurn("Her brother called too.");
    projections.insertEntity({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      name: "bother", // edit-distance 1 from "mother" — would otherwise be flagged
      confirmed: 0,
      source_event_ids: JSON.stringify([m2.id]),
      extractor_version: "message-v7",
      pending_disambiguation: null,
      created_at: new Date().toISOString(),
      name_kind: "role_word"
    });
    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
  });

  it("excludes a pair already merged (a coReference confirmation exists for it)", () => {
    const m1 = userTurn("An Song came by.");
    const anId = insertEntity("An Song", [m1.id]);
    const m2 = userTurn("Ah Song called.");
    const ahId = insertEntity("Ah Song", [m2.id]);
    const anStableKey = JSON.parse(projections.getEntityById(anId)!.source_event_ids)[0];
    const ahStableKey = JSON.parse(projections.getEntityById(ahId)!.source_event_ids)[0];

    eventLog.append({
      type: "fact_confirmed",
      actor: "user",
      payload: { kind: "coReference", placeholderStableKey: ahStableKey, placeholderName: "Ah Song", realStableKey: anStableKey, realName: "An Song", anchorName: "", aliasSuppressed: false },
      userId: PRIMARY_USER_ID
    });

    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
  });

  it("excludes a permanently dismissed pair", () => {
    const m1 = userTurn("An Song came by.");
    const anId = insertEntity("An Song", [m1.id]);
    const m2 = userTurn("Ah Song called.");
    const ahId = insertEntity("Ah Song", [m2.id]);
    const anStableKey = JSON.parse(projections.getEntityById(anId)!.source_event_ids)[0];
    const ahStableKey = JSON.parse(projections.getEntityById(ahId)!.source_event_ids)[0];

    eventLog.append({
      type: "fact_corrected",
      actor: "user",
      payload: { kind: "coReferenceDismissal", firstStableKey: anStableKey, secondStableKey: ahStableKey },
      userId: PRIMARY_USER_ID
    });

    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
  });

  it("respects the attempt cap (MAX_TYPO_MERGE_ATTEMPTS)", () => {
    expect(MAX_TYPO_MERGE_ATTEMPTS).toBe(2);
    const m1 = userTurn("An Song came by.");
    insertEntity("An Song", [m1.id]);
    const m2 = userTurn("Ah Song called.");
    insertEntity("Ah Song", [m2.id]);

    const pairKey = findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)[0]!.pairKey;

    // Two fired attempts, each on its own later turn, cooldown satisfied (5+ turns apart is not required between fires for this test — attempt count is what's checked here).
    let last = m2;
    for (let i = 0; i < MAX_TYPO_MERGE_ATTEMPTS; i++) {
      last = userTurn(`filler ${i}`);
      recordReply(last.id, { typoMergeAskFired: { pairKey, firstStableKey: "x", firstName: "An Song", secondStableKey: "y", secondName: "Ah Song", proposedSurvivorName: "An Song" } });
      for (let j = 0; j < 6; j++) userTurn(`spacer ${i}-${j}`); // clear cooldown between attempts
    }

    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
  });
});

describe("findPendingTypoMergeQuestions / resolveTypoMergeConfirmation / resolveTypoMergeDismissal", () => {
  function firePendingQuestion(): { pairKey: string; askTurn: ReturnType<typeof userTurn> } {
    const m1 = userTurn("An Song came by.");
    insertEntity("An Song", [m1.id]);
    const m2 = userTurn("Ah Song called.");
    insertEntity("Ah Song", [m2.id]);
    const candidate = findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)[0]! as TypoMergeCandidate;
    const askTurn = userTurn("is that the same person?");
    recordReply(askTurn.id, {
      typoMergeAskFired: {
        pairKey: candidate.pairKey,
        firstStableKey: candidate.firstStableKey,
        firstName: candidate.firstName,
        secondStableKey: candidate.secondStableKey,
        secondName: candidate.secondName,
        proposedSurvivorName: candidate.proposedSurvivorName
      }
    });
    return { pairKey: candidate.pairKey, askTurn };
  }

  it("a confirmed merge produces the same CoReferenceConfirmedPayload shape the owner-initiated path produces", () => {
    const { pairKey } = firePendingQuestion();
    const pending = findPendingTypoMergeQuestions(eventLog, PRIMARY_USER_ID);
    expect(pending).toHaveLength(1);

    const payload = resolveTypoMergeConfirmation(pending, pairKey, null); // agree with the proposal
    expect(payload).not.toBeNull();
    expect(payload!.kind).toBe("coReference");
    expect(payload!.aliasSuppressed).toBe(false);
    expect(typeof payload!.placeholderStableKey).toBe("string");
    expect(typeof payload!.realStableKey).toBe("string");
  });

  it("a named correction picks the other side as survivor", () => {
    const { pairKey } = firePendingQuestion();
    const pending = findPendingTypoMergeQuestions(eventLog, PRIMARY_USER_ID);
    const proposed = pending[0]!.proposedSurvivorName;
    const other = proposed === pending[0]!.firstName ? pending[0]!.secondName : pending[0]!.firstName;

    const payload = resolveTypoMergeConfirmation(pending, pairKey, other);
    expect(payload!.realName).toBe(other);
  });

  it("a dismissed pair never resurfaces as a candidate, and findPendingTypoMergeQuestions no longer lists it", () => {
    const { pairKey } = firePendingQuestion();
    const pending = findPendingTypoMergeQuestions(eventLog, PRIMARY_USER_ID);

    const dismissal = resolveTypoMergeDismissal(pending, pairKey);
    expect(dismissal).toEqual({ kind: "coReferenceDismissal", firstStableKey: pending[0]!.firstStableKey, secondStableKey: pending[0]!.secondStableKey });
    eventLog.append({ type: "fact_corrected", actor: "user", payload: dismissal!, userId: PRIMARY_USER_ID });

    expect(findPendingTypoMergeQuestions(eventLog, PRIMARY_USER_ID)).toHaveLength(0);
    expect(findTypoMergeCandidates(eventLog, projections, PRIMARY_USER_ID)).toHaveLength(0);
    expect(findDismissedTypoMergePairs(eventLog, PRIMARY_USER_ID).has(pairKey)).toBe(true);
  });

  it("resolveTypoMergeConfirmation/Dismissal return null for an unknown pairKey — never guesses", () => {
    expect(resolveTypoMergeConfirmation([], "not-a-real-pair", null)).toBeNull();
    expect(resolveTypoMergeDismissal([], "not-a-real-pair")).toBeNull();
  });
});
