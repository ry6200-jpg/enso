import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { buildSelfProfile, type SelfProfile } from "../src/projections/peopleView.js";
import { buildSelfProfileBlock } from "../src/persona/systemPrompt.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;
const primary = primaryEntityId(PRIMARY_USER_ID);

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function attr(entityId: string, attribute: "birthdate" | "location" | "occupation", value: string) {
  projections.insertEntityAttribute({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: entityId, attribute, value, source_event_ids: "[]", created_at: new Date().toISOString() });
}

function entity(id: string, name: string) {
  projections.insertEntity({ id, user_id: PRIMARY_USER_ID, name, confirmed: 1, source_event_ids: "[]", extractor_version: "v1", pending_disambiguation: null, created_at: new Date().toISOString() });
}

describe("buildSelfProfile (Part B, R38) — the data, scoped to self + direct bonds only", () => {
  it("empty for a brand-new user with nothing on record", () => {
    expect(buildSelfProfile(projections, PRIMARY_USER_ID)).toEqual({ attributes: [], bonds: [] });
  });

  it("includes the owner's own resolved attributes, in a fixed order, never a third party's", () => {
    attr(primary, "occupation", "ERP system analyst at LACCD");
    attr(primary, "birthdate", "1970-04-24");
    const someoneElse = newId();
    entity(someoneElse, "Karen");
    attr(someoneElse, "birthdate", "1955-01-01");

    const profile = buildSelfProfile(projections, PRIMARY_USER_ID);
    expect(profile.attributes).toEqual([
      { attribute: "birthdate", value: "1970-04-24", conflictingValues: [] },
      { attribute: "occupation", value: "ERP system analyst at LACCD", conflictingValues: [] }
    ]);
  });

  it("R37/R38 together: a conflicting immutable attribute is resolved to the first valid value AND the conflict is carried through, never silently dropped", () => {
    attr(primary, "birthdate", "1970-04-24");
    attr(primary, "birthdate", "1983"); // the real live misextraction (R37)

    const profile = buildSelfProfile(projections, PRIMARY_USER_ID);
    expect(profile.attributes).toEqual([{ attribute: "birthdate", value: "1970-04-24", conflictingValues: ["1983"] }]);
  });

  it("includes a direct social bond (name + relationship only) and a direct structural atom, correctly labeled from the owner's perspective", () => {
    const friendId = newId();
    entity(friendId, "Haw Kiat");
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: primary, to_entity_id: friendId, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    const motherId = newId();
    entity(motherId, "Mom");
    projections.insertStructuralAtom({ id: newId(), user_id: PRIMARY_USER_ID, type: "parent_of", from_entity_id: motherId, to_entity_id: primary, basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    const profile = buildSelfProfile(projections, PRIMARY_USER_ID);
    expect(profile.bonds).toEqual(
      expect.arrayContaining([
        { name: "Haw Kiat", relationship: "friend" },
        { name: "Mom", relationship: "parent" }
      ])
    );
  });

  it("excludes a bond between two third parties that doesn't touch the owner", () => {
    const a = newId();
    const b = newId();
    entity(a, "Vicki");
    entity(b, "Karen");
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: a, to_entity_id: b, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    expect(buildSelfProfile(projections, PRIMARY_USER_ID).bonds).toEqual([]);
  });

  it("excludes a CLOSED bond — it's history, not a current fact about who the owner is now", () => {
    const exId = newId();
    entity(exId, "Sam");
    projections.insertStructuralAtom({ id: newId(), user_id: PRIMARY_USER_ID, type: "spouse_of", from_entity_id: primary, to_entity_id: exId, basis: "stated", interval_start: null, interval_end: "2024-01-01", source_event_ids: "[]", created_at: new Date().toISOString() });

    expect(buildSelfProfile(projections, PRIMARY_USER_ID).bonds).toEqual([]);
  });

  it("mentor_of direction: labels the OTHER person as 'mentor' or 'mentee' correctly depending which side the owner is on", () => {
    const mentorId = newId();
    entity(mentorId, "Dr. Lee");
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "mentor_of", from_entity_id: mentorId, to_entity_id: primary, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    expect(buildSelfProfile(projections, PRIMARY_USER_ID).bonds).toEqual([{ name: "Dr. Lee", relationship: "mentor" }]);
  });
});

describe("buildSelfProfileBlock (Part B, R38) — pure formatting, DATA not instructions", () => {
  const EMPTY: SelfProfile = { attributes: [], bonds: [] };

  it("omits the block entirely when nothing is known — never a placeholder 'nothing known' line", () => {
    const result = buildSelfProfileBlock(EMPTY, 1000);
    expect(result.block).toBeNull();
    expect(result.attributeCount).toBe(0);
    expect(result.bondCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("renders a validly-resolved attribute plainly, as data", () => {
    const profile: SelfProfile = { attributes: [{ attribute: "birthdate", value: "1970-04-24", conflictingValues: [] }], bonds: [] };
    const result = buildSelfProfileBlock(profile, 1000);
    expect(result.block).toContain("Birthdate: 1970-04-24");
    expect(result.attributeCount).toBe(1);
  });

  it("never contains an attribute buildSelfProfile didn't resolve — an unknown attribute simply has no line, not an empty/placeholder one", () => {
    const profile: SelfProfile = { attributes: [{ attribute: "location", value: "Los Angeles", conflictingValues: [] }], bonds: [] };
    const result = buildSelfProfileBlock(profile, 1000);
    expect(result.block).not.toMatch(/Birthdate/);
    expect(result.block).not.toMatch(/Occupation/);
  });

  it("renders a conflict as two disagreeing facts, never a directive verb telling Enso what to do about it", () => {
    const profile: SelfProfile = { attributes: [{ attribute: "birthdate", value: "1970-04-24", conflictingValues: ["1983"] }], bonds: [] };
    const result = buildSelfProfileBlock(profile, 1000);
    expect(result.block).toContain("1970-04-24");
    expect(result.block).toContain('"1983"');
    expect(result.block).not.toMatch(/\b(ask|consider|resolve|clarify|should|must)\b/i);
  });

  it("contains no instruction-shaped language at all — DATA, not instructions (THE ANTI-ROBOT RULE)", () => {
    const profile: SelfProfile = { attributes: [{ attribute: "birthdate", value: "1970-04-24", conflictingValues: [] }], bonds: [{ name: "Haw Kiat", relationship: "friend" }] };
    const result = buildSelfProfileBlock(profile, 1000);
    expect(result.block).not.toMatch(/\b(never|always|don't|do not|must|should)\b/i);
  });

  it("bonds render as 'Relationships: name (relationship), ...'", () => {
    const profile: SelfProfile = { attributes: [], bonds: [{ name: "Haw Kiat", relationship: "friend" }, { name: "Mom", relationship: "parent" }] };
    const result = buildSelfProfileBlock(profile, 1000);
    expect(result.block).toContain("Relationships: Haw Kiat (friend), Mom (parent)");
    expect(result.bondCount).toBe(2);
  });

  it("under a tight budget, drops bonds from the end of the list before ever dropping an attribute", () => {
    const profile: SelfProfile = {
      attributes: [{ attribute: "birthdate", value: "1970-04-24", conflictingValues: [] }],
      bonds: [{ name: "Haw Kiat", relationship: "friend" }, { name: "Someone With A Long Name", relationship: "colleague" }]
    };
    const tight = `=== OWNER PROFILE (begin) ===\nBirthdate: 1970-04-24\n=== OWNER PROFILE (end) ===`.length;
    const result = buildSelfProfileBlock(profile, tight);
    expect(result.block).toContain("Birthdate: 1970-04-24");
    expect(result.block).not.toContain("Relationships");
    expect(result.truncated).toBe(true);
    expect(result.attributeCount).toBe(1);
  });

  it("a resolved attribute is kept even if it alone exceeds the budget — never dropped, only flagged truncated", () => {
    const profile: SelfProfile = { attributes: [{ attribute: "occupation", value: "a".repeat(500), conflictingValues: [] }], bonds: [] };
    const result = buildSelfProfileBlock(profile, 10);
    expect(result.block).toContain("a".repeat(500));
    expect(result.truncated).toBe(true);
  });
});
