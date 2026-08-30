import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId, rebuildProjections } from "../src/projections/rebuild.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { findEligibleCircleBackCandidates } from "../src/conversation/circleBack.js";
import { findLayer3Candidate } from "../src/conversation/elicitation.js";
import { findAllMentionedEntityIds } from "../src/conversation/retrievalInvocation.js";
import { computeEntityDirectory } from "../src/admin/entityDirectory.js";

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

function rebuild() {
  return rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
}

function entityNamed(name: string) {
  return projections.listEntities(PRIMARY_USER_ID).filter((e) => e.name === name);
}

describe("role-word placeholder owner derivation (structural atoms)", () => {
  it("fromName role word: owner is derived from toName, the already-resolved other side of the same atom", () => {
    const m = msg("Annissa said her father is not well.");
    appendExtraction(m.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [
        { type: "parent_of", fromName: "father", toName: "Annissa", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }
      ]
    });
    rebuild();

    const annissa = entityNamed("Annissa")[0]!;
    const fathers = entityNamed("father");
    expect(fathers).toHaveLength(1);
    expect(fathers[0]!.name_kind).toBe("role_word");
    expect(fathers[0]!.owner_entity_id).toBe(annissa.id);
  });

  it("toName role word: owner is derived from fromName, including the primary user's own synthetic id", () => {
    const m = msg("My older sister called.");
    appendExtraction(m.id, {
      structuralAtoms: [
        { type: "sibling_of", fromName: "me", toName: "older sister", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: false, toNameIsRoleWord: true }
      ]
    });
    rebuild();

    const sisters = entityNamed("older sister");
    expect(sisters).toHaveLength(1);
    expect(sisters[0]!.name_kind).toBe("role_word");
    expect(sisters[0]!.owner_entity_id).toBe(primaryEntityId(PRIMARY_USER_ID));
  });

  it("same derivation applies to social bonds, not just structural atoms", () => {
    const m = msg("My mentor gave me good advice.");
    appendExtraction(m.id, {
      socialBonds: [
        { type: "mentor_of", fromName: "me", toName: "mentor", qualifier: null, basis: "stated", action: "open", explicitlyNewPerson: false, fromNameIsRoleWord: false, toNameIsRoleWord: true }
      ]
    });
    rebuild();

    const mentors = entityNamed("mentor");
    expect(mentors).toHaveLength(1);
    expect(mentors[0]!.name_kind).toBe("role_word");
    expect(mentors[0]!.owner_entity_id).toBe(primaryEntityId(PRIMARY_USER_ID));
  });
});

