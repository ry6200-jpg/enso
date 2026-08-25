import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { computeNetworkMarkers, DORMANCY_THRESHOLD_DAYS } from "../src/report/markers/networkMarkers.js";
import { computeReportWindows } from "../src/report/reportWindows.js";

let projections: ProjectionsDb;
const primary = primaryEntityId(PRIMARY_USER_ID);

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function insertEntity(name: string, sourceEventIds: string[]) {
  const id = newId();
  projections.insertEntity({ id, user_id: PRIMARY_USER_ID, name, confirmed: 0, source_event_ids: JSON.stringify(sourceEventIds), extractor_version: "message-v1", pending_disambiguation: null, created_at: new Date().toISOString() });
  return id;
}

function establishAsFriend(entityId: string) {
  projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: entityId, to_entity_id: primary, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: JSON.stringify([]), created_at: new Date().toISOString() });
}

function establishBondBetween(a: string, b: string, type: "friend" | "colleague" = "friend") {
  projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type, from_entity_id: a, to_entity_id: b, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: JSON.stringify([]), created_at: new Date().toISOString() });
}

const NOW = "2026-08-24T23:30:10.085Z";

describe("computeNetworkMarkers (report page, Stage A, Section 2.2 — exact at any message length)", () => {
  it("an empty archive produces empty results, never a fabricated count", () => {
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    expect(result.perWindow).toEqual([]);
    expect(result.dormancy).toEqual([]);
    expect(result.tieComposition).toEqual([]);
    expect(result.alterDensity).toBeNull();
  });

  it("active tie count only counts ESTABLISHED entities mentioned in that window, not merely-named ones", () => {
    const messages = [{ id: "m1", recordedAt: "2026-08-23T10:00:00.000Z", text: "text" }];
    const windows = computeReportWindows(messages, 7);
    const namedOnly = insertEntity("Marcus", ["m1"]); // mentioned but never established (no bond/atom)
    void namedOnly;
    const friend = insertEntity("Elena", ["m1"]);
    establishAsFriend(friend);

    const recordedAtByMessageId = new Map([["m1", messages[0]!.recordedAt]]);
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, windows, recordedAtByMessageId, NOW);
    expect(result.perWindow[0]!.activeTieCount).toBe(1);
  });

  it("new-entity count is the first-ever mention landing in this window", () => {
    const messages = [{ id: "m1", recordedAt: "2026-08-23T10:00:00.000Z", text: "text" }];
    const windows = computeReportWindows(messages, 7);
    const friend = insertEntity("Elena", ["m1"]);
    establishAsFriend(friend);

    const recordedAtByMessageId = new Map([["m1", messages[0]!.recordedAt]]);
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, windows, recordedAtByMessageId, NOW);
    expect(result.perWindow[0]!.newEntityCount).toBe(1);
  });

  it("turnover is null for the first window (no prior to compare) and computed for later ones", () => {
    const messages = [
      { id: "m1", recordedAt: "2026-08-01T10:00:00.000Z", text: "text" },
      { id: "m2", recordedAt: "2026-08-20T10:00:00.000Z", text: "text" }
    ];
    const windows = computeReportWindows(messages, 7);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    const friend = insertEntity("Elena", ["m1"]);
    establishAsFriend(friend);

    const recordedAtByMessageId = new Map(messages.map((m) => [m.id, m.recordedAt]));
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, windows, recordedAtByMessageId, NOW);
    expect(result.perWindow[0]!.turnover).toBeNull();
    expect(result.perWindow[1]!.turnover).not.toBeNull();
  });

  it("mention concentration (HHI) is null with zero mentions and 1.0 when all mentions are on a single entity", () => {
    const messages = [{ id: "m1", recordedAt: "2026-08-23T10:00:00.000Z", text: "text" }];
    const windows = computeReportWindows(messages, 7);
    const friend = insertEntity("Elena", ["m1"]);
    establishAsFriend(friend);

    const recordedAtByMessageId = new Map([["m1", messages[0]!.recordedAt]]);
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, windows, recordedAtByMessageId, NOW);
    expect(result.perWindow[0]!.mentionConcentrationHhi).toBe(1);
  });

  it("dormancy: an established entity last mentioned beyond DORMANCY_THRESHOLD_DAYS ago is flagged dormant", () => {
    const oldMentionId = "m-old";
    const friend = insertEntity("Elena", [oldMentionId]);
    establishAsFriend(friend);
    const longAgo = new Date(new Date(NOW).getTime() - (DORMANCY_THRESHOLD_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();

    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map([[oldMentionId, longAgo]]), NOW);
    expect(result.dormancy).toHaveLength(1);
    expect(result.dormancy[0]!.dormant).toBe(true);
  });

  it("dormancy: a recently mentioned established entity is NOT flagged dormant", () => {
    const recentId = "m-recent";
    const friend = insertEntity("Elena", [recentId]);
    establishAsFriend(friend);
    const recent = new Date(new Date(NOW).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map([[recentId, recent]]), NOW);
    expect(result.dormancy[0]!.dormant).toBe(false);
  });

  it("an entity with no resolvable mention timestamp is excluded from dormancy, never guessed", () => {
    const friend = insertEntity("Elena", ["m-unresolvable"]);
    establishAsFriend(friend);
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW); // no timestamp for m-unresolvable
    expect(result.dormancy).toEqual([]);
  });

  it("tie composition counts open bonds/atoms by relationship class", () => {
    const a = insertEntity("Elena", []);
    const b = insertEntity("Marcus", []);
    establishBondBetween(a, primary, "friend");
    establishBondBetween(b, primary, "colleague");
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    const byClass = new Map(result.tieComposition.map((t) => [t.relationshipClass, t.count]));
    expect(byClass.get("friend")).toBe(1);
    expect(byClass.get("colleague")).toBe(1);
  });

  it("a closed (interval_end set) bond is excluded from tie composition — history, not a current fact", () => {
    const a = insertEntity("Elena", []);
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: a, to_entity_id: primary, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: "2020-01-01", source_event_ids: "[]", created_at: new Date().toISOString() });
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    expect(result.tieComposition).toEqual([]);
  });

  it("alter density is null with fewer than 2 established entities (no possible edge)", () => {
    const a = insertEntity("Elena", []);
    establishAsFriend(a);
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    expect(result.alterDensity).toBeNull();
  });

  it("alter density counts only alter-to-alter edges, never an edge touching the primary user", () => {
    const a = insertEntity("Elena", []);
    const b = insertEntity("Marcus", []);
    establishAsFriend(a);
    establishAsFriend(b);
    // No bond between Elena and Marcus themselves — density should be 0, not counting their shared bonds to primary.
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    expect(result.alterDensity).toBe(0);
  });

  it("alter density is a real nonzero ratio when two alters are themselves connected", () => {
    const a = insertEntity("Elena", []);
    const b = insertEntity("Marcus", []);
    establishAsFriend(a);
    establishAsFriend(b);
    establishBondBetween(a, b, "friend"); // Elena and Marcus know each other directly
    const result = computeNetworkMarkers(projections, PRIMARY_USER_ID, [], new Map(), NOW);
    expect(result.alterDensity).toBe(1); // 1 actual edge / 1 possible edge among 2 alters
  });
});
