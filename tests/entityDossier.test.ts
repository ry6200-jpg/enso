import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { primaryEntityId } from "../src/projections/rebuild.js";
import { buildEntityDossier, MAX_RELATIONSHIPS_PER_ENTITY_DOSSIER, type EntityDossier } from "../src/projections/peopleView.js";
import { buildEntityDossierBlock } from "../src/persona/systemPrompt.js";
import { findAllMentionedEntityIds } from "../src/conversation/retrievalInvocation.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

let projections: ProjectionsDb;
const primary = primaryEntityId(PRIMARY_USER_ID);

beforeEach(() => {
  projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
});

function entity(id: string, name: string) {
  projections.insertEntity({ id, user_id: PRIMARY_USER_ID, name, confirmed: 1, source_event_ids: "[]", extractor_version: "v1", pending_disambiguation: null, created_at: new Date().toISOString() });
  projections.insertEntityAlias({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: id, alias: name, source_event_ids: "[]", created_at: new Date().toISOString() });
}

function attr(entityId: string, attribute: "birthdate" | "location" | "occupation", value: string) {
  projections.insertEntityAttribute({ id: newId(), user_id: PRIMARY_USER_ID, entity_id: entityId, attribute, value, source_event_ids: "[]", created_at: new Date().toISOString() });
}

describe("findAllMentionedEntityIds (Part D, R40) — direct name match, reusing the entity-mode primitive", () => {
  it("finds a known entity named in the message", () => {
    const elenaId = newId();
    entity(elenaId, "Elena");
    expect(findAllMentionedEntityIds("How is Elena doing?", projections, PRIMARY_USER_ID, 3)).toEqual([elenaId]);
  });

  it("finds multiple distinct entities named in the same message, left to right", () => {
    const elenaId = newId();
    const marcusId = newId();
    entity(elenaId, "Elena");
    entity(marcusId, "Marcus");
    expect(findAllMentionedEntityIds("Elena and Marcus came over.", projections, PRIMARY_USER_ID, 3)).toEqual([elenaId, marcusId]);
  });

  it("caps at maxEntities even when more are named", () => {
    const ids = ["Elena", "Marcus", "Karen", "Vicki"].map((name) => {
      const id = newId();
      entity(id, name);
      return id;
    });
    const result = findAllMentionedEntityIds("Elena, Marcus, Karen, and Vicki were all there.", projections, PRIMARY_USER_ID, 2);
    expect(result).toEqual(ids.slice(0, 2));
  });

  it("never matches an unknown name — no entity, no entry", () => {
    expect(findAllMentionedEntityIds("Someone named Zephyr called.", projections, PRIMARY_USER_ID, 3)).toEqual([]);
  });

  it("deduplicates a name mentioned twice in the same message", () => {
    const elenaId = newId();
    entity(elenaId, "Elena");
    expect(findAllMentionedEntityIds("Elena said Elena would come.", projections, PRIMARY_USER_ID, 3)).toEqual([elenaId]);
  });
});