describe("role-word resolution cascade: owner scoping prevents the collapse bug, NULL owner never matches", () => {
  it("two different people's unnamed fathers never collapse onto one entity — the real bug this fix exists for", () => {
    const m1 = msg("Annissa's father is not well.");
    appendExtraction(m1.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Annissa", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const m2 = msg("Marcus's father is visiting this weekend.");
    appendExtraction(m2.id, {
      entities: [{ name: "Marcus", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Marcus", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    const fathers = entityNamed("father");
    expect(fathers).toHaveLength(2);
    const owners = fathers.map((f) => f.owner_entity_id).sort();
    expect(owners).toEqual([entityNamed("Annissa")[0]!.id, entityNamed("Marcus")[0]!.id].sort());
  });

  it("the SAME person's unnamed father, re-mentioned later, reuses the same placeholder entity rather than duplicating it", () => {
    const m1 = msg("Annissa's father is not well.");
    appendExtraction(m1.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Annissa", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    const m2 = msg("Annissa's father is doing better now.");
    appendExtraction(m2.id, {
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Annissa", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    const fathers = entityNamed("father");
    expect(fathers).toHaveLength(1);
    expect((JSON.parse(fathers[0]!.source_event_ids) as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it("a role-word entity with NO determinable owner (both sides of the atom are role words) never matches an earlier such placeholder — always creates fresh", () => {
    const m1 = msg("Her brother told her sister about it.");
    appendExtraction(m1.id, {
      structuralAtoms: [{ type: "sibling_of", fromName: "brother", toName: "sister", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: true }]
    });
    const m2 = msg("His brother told his sister the same thing, unrelated to the first pair.");
    appendExtraction(m2.id, {
      structuralAtoms: [{ type: "sibling_of", fromName: "brother", toName: "sister", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: true }]
    });
    rebuild();

    const brothers = entityNamed("brother");
    const sisters = entityNamed("sister");
    expect(brothers).toHaveLength(2);
    expect(sisters).toHaveLength(2);
    for (const e of [...brothers, ...sisters]) {
      expect(e.name_kind).toBe("role_word");
      expect(e.owner_entity_id).toBeNull();
    }
  });
});

describe("pre-v5 cached payloads: absent fromNameIsRoleWord/toNameIsRoleWord defaults to NOT a role word", () => {
  it("a structuralAtoms entry with no role-word flags at all resolves via the ordinary alias cascade, unflagged", () => {
    const m = msg("Annissa's father is not well.");
    appendExtraction(m.id, {
      entities: [{ name: "Annissa", type: "person" }],
      // No fromNameIsRoleWord/toNameIsRoleWord at all — simulates a payload cached before v5.
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Annissa", action: "assert" }]
    });
    rebuild();

    const fathers = entityNamed("father");
    expect(fathers).toHaveLength(1);
    expect(fathers[0]!.name_kind ?? null).toBeNull();
    expect(fathers[0]!.owner_entity_id ?? null).toBeNull();
    // Ordinary cascade behavior preserved: a plain alias was registered, findable the normal way.
    expect(projections.findEntityIdByExactAlias(PRIMARY_USER_ID, "father")).toBe(fathers[0]!.id);
  });
});

describe("circleBack.ts: name-clarification pool widens to include role-word placeholders", () => {
  it("a role-word entity established via a structural atom IS eligible, unlike an ordinary established entity", () => {
    const m = msg("Annissa's father is not well.");
    appendExtraction(m.id, {
      entities: [{ name: "Annissa", type: "person" }],
      structuralAtoms: [{ type: "parent_of", fromName: "father", toName: "Annissa", action: "assert", explicitlyNewPerson: false, fromNameIsRoleWord: true, toNameIsRoleWord: false }]
    });
    rebuild();

    const candidates = findEligibleCircleBackCandidates(eventLog, projections, PRIMARY_USER_ID, "just a regular update");
    expect(candidates.map((c) => c.name)).toContain("father");
  });
});

describe("elicitation.ts: findLayer3Candidate tightens to exclude role-word placeholders", () => {
  it("a role-word entity established ONLY via a social bond (no structural atom) is still excluded — hasStructuralAtom alone would not catch this", () => {
    const id = newId();
    const m = msg("My mentor gave me good advice.");
    projections.insertEntity({
      id,
      user_id: PRIMARY_USER_ID,
      name: "mentor",
      confirmed: 0,
      source_event_ids: JSON.stringify([m.id]),
      extractor_version: "message-v5",
      pending_disambiguation: null,
      name_kind: "role_word",
      owner_entity_id: primaryEntityId(PRIMARY_USER_ID),
      created_at: new Date().toISOString()
    });
    projections.insertSocialBond({
      id: newId(),
      user_id: PRIMARY_USER_ID,
      type: "mentor_of",
      from_entity_id: primaryEntityId(PRIMARY_USER_ID),
      to_entity_id: id,
      qualifier: null,
      opened_basis: "stated",
      interval_start: null,
      interval_end: null,
      source_event_ids: "[]",
      created_at: new Date().toISOString()
    });

    const candidate = findLayer3Candidate(eventLog, projections, PRIMARY_USER_ID);
    expect(candidate).toBeNull();
  });
});

describe("retrievalInvocation.ts: findAllMentionedEntityIds excludes role-word placeholders from the dossier pool", () => {
  it("a role-word entity is never returned even when an alias row exists for it (defense in depth, not just incidental non-registration)", () => {
    const id = newId();
    projections.insertEntity({
      id,
      user_id: PRIMARY_USER_ID,
      name: "father",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "message-v5",
      pending_disambiguation: null,
      name_kind: "role_word",
      owner_entity_id: null,
      created_at: new Date().toISOString()
    });
    projections.insertEntityAlias({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: id, alias: "father", source_event_ids: "[]", created_at: new Date().toISOString() });

    const ids = findAllMentionedEntityIds("tell me about father", projections, PRIMARY_USER_ID, 5);
    expect(ids).not.toContain(id);
  });

  it("an ordinary named entity with the same alias shape is still found — the filter is scoped to role words only", () => {
    const id = newId();
    projections.insertEntity({
      id,
      user_id: PRIMARY_USER_ID,
      name: "Marcus",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "message-v5",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    projections.insertEntityAlias({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: id, alias: "Marcus", source_event_ids: "[]", created_at: new Date().toISOString() });

    const ids = findAllMentionedEntityIds("tell me about Marcus", projections, PRIMARY_USER_ID, 5);
    expect(ids).toContain(id);
  });
});

describe("entityDirectory.ts (admin view): role-word placeholders are NOT excluded, and surface name_kind/owner", () => {
  it("a role-word entity appears in the directory with nameKind and ownerEntityId visible", () => {
    const owner = newId();
    projections.insertEntity({
      id: owner,
      user_id: PRIMARY_USER_ID,
      name: "Annissa",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "message-v5",
      pending_disambiguation: null,
      created_at: new Date().toISOString()
    });
    const placeholder = newId();
    projections.insertEntity({
      id: placeholder,
      user_id: PRIMARY_USER_ID,
      name: "father",
      confirmed: 0,
      source_event_ids: "[]",
      extractor_version: "message-v5",
      pending_disambiguation: null,
      name_kind: "role_word",
      owner_entity_id: owner,
      created_at: new Date().toISOString()
    });

    const directory = computeEntityDirectory(projections, PRIMARY_USER_ID, new Map(), new Date().toISOString());
    const entry = directory.find((e) => e.entityId === placeholder);
    expect(entry).toBeDefined();
    expect(entry!.nameKind).toBe("role_word");
    expect(entry!.ownerEntityId).toBe(owner);

    const ordinary = directory.find((e) => e.entityId === owner)!;
    expect(ordinary.nameKind).toBeNull();
  });
});
