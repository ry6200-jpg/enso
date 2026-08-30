import { describe, expect, it } from "vitest";
import { buildPersonaBlock, buildRecentWindowBlock, buildSystemPrompt, type RecentTurnForPrompt } from "../src/persona/systemPrompt.js";

const RECENT_CONVERSATION_END = "=== RECENT CONVERSATION (end) ===";

/**
 * Task 2 Step B: proves the actual caching claim — that GROUP A (persona,
 * self-profile) and GROUP B (recent conversation, append-only) form a
 * literal byte-identical-or-growing-only prefix of the assembled prompt
 * across two consecutive turns, even when GROUP C (retrieved memory here,
 * standing in for "the newest message" — see the note below) differs
 * completely between them. This is the exact property OpenAI's automatic
 * prefix-matching cache depends on: the longest prefix two requests share
 * byte-for-byte is what gets reused.
 *
 * NOTE on "the newest message": buildSystemPrompt has no parameter for it
 * at all — chatPipeline.ts passes it as `latestMessage`, a field entirely
 * separate from the system-prompt string (see Step A's report). What
 * changes turn to turn INSIDE the system string as a direct result of the
 * newest message is (a) recentWindowBlock, which grows by exactly the
 * prior turn's own exchange, and (b) retrievedBlock, whose query is the
 * newest message's own text. Both are modeled below: turn 2's recent
 * window is turn 1's turns plus two more appended (simulating the session
 * advancing by one real turn), and turn 2's retrievedBlock is
 * deliberately a completely different string (simulating a different
 * retrieval result for a different message).
 */
describe("buildSystemPrompt (Task 2 Step B): GROUP A+B prefix is byte-stable across consecutive turns", () => {
  it("the persona + self-profile + prior-conversation prefix is IDENTICAL across two consecutive turns, even though retrieved memory is completely different and the conversation window has grown", () => {
    const selfProfileBlock = "=== OWNER PROFILE (begin) ===\nLocation: Seattle\n=== OWNER PROFILE (end) ===";

    const turn1Turns: RecentTurnForPrompt[] = [
      { role: "user", text: "Hey, how's it going?" },
      { role: "enso", text: "Good, just here. What's on your mind?" }
    ];
    const turn2Turns: RecentTurnForPrompt[] = [
      ...turn1Turns,
      { role: "user", text: "Actually I wanted to talk about my sister." }, // the "newest message" from turn 1's perspective
      { role: "enso", text: "Sure — what's going on with her?" }
    ];

    const recentWindow1 = buildRecentWindowBlock(turn1Turns);
    const recentWindow2 = buildRecentWindowBlock(turn2Turns);

    const prompt1 = buildSystemPrompt(
      "=== RETRIEVED MEMORY (begin) ===\nSomething about a childhood trip.\n=== RETRIEVED MEMORY (end) ===",
      recentWindow1,
      null,
      "natural",
      selfProfileBlock
    );
    const prompt2 = buildSystemPrompt(
      "=== RETRIEVED MEMORY (begin) ===\nA completely unrelated memory about a work project.\n=== RETRIEVED MEMORY (end) ===",
      recentWindow2,
      null,
      "natural",
      selfProfileBlock
    );

    // The expected shared prefix, constructed independently of either assembled prompt:
    // GROUP A (persona + self-profile) plus GROUP B's opening through everything
    // that was already present in turn 1's own conversation window (i.e. everything
    // except recentWindow1's own closing tag, which moves later once turn 2 appends to it).
    const recentWindow1WithoutClosingTag = recentWindow1.slice(0, recentWindow1.lastIndexOf(RECENT_CONVERSATION_END));
    const expectedStablePrefix = [buildPersonaBlock("natural"), selfProfileBlock].join("\n\n") + "\n\n" + recentWindow1WithoutClosingTag;

    expect(prompt1.startsWith(expectedStablePrefix)).toBe(true);
    expect(prompt2.startsWith(expectedStablePrefix)).toBe(true);

    // And the two full prompts are NOT identical overall — retrieved memory genuinely differs.
    expect(prompt1).not.toBe(prompt2);
  });

  it("GROUP C ordering: date/location/ambient/entity-dossier/retrieved/attachment all land AFTER recent conversation, never before it", () => {
    const recentWindow = buildRecentWindowBlock([{ role: "user", text: "hi" }]);
    const prompt = buildSystemPrompt(
      "=== RETRIEVED MEMORY (begin) ===\nx\n=== RETRIEVED MEMORY (end) ===",
      recentWindow,
      "=== JUST SHARED (begin) ===\nx\n=== JUST SHARED (end) ===",
      "natural",
      null,
      "=== NAMED PEOPLE (begin) ===\nx\n=== NAMED PEOPLE (end) ===",
      "=== CURRENT CONTEXT (begin) ===\nx\n=== CURRENT CONTEXT (end) ===",
      "=== CURRENT DATE (begin) ===\nx\n=== CURRENT DATE (end) ===",
      "=== AMBIENT CONTEXT (begin) ===\nx\n=== AMBIENT CONTEXT (end) ==="
    );

    const recentConvIndex = prompt.indexOf(RECENT_CONVERSATION_END);
    for (const marker of [
      "=== CURRENT DATE (begin) ===",
      "=== CURRENT CONTEXT (begin) ===",
      "=== AMBIENT CONTEXT (begin) ===",
      "=== NAMED PEOPLE (begin) ===",
      "=== RETRIEVED MEMORY (begin) ===",
      "=== JUST SHARED (begin) ==="
    ]) {
      expect(prompt.indexOf(marker)).toBeGreaterThan(recentConvIndex);
    }
  });
});
