import { describe, expect, it } from "vitest";
import { decideVoiceMode, hasZenTriggerPhrase } from "../src/conversation/voiceMode.js";

describe("hasZenTriggerPhrase (EN-048 cheap layer)", () => {
  it("recognizes literal trigger phrases, case-insensitively", () => {
    expect(hasZenTriggerPhrase("can we zoom out for a second")).toBe(true);
    expect(hasZenTriggerPhrase("I need to STEP BACK from this")).toBe(true);
    expect(hasZenTriggerPhrase("I'm so overwhelmed right now")).toBe(true);
    expect(hasZenTriggerPhrase("this is all overwhelming")).toBe(true);
  });

  it("returns false for ordinary messages with no trigger phrase", () => {
    expect(hasZenTriggerPhrase("what time is my flight tomorrow")).toBe(false);
    expect(hasZenTriggerPhrase("work has been busy this week")).toBe(false);
  });

  it("does NOT catch genuine overwhelm that never uses the literal word — exactly why the router's real layer exists (R9's failure class)", () => {
    expect(hasZenTriggerPhrase("I don't even know where to start, everything is falling apart at once")).toBe(false);
  });
});

describe("decideVoiceMode (combining the cheap and real layers)", () => {
  it("a literal trigger phrase wins outright, regardless of the router's own judgment", () => {
    expect(decideVoiceMode("let's zoom out here", "natural")).toBe("zen");
  });

  it("defers to the router's judgment when no trigger phrase is present", () => {
    expect(decideVoiceMode("ordinary message", "zen")).toBe("zen");
    expect(decideVoiceMode("ordinary message", "natural")).toBe("natural");
  });

  it("defaults to natural when no router is configured at all (null)", () => {
    expect(decideVoiceMode("ordinary message", null)).toBe("natural");
  });
});
