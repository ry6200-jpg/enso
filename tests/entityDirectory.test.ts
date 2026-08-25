import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { computeEntityDirectory, computeFillRates, DORMANCY_THRESHOLD_DAYS } from "../src/admin/entityDirectory.js";

let projections: ProjectionsDb;
const primary = primaryEntityId(PRIMARY_USER_ID);
const NOW = "2026-08-24T23:30:10.085Z";

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function insertEntity(name: string, sourceEventIds: string[]) {
  const id = newId();
  projections.insertEntity({ id, user_id: PRIMARY_USER_ID, name, confirmed: 0, source_event_ids: JSON.stringify(sourceEventIds), extractor_version: "message-v1", pending_disambiguation: null, created_at: new Date().toISOString() });
  return id;
}

function addAlias(entityId: string, alias: string) {
  projections.insertEntityAlias({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: entityId, alias, source_event_ids: "[]", created_at: new Date().toISOString() });
}

function addAttribute(entityId: string, attribute: "birthdate" | "location" | "occupation", value: string) {
  projections.insertEntityAttribute({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: entityId, attribute, value, source_event_ids: "[]", created_at: new Date().toISOString() });
}

function bondToPrimary(entityId: string, type: "friend" | "colleague" | "romantic" = "friend") {
  projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type, from_entity_id: entityId, to_entity_id: primary, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });
}

function bondBetween(a: string, b: string, type: "friend" | "colleague" = "friend") {
  projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type, from_entity_id: a, to_entity_id: b, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });
}

describe("computeEntityDirectory (admin-only entity view, part 2)", () => {
  it("empty archive produces an empty directory, never a fabricated entry", () => {
    expect(computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW)).toEqual([]);
  });

  it("canonical name and all observed name variants, excluding the canonical name itself", () => {
    const id = insertEntity("Elizabeth", []);
    addAlias(id, "Elizabeth");
    addAlias(id, "Liz");
    addAlias(id, "Beth");
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW);
    expect(entry!.canonicalName).toBe("Elizabeth");
    expect(entry!.nameVariants.sort()).toEqual(["Beth", "Liz"]);
  });

  it("deduplicates repeated alias rows for the same variant", () => {
    const id = insertEntity("Elizabeth", []);
    addAlias(id, "Liz");
    addAlias(id, "Liz");
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW);
    expect(entry!.nameVariants).toEqual(["Liz"]);
  });

  it("attributes reflect resolved (not raw/conflicting) values, null when never stated", () => {
    const id = insertEntity("Marcus", []);
    addAttribute(id, "location", "Seattle");
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW);
    expect(entry!.attributes).toEqual({ birthdate: null, location: "Seattle", occupation: null });
  });

  it("bond constellation includes bonds to the primary user, labeled '(you)'", () => {
    const id = insertEntity("Elena", []);
    bondToPrimary(id, "friend");
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW);
    expect(entry!.bonds).toHaveLength(1);
    expect(entry!.bonds[0]!.withPrimary).toBe(true);
    expect(entry!.bonds[0]!.otherEntityName).toBe("(you)");
    expect(entry!.relationshipClassToPrimary).toBe("friend");
  });

  it("bond constellation ALSO includes alter-to-alter bonds neither side of which is primary — the gap peopleView.ts's own relationship listing doesn't cover", () => {
    const elena = insertEntity("Elena", []);
    const marcus = insertEntity("Marcus", []);
    bondToPrimary(elena, "friend");
    bondToPrimary(marcus, "colleague");
    bondBetween(elena, marcus, "friend"); // Elena and Marcus know each other directly

    const directory = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW);
    const elenaEntry = directory.find((e) => e.entityId === elena)!;
    expect(elenaEntry.bonds).toHaveLength(2); // to primary AND to Marcus
    const toMarcus = elenaEntry.bonds.find((b) => b.otherEntityId === marcus)!;
    expect(toMarcus.withPrimary).toBe(false);
    expect(toMarcus.otherEntityName).toBe("Marcus");
  });

  it("mention count, first and last mention, resolved from the event log's own recorded_at — never decoded from the ULID", () => {
    const id = insertEntity("Elena", ["m1", "m2", "m3"]);
    const recordedAtByMessageId = new Map([
      ["m1", "2026-08-01T10:00:00.000Z"],
      ["m2", "2026-08-10T10:00:00.000Z"],
      ["m3", "2026-08-20T10:00:00.000Z"]
    ]);
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, recordedAtByMessageId, NOW);
    expect(entry!.mentionCount).toBe(3);
    expect(entry!.firstMentionAt).toBe("2026-08-01T10:00:00.000Z");
    expect(entry!.lastMentionAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("dormancy: flagged when last mention is at or beyond DORMANCY_THRESHOLD_DAYS", () => {
    const id = insertEntity("Elena", ["m1"]);
    const longAgo = new Date(new Date(NOW).getTime() - (DORMANCY_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map([["m1", longAgo]]), NOW);
    expect(entry!.dormant).toBe(true);
  });

  it("dormancy: not flagged when recently mentioned", () => {
    const id = insertEntity("Elena", ["m1"]);
    const recent = new Date(new Date(NOW).getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const [entry] = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map([["m1", recent]]), NOW);
    expect(entry!.dormant).toBe(false);
  });

  it("scopes strictly to the given user — never returns another user's entities", () => {
    projections.insertEntity({ id: newId(), user_id: "someone-else", name: "Not Mine", confirmed: 0, source_event_ids: "[]", extractor_version: "v1", pending_disambiguation: null, created_at: new Date().toISOString() });
    expect(computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), NOW)).toEqual([]);
  });
});

describe("computeFillRates (admin-only entity view, part 2)", () => {
  it("zero entities produces zero rates, not a division-by-zero fabrication", () => {
    expect(computeFillRates(projections, PRIMARY_USER_ID)).toEqual({ birthdate: 0, location: 0, occupation: 0, totalEntities: 0 });
  });

  it("computes a real fill rate across multiple entities", () => {
    const a = insertEntity("Elena", []);
    const b = insertEntity("Marcus", []);
    insertEntity("Priya", []); // no attributes at all
    addAttribute(a, "location", "Seattle");
    addAttribute(b, "location", "Portland");

    const rates = computeFillRates(projections, PRIMARY_USER_ID);
    expect(rates.totalEntities).toBe(3);
    expect(rates.location).toBeCloseTo(2 / 3);
    expect(rates.birthdate).toBe(0);
  });
});