describe("buildEntityDossier (Part D, R40) — direct injection, no search or ranking", () => {
  it("returns null for an unknown/deleted entity id rather than throwing", () => {
    expect(buildEntityDossier(projections, PRIMARY_USER_ID, "no-such-entity")).toBeNull();
  });

  it("resolves attributes through Part A's shared resolver — same conflict handling as self-profile", () => {
    const elenaId = newId();
    entity(elenaId, "Elena");
    attr(elenaId, "birthdate", "1990-05-12");
    attr(elenaId, "birthdate", "1991"); // a conflicting later assertion, same shape as R37's real bug

    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, elenaId)!;
    expect(dossier.name).toBe("Elena");
    expect(dossier.attributes).toEqual([{ attribute: "birthdate", value: "1990-05-12", conflictingValues: ["1991"] }]);
  });

  it("reports this entity's direct relationship TO THE OWNER, labeled from the owner's side", () => {
    const motherId = newId();
    entity(motherId, "Mom");
    projections.insertStructuralAtom({ id: newId(), user_id: PRIMARY_USER_ID, type: "parent_of", from_entity_id: motherId, to_entity_id: primary, basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, motherId)!;
    expect(dossier.relationshipsToOwner).toEqual(["parent"]);
  });

  it("caps relationships at MAX_RELATIONSHIPS_PER_ENTITY_DOSSIER", () => {
    const friendId = newId();
    entity(friendId, "Sam");
    // Same pair, several concurrently-open bond types — accretion is a real, documented pattern for social_bonds.
    for (const type of ["friend", "colleague", "neighbor", "classmate", "romantic", "mentor_of"] as const) {
      projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type, from_entity_id: primary, to_entity_id: friendId, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });
    }

    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, friendId)!;
    expect(dossier.relationshipsToOwner.length).toBe(MAX_RELATIONSHIPS_PER_ENTITY_DOSSIER);
  });

  it("excludes a CLOSED relationship — history, not a current fact", () => {
    const exId = newId();
    entity(exId, "Sam");
    projections.insertStructuralAtom({ id: newId(), user_id: PRIMARY_USER_ID, type: "spouse_of", from_entity_id: primary, to_entity_id: exId, basis: "stated", interval_start: null, interval_end: "2024-01-01", source_event_ids: "[]", created_at: new Date().toISOString() });

    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, exId)!;
    expect(dossier.relationshipsToOwner).toEqual([]);
  });

  it("never includes a third party's relationship to ANOTHER third party — only to the owner", () => {
    const aId = newId();
    const bId = newId();
    entity(aId, "Vicki");
    entity(bId, "Karen");
    projections.insertSocialBond({ id: newId(), user_id: PRIMARY_USER_ID, type: "friend", from_entity_id: aId, to_entity_id: bId, qualifier: null, opened_basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: new Date().toISOString() });

    const dossier = buildEntityDossier(projections, PRIMARY_USER_ID, aId)!;
    expect(dossier.relationshipsToOwner).toEqual([]);
  });
});

describe("buildEntityDossierBlock (Part D, R40) — pure formatting, DATA not instructions", () => {
  it("returns null for an empty list", () => {
    expect(buildEntityDossierBlock([])).toBeNull();
  });

  it("returns null when every dossier has nothing to show", () => {
    const empty: EntityDossier = { entityId: "e1", name: "Elena", attributes: [], relationshipsToOwner: [] };
    expect(buildEntityDossierBlock([empty])).toBeNull();
  });

  it("renders name, attributes, and relationship as plain labeled data", () => {
    const dossier: EntityDossier = { entityId: "e1", name: "Elena", attributes: [{ attribute: "location", value: "Seattle", conflictingValues: [] }], relationshipsToOwner: ["friend"] };
    const block = buildEntityDossierBlock([dossier]);
    expect(block).toContain("=== NAMED PEOPLE (begin) ===");
    expect(block).toContain("Elena");
    expect(block).toContain("Location: Seattle");
    expect(block).toContain("Relationship to owner: friend");
  });

  it("renders a conflict as two disagreeing facts, no directive language", () => {
    const dossier: EntityDossier = { entityId: "e1", name: "Elena", attributes: [{ attribute: "birthdate", value: "1990-05-12", conflictingValues: ["1991"] }], relationshipsToOwner: [] };
    const block = buildEntityDossierBlock([dossier])!;
    expect(block).toContain("1990-05-12");
    expect(block).toContain('"1991"');
    expect(block).not.toMatch(/\b(ask|consider|resolve|clarify|should|must|never|always)\b/i);
  });

  it("multiple dossiers each get their own line", () => {
    const a: EntityDossier = { entityId: "e1", name: "Elena", attributes: [], relationshipsToOwner: ["friend"] };
    const b: EntityDossier = { entityId: "e2", name: "Marcus", attributes: [], relationshipsToOwner: ["colleague"] };
    const block = buildEntityDossierBlock([a, b])!;
    expect(block).toContain("Elena");
    expect(block).toContain("Marcus");
  });
});
