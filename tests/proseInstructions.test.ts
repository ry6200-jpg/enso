import { describe, expect, it } from "vitest";
import { ANTI_SYCOPHANCY_INSTRUCTION as CHAT_ANTI_SYCOPHANCY_INSTRUCTION } from "../src/persona/instructions.js";
import {
  ANTI_SYCOPHANCY_INSTRUCTION,
  REPORT_CONSTRAINTS_INSTRUCTION,
  REPORT_HONESTY_INSTRUCTION,
  REPORT_MECHANICS_INSTRUCTION,
  REPORT_NUMBERS_INSTRUCTION,
  REPORT_VOICE_AND_PURPOSE_INSTRUCTION
} from "../src/report/proseInstructions.js";

describe("Report prose instruction set (EN-120): exactly three things reused from chat, nothing else", () => {
  it("ANTI_SYCOPHANCY_INSTRUCTION is re-exported verbatim — the same reference, never a copy that could drift", () => {
    expect(ANTI_SYCOPHANCY_INSTRUCTION).toBe(CHAT_ANTI_SYCOPHANCY_INSTRUCTION);
  });

  it("REPORT_NUMBERS_INSTRUCTION: numbers are the reason a passage exists, never its content — the hard rule this whole item's gate depends on", () => {
    expect(REPORT_NUMBERS_INSTRUCTION).toMatch(/NUMBERS ARE THE REASON A PASSAGE EXISTS, NEVER ITS CONTENT/);
    expect(REPORT_NUMBERS_INSTRUCTION).toMatch(/If a passage would collapse into nothing once any number is removed/);
    // The exact banned metric-synonym list from the build prompt.
    for (const word of ["concentration", "turnover", "density", "diversity", "burstiness", "deviation", "baseline"]) {
      expect(REPORT_NUMBERS_INSTRUCTION.toLowerCase()).toContain(word);
    }
    expect(REPORT_NUMBERS_INSTRUCTION).toMatch(/Your active tie count rose this week/);
    expect(REPORT_NUMBERS_INSTRUCTION).toMatch(/is not a fix on prior attempts, it is the same dashboard-of-metrics fault with better grammar/);
  });

  it("REPORT_HONESTY_INSTRUCTION: adapted memory honesty — assert only what's supported, quote in the owner's own words, never a plausible reconstruction", () => {
    expect(REPORT_HONESTY_INSTRUCTION).toMatch(/ASSERT ONLY WHAT THE SOURCE MESSAGES ACTUALLY SUPPORT/);
    expect(REPORT_HONESTY_INSTRUCTION).toMatch(/QUOTE OR CLOSELY PARAPHRASE THE OWNER'S OWN WORDS/);
    expect(REPORT_HONESTY_INSTRUCTION).toMatch(/NEVER A PLAUSIBLE RECONSTRUCTION/);
  });

  it("REPORT_MECHANICS_INSTRUCTION: never lets the machinery show, weighted more heavily than chat's version since this was the rejected page's whole fault", () => {
    expect(REPORT_MECHANICS_INSTRUCTION).toMatch(/NEVER LET THE MACHINERY SHOW/);
    expect(REPORT_MECHANICS_INSTRUCTION).toMatch(/the data shows.*analysis reveals.*the pattern indicates/);
    expect(REPORT_MECHANICS_INSTRUCTION).toMatch(/Never name a therapeutic framework, a research method, a coding scheme/);
  });

  it("REPORT_VOICE_AND_PURPOSE_INSTRUCTION: never claims to be, replace, or resemble therapy", () => {
    expect(REPORT_VOICE_AND_PURPOSE_INSTRUCTION).toMatch(/never presented as therapy, never claims to replace it, and never uses the word/);
    expect(REPORT_VOICE_AND_PURPOSE_INSTRUCTION).toMatch(/total recall/);
  });

  it("REPORT_CONSTRAINTS_INSTRUCTION: no advice in any shape (including disguised as a question), no verdict on the person, never asserts past the data", () => {
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/NO ADVICE, IN ANY SHAPE/);
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/not disguised as a question/);
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/NO VERDICT ON THE PERSON/);
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/warm validation is a verdict in a gentler coat/);
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/NEVER ASSERT WHAT ISN'T THERE/);
    expect(REPORT_CONSTRAINTS_INSTRUCTION).toMatch(/there is no minimum the page must fill/);
  });

  it("none of the five report-specific instructions mention voice/register/curiosity mechanisms that assume a turn-taking conversation", () => {
    const all = [REPORT_NUMBERS_INSTRUCTION, REPORT_HONESTY_INSTRUCTION, REPORT_MECHANICS_INSTRUCTION, REPORT_VOICE_AND_PURPOSE_INSTRUCTION, REPORT_CONSTRAINTS_INSTRUCTION].join("\n");
    expect(all).not.toMatch(/zen mode|register calibration|circle.?back|curiosity turn/i);
  });
});
