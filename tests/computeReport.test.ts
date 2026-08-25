import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { computeReport, hasAnyDisplayableData } from "../src/report/computeReport.js";

let eventLog: EventLog;
let projections: ProjectionsDb;
const primary = primaryEntityId(PRIMARY_USER_ID);

beforeEach(() => {
  eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function userTurn(text: string) {
  return eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function ensoTurn(text: string, inReplyToEventId: string) {
  return eventLog.append({ type: "reply_sent", actor: "enso", payload: { text, inReplyToEventId }, userId: PRIMARY_USER_ID });
}

// Real EventLog rows always get a real "now" recorded_at (the append-only log has no backdating
// path, by design — see eventLog.ts's append-only triggers), so every message a test appends here
// lands in the SAME report window regardless of how much wall-clock time separates the appends.
// Multi-window/baseline behavior is exhaustively covered at the pure-function level instead
// (reportWindows.test.ts, networkMarkers.test.ts, temporalMarkers.test.ts, reportBaseline.test.ts,
// which all construct plain {id, recordedAt, text} objects directly, not through EventLog) — this
// file verifies the ORCHESTRATION: real event-log reads, reply exclusion, and correct wiring of
// each marker module into one result.

describe("hasAnyDisplayableData (report page, Stage A go/no-go)", () => {
  it("false for a genuinely fresh user", () => {
    expect(hasAnyDisplayableData(eventLog, PRIMARY_USER_ID)).toBe(false);
  });

  it("true once at least one real message_sent event exists", () => {
    userTurn("hello");
    expect(hasAnyDisplayableData(eventLog, PRIMARY_USER_ID)).toBe(true);
  });

  it("false for another user's data — never leaks across the user boundary", () => {
    eventLog.append({ type: "message_sent", actor: "user", payload: { text: "someone else", attachmentOnly: false }, userId: "someone-else" });
    expect(hasAnyDisplayableData(eventLog, PRIMARY_USER_ID)).toBe(false);
  });
});

describe("computeReport (report page, Stage A end to end)", () => {
  it("an empty corpus produces zero windows and a corpus span of nulls, never fabricated data", () => {
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC", "2026-08-25T00:00:00.000Z", 7);
    expect(result.corpus).toEqual({ totalMessages: 0, firstMessageAt: null, lastMessageAt: null });
    expect(result.wordClasses).toEqual([]);
    expect(result.baselines).toEqual([]);
  });

  it("excludes Enso's own replies from every marker — word-class rates and corpus span alike (methodology Section 1)", () => {
    const m1 = userTurn("I am so exhausted");
    ensoTurn("That sounds hard, I understand completely", m1.id);
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC");
    expect(result.corpus.totalMessages).toBe(1);
    // "understand" is an insight-class word in Enso's reply only — if it leaked in, totalWords would reflect it.
    expect(result.wordClasses[0]!.totalWords).toBe(4); // "I am so exhausted"
  });

  it("a single window shows no baseline anywhere — one point is not a trend", () => {
    userTurn("I am fine today");
    userTurn("still fine");
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC");
    expect(result.baselines).toHaveLength(1);
    expect(result.baselines[0]!.activeTieCount.baseline).toBeNull();
    expect(result.baselines[0]!.lexicalDiversityTypeTokenRatio.baseline).toBeNull();
    for (const wc of result.baselines[0]!.wordClassRates) expect(wc.baseline.baseline).toBeNull();
  });

  it("network markers reflect real established entities mentioned across the corpus", () => {
    const m1 = userTurn("My friend Elena helped me move.");
    const entityId = newId();
    projections.insertEntity({ id: entityId, user_id: PRIMARY_USER_ID, name: "Elena", confirmed: 0, source_event_ids: JSON.stringify([m1.id]), extractor_version: "v1", pending_disambiguation: null, created_at: new Date().toISOString() });
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: entityId, to_entity_id: primary, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC");
    expect(result.network.perWindow[0]!.activeTieCount).toBe(1);
    expect(result.network.tieComposition).toEqual([{ relationshipClass: "friend", count: 1 }]);
  });

  it("temporal markers are wired through with real session data from the corpus", () => {
    userTurn("first message");
    userTurn("second message, same session");
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC");
    expect(result.temporal.sessions).toHaveLength(1);
    expect(result.temporal.sessions[0]!.messageCount).toBe(2);
  });

  it("windowDays echoes the parameter passed in, not a hardcoded value", () => {
    userTurn("hello");
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC", new Date().toISOString(), 3);
    expect(result.windowDays).toBe(3);
  });

  it("defaults windowDays from getReportWindowDays() (env-configurable) when not passed explicitly", () => {
    userTurn("hello");
    const result = computeReport(eventLog, projections, PRIMARY_USER_ID, "UTC");
    expect(result.windowDays).toBe(7); // DEFAULT_REPORT_WINDOW_DAYS, since REPORT_WINDOW_DAYS is unset in the test env
  });
});
