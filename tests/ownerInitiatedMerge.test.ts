import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import type { EntityAliasRow, EntityAttributeRow, EntityRow, SocialBondRow, StructuralAtomRow } from "../src/projections/db.js";
import type { ReplySentPayload } from "../src/conversation/chatPipeline.js";
import {
  buildAmbiguousMergeDirective,
  buildMergeProposalDirective,
  buildUnresolvableMergeDirective,
  findPendingMergeProposal,
  proposeSurvivor,
  resolveMergeName,
  resolveMergeRequest,
  verifyMergeProposalExecuted,
  type PendingMergeProposal
} from "../src/relationships/ownerInitiatedMerge.js";

function entity(name: string, opts: { id?: string; sourceEventIds?: string[] } = {}): EntityRow {
  return {
    id: opts.id ?? name,
    user_id: PRIMARY_USER_ID,
    name,
    confirmed: 0,
    source_event_ids: JSON.stringify(opts.sourceEventIds ?? [`01AAA${name}`]),
    extractor_version: "message-v7",
    pending_disambiguation: null,
    created_at: new Date().toISOString()
  };
}

function alias(entityId: string, aliasText: string): EntityAliasRow {
  return { id: `alias-${entityId}-${aliasText}`, user_id: PRIMARY_USER_ID, entity_id: entityId, alias: aliasText, source_event_ids: "[]", created_at: new Date().toISOString() };
}

