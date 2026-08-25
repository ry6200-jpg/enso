import { describe, expect, it } from "vitest";
import { ProjectionsDb } from "../src/projections/db.js";
import { ATTRIBUTE_TYPES } from "../src/projections/attributeVocabulary.js";
import { ATTRIBUTE_MUTABILITY } from "../src/perception/attributes.js";
import { TAXONOMY_JSON_SCHEMA } from "../src/providers/taxonomySchema.js";
import { ROUTER_JSON_SCHEMA } from "../src/conversation/router/routerSchema.js";
import { computeFillRates } from "../src/admin/entityDirectory.js";
import { newId } from "../src/ids.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { primaryEntityId } from "../src/projections/rebuild.js";

/**
 * EN-113: proves the attribute vocabulary has exactly ONE source of truth
 * (attributeVocabulary.ts's ATTRIBUTE_TYPES) rather than the ~13
 * hand-copied sites that blocked seven separately stated requirements
 * before this existed. Every check below is derived FROM ATTRIBUTE_TYPES,
 * never independently hand-typed — so a future edit that adds an eighth
 * value in exactly one place (ATTRIBUTE_TYPES, plus a mutability decision
 * in ATTRIBUTE_MUTABILITY — see that map's own doc comment for why that
 * second step stays separate) makes every one of these pass without
 * further edits, and a site that regresses to hand-typing its own list
 * again fails immediately here.
 */
describe("Attribute vocabulary — single source of truth (EN-113)", () => {
  it("the CHECK constraint accepts every current attribute type", () => {
    const projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    for (const attribute of ATTRIBUTE_TYPES) {
      expect(() =>
        projections.insertEntityAttribute({
          id: newId(),
          user_id: PRIMARY_USER_ID,
          entity_id: entityId,
          attribute,
          value: "test value",
          source_event_ids: "[]",
          created_at: new Date().toISOString()
        })
      ).not.toThrow();
    }
  });

  it("the CHECK constraint rejects a value outside the vocabulary", () => {
    const projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
    const entityId = primaryEntityId(PRIMARY_USER_ID);
    expect(() =>
      projections.insertEntityAttribute({
        id: newId(),
        user_id: PRIMARY_USER_ID,
        entity_id: entityId,
        // @ts-expect-error deliberately outside the vocabulary
        attribute: "not_a_real_attribute",
        value: "x",
        source_event_ids: "[]",
        created_at: new Date().toISOString()
      })
    ).toThrow();
  });

  it("ATTRIBUTE_MUTABILITY covers exactly the current vocabulary, no more, no less", () => {
    expect(Object.keys(ATTRIBUTE_MUTABILITY).sort()).toEqual([...ATTRIBUTE_TYPES].sort());
  });

  it("the extraction JSON Schema's attribute enum matches the vocabulary exactly", () => {
    expect(TAXONOMY_JSON_SCHEMA.properties.attributes.items.properties.attribute.enum).toEqual([...ATTRIBUTE_TYPES]);
  });

  it("the router's attestation JSON Schema enum matches the vocabulary plus null", () => {
    expect(ROUTER_JSON_SCHEMA.properties.attestation.properties.attribute.enum).toEqual([...ATTRIBUTE_TYPES, null]);
  });

  it("computeFillRates reports a rate for exactly the current vocabulary", () => {
    const projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
    const rates = computeFillRates(projections, PRIMARY_USER_ID);
    const { totalEntities: _totalEntities, ...perAttribute } = rates;
    expect(Object.keys(perAttribute).sort()).toEqual([...ATTRIBUTE_TYPES].sort());
  });
});
