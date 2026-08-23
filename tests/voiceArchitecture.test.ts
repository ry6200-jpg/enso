import { describe, expect, it } from "vitest";
import { EN_ZEN_VOICE_INSTRUCTION, NATURAL_VOICE_INSTRUCTION, REGISTER_CALIBRATION_INSTRUCTION, ZEN_MODE_INSTRUCTION } from "../src/persona/instructions.js";
import { buildPersonaBlock } from "../src/persona/systemPrompt.js";

describe("EN-047: EN_ZEN_VOICE_INSTRUCTION is kept, unchanged, for the zodiac sidebar", () => {
  it("still exists with its original body text intact", () => {
    expect(EN_ZEN_VOICE_INSTRUCTION).toMatch(/THE THIRD LAYER/);
    expect(EN_ZEN_VOICE_INSTRUCTION).toMatch(/BREVITY IS THE IMPACT, ALWAYS, NOT AN OCCASIONAL EXCEPTION/);
    expect(EN_ZEN_VOICE_INSTRUCTION).toMatch(/Calibration \(tone reference only, never literal scripts to reuse verbatim\)/);
  });
});

describe("EN-047: NATURAL_VOICE_INSTRUCTION (the new conversational default)", () => {
  it("names all three required failure modes", () => {
    expect(NATURAL_VOICE_INSTRUCTION).toMatch(/NO APHORISTIC CLOSERS/);
    expect(NATURAL_VOICE_INSTRUCTION).toMatch(/NO PARAPHRASE-ELEVATION/);
    expect(NATURAL_VOICE_INSTRUCTION).toMatch(/NO AGREEMENT OPENERS/);
  });

  it("scopes the agreement-opener rule to WHERE a reply starts, never a ban on affirming at all", () => {
    expect(NATURAL_VOICE_INSTRUCTION).toMatch(/not a ban on ever agreeing or being warm/);
  });

  it("explicitly protects naturally variable length — this must not make replies longer by default", () => {
    expect(NATURAL_VOICE_INSTRUCTION).toMatch(/does not mean every reply now defaults to being brief or clipped/);
  });

  it("contains no quoted exemplar sentences the model could echo back (the Phase 5 / d5dac2e regression this refactor explicitly guards against)", () => {
    // The regression's exact shape was a labeled block of full quoted
    // sample sentences ("tone reference only") — a short quoted cross-
    // reference to another rule's own name (e.g. "no restating back") is a
    // different, legitimate use of quotes and isn't what's being guarded
    // against here, so the check targets the actual risk pattern rather
    // than banning quotation marks outright.
    expect(NATURAL_VOICE_INSTRUCTION).not.toMatch(/tone reference/i);
    expect(NATURAL_VOICE_INSTRUCTION).not.toMatch(/"\s*\/\s*"/); // the quoted-phrase-slash-quoted-phrase list shape of the old regression
  });
});

describe("EN-048: ZEN_MODE_INSTRUCTION (conditional, derived from EN_ZEN_VOICE_INSTRUCTION)", () => {
  it("keeps the brevity and restraint clauses", () => {
    expect(ZEN_MODE_INSTRUCTION).toMatch(/BREVITY IS THE IMPACT/);
    expect(ZEN_MODE_INSTRUCTION).toMatch(/IMAGERY OVER INSTRUCTION/);
    expect(ZEN_MODE_INSTRUCTION).toMatch(/NEVER CITE A SOURCE/);
    expect(ZEN_MODE_INSTRUCTION).toMatch(/FEWER QUESTIONS/);
  });

  it("frames itself as conditional, not the default", () => {
    expect(ZEN_MODE_INSTRUCTION).toMatch(/a conditional register, not the default/);
  });

  it("contains no quoted exemplar sentences — the old EN_ZEN_VOICE_INSTRUCTION 'Calibration (tone reference only...)' block is deliberately not carried forward", () => {
    expect(ZEN_MODE_INSTRUCTION).not.toMatch(/tone reference/i);
    expect(ZEN_MODE_INSTRUCTION).not.toMatch(/"\s*\/\s*"/);
    expect(ZEN_MODE_INSTRUCTION).not.toMatch(/Calibration/);
  });
});

describe("item 7 reconciliation: REGISTER_CALIBRATION_INSTRUCTION vs. the natural/zen split", () => {
  it("explicitly resolves the one real conflict (length) in zen mode's favor, rather than leaving two mechanisms to fight silently", () => {
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/EXCEPT when this reply is in the zen register/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/brevity there is the whole point/);
  });
});

describe("ambient/register/zodiac batch, item 3: REGISTER, NOT LEVEL", () => {
  it("states plainly that the question sets the depth, not the asker", () => {
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/THE QUESTION SETS THE DEPTH, NOT THE ASKER/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/wasted their life/);
  });

  it("distinguishes matching register from matching level, and says plain language isn't shallow thinking", () => {
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/MATCH REGISTER, NOT LEVEL/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/Plain language and shallow thinking are not the same thing/);
  });

  it("explicitly forbids inferring or storing an intellectual level, and names what isn't evidence of one", () => {
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/NEVER INFER OR STORE AN INTELLECTUAL LEVEL/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/second language/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/must never become a stored trait/);
  });

  it("preserves the distinction between remembering what someone TOLD Enso (memory) and inferring what they ARE from writing style (out of bounds)", () => {
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/that's ordinary memory and is the whole point/);
    expect(REGISTER_CALIBRATION_INSTRUCTION).toMatch(/inference about their mind, and that stays out of bounds/);
  });
});

describe("buildPersonaBlock voice-mode wiring", () => {
  it("defaults to the natural voice when called with no argument", () => {
    const block = buildPersonaBlock();
    expect(block).toMatch(/THE NATURAL VOICE/);
    expect(block).not.toMatch(/ZEN MODE —/);
  });

  it("uses the natural voice explicitly", () => {
    const block = buildPersonaBlock("natural");
    expect(block).toMatch(/THE NATURAL VOICE/);
    expect(block).not.toMatch(/ZEN MODE —/);
  });

  it("uses zen mode when requested", () => {
    const block = buildPersonaBlock("zen");
    expect(block).toMatch(/ZEN MODE —/);
    expect(block).not.toMatch(/THE NATURAL VOICE/);
  });

  it("still includes the rest of the persona block regardless of voice mode", () => {
    const natural = buildPersonaBlock("natural");
    const zen = buildPersonaBlock("zen");
    for (const block of [natural, zen]) {
      expect(block).toMatch(/THE THERAPIST \/ NARRATIVE ALLY/);
      expect(block).toMatch(/RECEIVING A NEW FACT/);
      expect(block).toMatch(/CALIBRATE TO THIS SPECIFIC PERSON/);
    }
  });
});
