import { describe, expect, it } from "vitest";
import { buildExtractionSystemPrompt } from "../src/providers/taxonomySchema.js";

describe("buildExtractionSystemPrompt (item 7: preceding-reply context)", () => {
  it("omits the preceding-reply block when none is given", () => {
    const prompt = buildExtractionSystemPrompt("2026-08-21", []);
    expect(prompt).not.toContain("Immediately before this message");
  });

  it("includes Enso's preceding reply, verbatim, when given", () => {
    const prompt = buildExtractionSystemPrompt("2026-08-21", [], "I'd love to. When is it?");
    expect(prompt).toContain("Immediately before this message, Enso itself said");
    expect(prompt).toContain("I'd love to. When is it?");
  });

  it("instructs extracting only from the user's own message, never inventing from Enso's line", () => {
    const prompt = buildExtractionSystemPrompt("2026-08-21", [], "When is it?");
    expect(prompt).toMatch(/extract exclusively from what THIS message itself asserts/);
  });
});

describe("buildExtractionSystemPrompt (item 10: self-naming is never a third-party entity)", () => {
  it("explicitly calls out answering 'what should I call you?' as the author, not a mentioned person", () => {
    const prompt = buildExtractionSystemPrompt("2026-08-21", []);
    expect(prompt).toMatch(/answering "what should I call you\?"/);
  });
});
