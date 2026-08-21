import { describe, expect, it } from "vitest";
import { decideRetrievalInvocation, type RetrievalInvocation } from "../src/conversation/retrievalInvocation.js";
import type { ProjectionsDb } from "../src/projections/db.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function fakeProjectionsDb(aliasToEntityId: Record<string, string>): ProjectionsDb {
  return {
    findEntityIdByExactAlias(_userId: string, alias: string): string | undefined {
      return aliasToEntityId[alias.toLowerCase()];
    }
  } as unknown as ProjectionsDb;
}

const NO_ENTITIES = fakeProjectionsDb({});

describe("decideRetrievalInvocation (EN-035, Part 1 heuristic)", () => {
  it("an explicit override wins outright — the heuristic never runs", () => {
    const override: RetrievalInvocation = { mode: "entity", query: "irrelevant", entityId: "e1" };
    const result = decideRetrievalInvocation("catch me up", NO_ENTITIES, PRIMARY_USER_ID, { override });
    expect(result).toBe(override);
  });

  it("defaults to hybrid mode when nothing signals recency or a known entity", () => {
    const result = decideRetrievalInvocation("what's a good gift for someone who loves hiking?", NO_ENTITIES, PRIMARY_USER_ID);
    expect(result).toEqual({ mode: "hybrid", query: "what's a good gift for someone who loves hiking?" });
  });

  it.each(["read me my messages", "what have we talked about", "what did we talk about", "catch me up", "give me a recap"])(
    "routes a recency phrase ('%s') to recency mode with the default N",
    (message) => {
      const result = decideRetrievalInvocation(message, NO_ENTITIES, PRIMARY_USER_ID);
      expect(result.mode).toBe("recency");
      expect(result.n).toBe(10);
      expect(result.query).toBe(message);
    }
  );

  it("routes to entity mode when the message contains a name that resolves to a known alias", () => {
    const projectionsDb = fakeProjectionsDb({ elena: "entity-elena-id" });
    const result = decideRetrievalInvocation("How's Elena doing lately?", projectionsDb, PRIMARY_USER_ID);
    expect(result).toEqual({ mode: "entity", query: "How's Elena doing lately?", entityId: "entity-elena-id" });
  });

  it("does NOT resolve a bare role reference with no name in the text — falls through to hybrid (Phase 6's job, not this heuristic's)", () => {
    const result = decideRetrievalInvocation("how is my mother doing?", NO_ENTITIES, PRIMARY_USER_ID);
    expect(result.mode).toBe("hybrid");
  });

  it("a recency phrase takes priority over an entity mention in the same message", () => {
    const projectionsDb = fakeProjectionsDb({ elena: "entity-elena-id" });
    const result = decideRetrievalInvocation("catch me up on what Elena and I discussed", projectionsDb, PRIMARY_USER_ID);
    expect(result.mode).toBe("recency");
  });

  it("alias matching is case-insensitive but still requires a standalone word match", () => {
    const projectionsDb = fakeProjectionsDb({ elena: "entity-elena-id" });
    const lowercase = decideRetrievalInvocation("saw elena today", projectionsDb, PRIMARY_USER_ID);
    expect(lowercase.mode).toBe("entity");

    // "Elenas" is not the standalone word "Elena" — no exact alias match.
    const notAWholeWord = decideRetrievalInvocation("the Elenas of the world", projectionsDb, PRIMARY_USER_ID);
    expect(notAWholeWord.mode).toBe("hybrid");
  });
});