describe("resolveMergeName", () => {
  const anSong = entity("An Song", { sourceEventIds: ["01A"] });
  const alice = entity("Alice Yap", { sourceEventIds: ["01B"] });
  const entities = [anSong, alice];
  const aliases: EntityAliasRow[] = [alias(anSong.id, "Uncle An")];

  it("resolves via exact name", () => {
    expect(resolveMergeName("An Song", entities, aliases)).toEqual({ outcome: "resolved", entity: anSong });
  });

  it("resolves via a registered alias", () => {
    expect(resolveMergeName("Uncle An", entities, aliases)).toEqual({ outcome: "resolved", entity: anSong });
  });

  it("is unresolved when nothing matches", () => {
    expect(resolveMergeName("Nobody Real", entities, aliases)).toEqual({ outcome: "unresolved" });
  });

  it("is ambiguous when more than one entity shares the name", () => {
    const first = entity("Ah Song", { id: "e1", sourceEventIds: ["01C"] });
    const second = entity("Ah Song", { id: "e2", sourceEventIds: ["01D"] });
    const result = resolveMergeName("Ah Song", [first, second], []);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") expect(result.matches.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });
});

describe("proposeSurvivor — deterministic 'more established history' rule", () => {
  it("proposes the entity with more bonds+attributes+mentions", () => {
    const anSong = entity("An Song", { id: "an", sourceEventIds: ["01A", "01B"] }); // 2 mentions
    const ahSong = entity("Ah Song", { id: "ah", sourceEventIds: ["01C"] }); // 1 mention
    const structuralAtoms: StructuralAtomRow[] = [
      { id: "atom1", user_id: PRIMARY_USER_ID, type: "spouse_of", from_entity_id: "an", to_entity_id: "alice", basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: "" },
      { id: "atom2", user_id: PRIMARY_USER_ID, type: "parent_of", from_entity_id: "an", to_entity_id: "kid1", basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: "" }
    ];
    const socialBonds: SocialBondRow[] = [];
    const attributes: EntityAttributeRow[] = [{ id: "attr1", user_id: PRIMARY_USER_ID, entity_id: "ah", attribute: "life_stage", value: "elderly", source_event_ids: "[]", created_at: "" }];

    const { survivor, losing } = proposeSurvivor(anSong, ahSong, structuralAtoms, socialBonds, attributes);
    // an: 2 bonds + 0 attrs + 2 mentions = 4. ah: 0 bonds + 1 attr + 1 mention = 2.
    expect(survivor.id).toBe("an");
    expect(losing.id).toBe("ah");
  });

  it("breaks a tie by earliest stable key", () => {
    const earlier = entity("Earlier", { id: "e1", sourceEventIds: ["01AAA"] });
    const later = entity("Later", { id: "e2", sourceEventIds: ["01ZZZ"] });
    const { survivor } = proposeSurvivor(later, earlier, [], [], []); // pass in reverse order — result must not depend on argument order
    expect(survivor.id).toBe("e1");
  });
});

describe("resolveMergeRequest", () => {
  const anSong = entity("An Song", { id: "an", sourceEventIds: ["01A"] });
  const ahSong = entity("Ah Song", { id: "ah", sourceEventIds: ["01B"] });
  const entities = [anSong, ahSong];

  it("a clean merge end to end: survivor stated outright resolves to 'confirmed', payload carries aliasSuppressed false", () => {
    const result = resolveMergeRequest("Ah Song", "An Song", "An Song", entities, [], [], [], []);
    expect(result.outcome).toBe("confirmed");
    if (result.outcome !== "confirmed") return;
    expect(result.payload).toEqual({
      kind: "coReference",
      placeholderStableKey: "01B",
      placeholderName: "Ah Song",
      realStableKey: "01A",
      realName: "An Song",
      anchorName: "",
      aliasSuppressed: false
    });
  });

  it("unresolvable name: reports the outcome and would produce a directive that names nobody was created", () => {
    const result = resolveMergeRequest("Nobody Real", "An Song", null, entities, [], [], [], []);
    expect(result).toEqual({ outcome: "unresolvable", name: "Nobody Real" });
    const directive = buildUnresolvableMergeDirective("Nobody Real");
    expect(directive).toContain("nobody by that name");
    expect(directive).toContain("Nobody Real");
  });

  it("ambiguous name: reports both matches, never guesses", () => {
    const dup1 = entity("Ah Song", { id: "d1", sourceEventIds: ["01X"] });
    const dup2 = entity("Ah Song", { id: "d2", sourceEventIds: ["01Y"] });
    const result = resolveMergeRequest("Ah Song", "An Song", null, [dup1, dup2, anSong], [], [], [], []);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") return;
    expect(result.name).toBe("Ah Song");
    expect(result.matchNames).toEqual(["Ah Song", "Ah Song"]);
    const directive = buildAmbiguousMergeDirective(result.name, result.matchNames);
    expect(directive).toContain("ask");
  });

  it("already the same entity: no proposal, no confirmation", () => {
    const result = resolveMergeRequest("An Song", "An Song", null, entities, [], [], [], []);
    expect(result).toEqual({ outcome: "alreadySame" });
  });

  describe("propose-and-confirm", () => {
    // ahSong has strictly more established history than anSong here, so it's the deterministic proposal.
    const structuralAtoms: StructuralAtomRow[] = [
      { id: "a1", user_id: PRIMARY_USER_ID, type: "spouse_of", from_entity_id: "ah", to_entity_id: "alice", basis: "stated", interval_start: null, interval_end: null, source_event_ids: "[]", created_at: "" }
    ];

    it("no survivor stated: proposes the more-established name rather than asking an open question", () => {
      const result = resolveMergeRequest("An Song", "Ah Song", null, entities, [], structuralAtoms, [], []);
      expect(result.outcome).toBe("propose");
      if (result.outcome !== "propose") return;
      expect(result.proposal.proposedSurvivorName).toBe("Ah Song");
      expect(result.proposal.losingName).toBe("An Song");
      const directive = buildMergeProposalDirective(result.proposal.proposedSurvivorName, result.proposal.losingName);
      expect(directive).toMatch(/That's Ah Song, right\?|So it's Ah Song/);
      expect(directive).toContain("An Song");
    });

    it("the owner agrees: survivingName equal to the proposed name resolves to 'confirmed' with that entity as survivor", () => {
      // Simulates the router, seeing the pending proposal, filling survivingName with the proposed name for a plain "yes".
      const result = resolveMergeRequest("An Song", "Ah Song", "Ah Song", entities, [], structuralAtoms, [], []);
      expect(result.outcome).toBe("confirmed");
      if (result.outcome !== "confirmed") return;
      expect(result.payload.realName).toBe("Ah Song");
      expect(result.payload.placeholderName).toBe("An Song");
      expect(result.payload.aliasSuppressed).toBe(false);
    });

    it("the owner names the other one instead: survivingName equal to the OTHER name resolves to 'confirmed' with that one as survivor", () => {
      // Simulates the router recognizing a correction ("no, it's An Song").
      const result = resolveMergeRequest("An Song", "Ah Song", "An Song", entities, [], structuralAtoms, [], []);
      expect(result.outcome).toBe("confirmed");
      if (result.outcome !== "confirmed") return;
      expect(result.payload.realName).toBe("An Song");
      expect(result.payload.placeholderName).toBe("Ah Song");
      expect(result.payload.aliasSuppressed).toBe(false);
    });
  });
});

describe("verifyMergeProposalExecuted", () => {
  it("true when the survivor name appears in the reply, whether or not the losing name is also mentioned", () => {
    expect(verifyMergeProposalExecuted("An Song", "That's An Song, right? Not Ah Song?")).toBe(true);
    // Live-test-caught false negative (real failure, real corpus wording):
    // natural confirmation phrasing that omits the name being replaced —
    // this must now verify, not just the two-name form above.
    expect(verifyMergeProposalExecuted("An Song", "An Song is the name you use, right?")).toBe(true);
  });

  it("false when the survivor name is never mentioned at all", () => {
    expect(verifyMergeProposalExecuted("An Song", "Got it, noted.")).toBe(false);
  });
});

describe("findPendingMergeProposal", () => {
  let eventLog: EventLog;

  function makeProposal(): PendingMergeProposal {
    return { firstStableKey: "01A", firstName: "An Song", secondStableKey: "01B", secondName: "Ah Song", proposedSurvivorStableKey: "01B", proposedSurvivorName: "Ah Song", losingStableKey: "01A", losingName: "An Song" };
  }

  function appendReplyWithProposal(proposal: PendingMergeProposal | null) {
    const payload: Partial<ReplySentPayload> = {
      gateActions: {
        circleBackFired: null,
        attestationConfirmedEventId: null,
        selfBirthdateAskFired: false,
        selfFactAskFired: null,
        connectDotFired: false,
        elicitationFired: null,
        coReferenceAskFired: null,
        coReferenceAnswerEventId: null,
        mergeProposalFired: proposal,
        mergeAnswerEventId: null,
        typoMergeAskFired: null,
        typoMergeAnswerEventId: null,
        relationshipRetractionEventId: null
      }
    };
    return eventLog.append({ type: "reply_sent", actor: "enso", payload, userId: PRIMARY_USER_ID });
  }

  it("returns null when nothing is pending", () => {
    eventLog = new EventLog(freshTestDbPath(import.meta.url, "events-none"));
    expect(findPendingMergeProposal(eventLog, PRIMARY_USER_ID)).toBeNull();
  });

  it("returns the latest proposal still awaiting an answer", () => {
    eventLog = new EventLog(freshTestDbPath(import.meta.url, "events-pending"));
    appendReplyWithProposal(makeProposal());
    expect(findPendingMergeProposal(eventLog, PRIMARY_USER_ID)).toEqual(makeProposal());
  });

  it("excludes a proposal already resolved by a coReference confirmation for the same pair", () => {
    eventLog = new EventLog(freshTestDbPath(import.meta.url, "events-resolved"));
    appendReplyWithProposal(makeProposal());
    eventLog.append({
      type: "fact_confirmed",
      actor: "user",
      payload: { kind: "coReference", placeholderStableKey: "01A", placeholderName: "An Song", realStableKey: "01B", realName: "Ah Song", anchorName: "", aliasSuppressed: false },
      userId: PRIMARY_USER_ID
    });
    expect(findPendingMergeProposal(eventLog, PRIMARY_USER_ID)).toBeNull();
  });
});
