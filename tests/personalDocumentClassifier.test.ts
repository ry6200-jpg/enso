import { describe, expect, it } from "vitest";
import { classifyPersonalVsDocument } from "../src/extraction/personalDocumentClassifier.js";

describe("classifyPersonalVsDocument (EN-060)", () => {
  it("fails open on empty content", () => {
    const decision = classifyPersonalVsDocument("");
    expect(decision.isPersonal).toBe(true);
    expect(decision.reason).toMatch(/empty/i);
  });

  it("classifies an ordinary personal journal message as personal", () => {
    const decision = classifyPersonalVsDocument("I had lunch with Sarah and my sister Amy today, I was really happy.");
    expect(decision.isPersonal).toBe(true);
  });

  it("classifies reference-style structured text with no first-person voice as a document", () => {
    const referenceText = `
Table of Contents
1.1 Introduction
1.2 Background
- Item one in a structured list
- Item two in a structured list
- Item three in a structured list
${"reference filler word ".repeat(80)}
`;
    const decision = classifyPersonalVsDocument(referenceText);
    expect(decision.isPersonal).toBe(false);
    expect(decision.reason).toMatch(/structured|reference/i);
  });

  it("fails open (personal) when signal is ambiguous or short, even without pronouns", () => {
    const decision = classifyPersonalVsDocument("Short note.");
    expect(decision.isPersonal).toBe(true);
  });

  it("always returns a non-empty reason for its decision (auditability)", () => {
    const decision = classifyPersonalVsDocument("Whatever text.");
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
