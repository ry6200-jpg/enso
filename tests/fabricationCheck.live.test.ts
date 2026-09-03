/**
 * Fabrication Check: calibration + two-model baseline (persona test suite).
 *
 * Fact-count budgets (ONE-FACT BUDGET, PERSONA_INSTRUCTION) bound how many
 * context facts a reply may cite; they do not detect a reply that stays
 * within budget while adding a specific -- a location, a duration, an
 * attributed feeling -- that no context fact or the user's own message
 * supports. This file measures that separately, with a judge model that is
 * never the model under evaluation (gpt-5.6-terra, fixed).
 *
 * CALIBRATION (run first): 5 fixtures, each engineered to carry exactly one
 * targeted detail from the required acceptance-criteria categories. If the
 * judge cannot reproduce the expected label on these, the check itself is
 * not trustworthy -- this file's own calibration `it`s are the enforcement
 * mechanism (a calibration failure means: report it, do not treat the rest
 * of this file's baseline numbers as meaningful, do not commit).
 *
 * BASELINE: the check run against 5 fixed gpt-5.6-terra replies and 5 fixed
 * gpt-5.6-luna replies to the SAME 5 scenarios (context facts + user turn
 * identical per scenario, only the reply differs) -- the "existing five
 * persona replies" from the EN-075 budget-tier manual persona check.
 * Reply text is fixed/hardcoded here deliberately: this measures fabrication
 * in the replies that were actually read and judged, not in a fresh,
 * differently-worded regeneration.
 *
 * Real API calls; run with `npx vitest run tests/fabricationCheck.live.test.ts`.
 * Cost estimate printed in beforeAll, actual spend in afterAll (same
 * discipline as validationBank.live.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFabricationCheck, FABRICATION_JUDGE_MODEL, type ClassifiedDetail, type FabricationCheckInput } from "../src/persona/fabricationCheck.js";
import { createOpenAiFabricationJudgeAdapter } from "../src/providers/fabricationJudgeAdapter.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run with real API keys loaded.`);
  return value;
}

const N = 20;
let adapter: ReturnType<typeof createOpenAiFabricationJudgeAdapter>;
let callCount = { decompose: 0, classify: 0 };

beforeAll(() => {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const real = createOpenAiFabricationJudgeAdapter(apiKey, FABRICATION_JUDGE_MODEL);
  // Wrap to count calls for the cost report -- the adapter itself has no counting built in.
  adapter = {
    async decompose(input) {
      callCount.decompose++;
      return real.decompose(input);
    },
    async classify(input, span) {
      callCount.classify++;
      return real.classify(input, span);
    }
  } as ReturnType<typeof createOpenAiFabricationJudgeAdapter>;

  console.log(`\n=== FABRICATION CHECK COST ESTIMATE ===`);
  console.log(`5 calibration fixtures x (1 decompose + ~1 detail x N=${N} classify) ~ 105 calls`);
  console.log(`10 baseline replies x (1 decompose + ~1-2 details x N=${N} classify) ~ 210-410 calls`);
  console.log(`Judge model: ${FABRICATION_JUDGE_MODEL}. Actual spend reported in afterAll.`);
  console.log(`==========================================\n`);
});

afterAll(() => {
  // estimateCostUsd needs real usage data we didn't thread through the counting
  // wrapper above (the adapter interface returns parsed judge output only, not
  // raw token usage) -- report call counts, which is what the cost estimate
  // above was already scoped to, rather than fabricate a token-based figure
  // this wrapper never actually captured.
  console.log(`\n=== FABRICATION CHECK ACTUAL CALLS ===`);
  console.log(`decompose calls: ${callCount.decompose}`);
  console.log(`classify calls: ${callCount.classify}`);
  console.log(`total calls: ${callCount.decompose + callCount.classify}`);
  console.log(`========================================\n`);
});

function printResult(label: string, input: FabricationCheckInput, details: ClassifiedDetail[]): void {
  console.log(`\n--- ${label} ---`);
  console.log(`REPLY: ${input.reply}`);
  if (details.length === 0) {
    console.log(`  (no details extracted)`);
  }
  for (const d of details) {
    console.log(`  [${d.label}] "${d.span}"${d.offendingSpan ? ` -- offending span: "${d.offendingSpan}"` : ""} (votes: ${JSON.stringify(d.votes)})`);
    console.log(`    rationale: ${d.rationale}`);
  }
}

describe("Fabrication Check calibration (acceptance criteria)", () => {
  it("calibration 1: a relation to an event that the fact does not specify -> ADDED", async () => {
    const input: FabricationCheckInput = {
      contextFacts: ["Long paramedic shift, saw a bad car accident, still shaken."],
      userTurn: "Rough shift today.",
      reply: "That crash near your last call must still be sitting with you."
    };
    const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
    printResult("Calibration 1 (unspecified event relation)", input, result.details);
    expect(result.fails).toBe(true);
  }, 300_000);

  it("calibration 2: an invented physical detail -> ADDED", async () => {
    const input: FabricationCheckInput = {
      contextFacts: ["My brother Nate and I don't talk much anymore, we had a falling out a couple years back."],
      userTurn: "Saw a photo of Nate today.",
      reply: "Seeing him with that beard he's grown must have caught you off guard."
    };
    const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
    printResult("Calibration 2 (invented physical detail)", input, result.details);
    expect(result.fails).toBe(true);
  }, 300_000);

  it("calibration 3: an unsupported duration -> ADDED", async () => {
    const input: FabricationCheckInput = {
      contextFacts: ["Priya's mom is in the hospital.", "Priya is stressed about it."],
      userTurn: "Priya still seems out of it.",
      reply: "Her mom being in the hospital for three weeks now must be wearing her down."
    };
    const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
    printResult("Calibration 3 (unsupported duration)", input, result.details);
    expect(result.fails).toBe(true);
  }, 300_000);

  it("calibration 4: an unsupported attribution of affect -> ADDED", async () => {
    const input: FabricationCheckInput = {
      contextFacts: ["My brother Nate and I had a falling out a couple years back."],
      userTurn: "Saw a photo of Nate today.",
      reply: "It sounds like Nate has been dreading running into you just as much as you have him."
    };
    const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
    printResult("Calibration 4 (unsupported affect attribution)", input, result.details);
    expect(result.fails).toBe(true);
  }, 300_000);

  it("calibration 5: an honest gap ('I don't have your birthdate') -> ENTAILED, never ADDED/SOFT_ADDED", async () => {
    const input: FabricationCheckInput = {
      contextFacts: [],
      userTurn: "How old am I again?",
      reply: "I don't have your birthdate on record."
    };
    const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
    printResult("Calibration 5 (honest gap)", input, result.details);
    expect(result.details.every((d) => d.label !== "ADDED" && d.label !== "SOFT_ADDED")).toBe(true);
  }, 300_000);
});

// The 5 shared scenarios' context facts + user turns, identical for both
// models -- only `reply` differs below. Self-profile facts (occupation,
// location) were present on every turn (R38, always-on); retrieved chunks
// were scenario-specific, exactly what each reply model actually saw.
const SELF_PROFILE_FACTS = ["Occupation: paramedic", "Location: Denver"];
const SCENARIOS: { name: string; contextFacts: string[]; userTurn: string; terraReply: string; lunaReply: string }[] = [
  {
    name: "1. Ordinary/mundane update",
    contextFacts: [...SELF_PROFILE_FACTS],
    userTurn: "Gonna do laundry and maybe clean the garage this weekend.",
    terraReply: "Productive weekend. Garage-cleaning has a way of turning into an archaeological dig—are you just tidying it up, or trying to make space for something?",
    lunaReply: "Laundry is manageable; the garage is the kind of job that can quietly eat the whole weekend. If you tackle it, maybe give it a clear stopping point so it doesn't take over."
  },
  {
    name: "2. Direct factual question",
    contextFacts: [...SELF_PROFILE_FACTS],
    userTurn: "How old am I again?",
    terraReply: "I don’t have your birthdate coming up for me. When were you born?",
    lunaReply: "I don’t have your age or birthdate in front of me."
  },
  {
    name: "3. Emotionally weighty, 3 facts available",
    contextFacts: [...SELF_PROFILE_FACTS, "Long paramedic shift, saw a bad car accident, still shaken.", "Been sleeping badly this week, maybe 4 hours a night.", "Landlord raised the rent again, stressed about money."],
    userTurn: "Rough shift today. Not really sure how to shake it off.",
    terraReply: "Oof. After that bad accident recently, some shifts don’t just switch off when you clock out. Try one small transition before you go home: sit somewhere quiet for five minutes, drink some water, and let your body come down before asking your mind to.\n\nWhat’s the part of today that keeps replaying?",
    lunaReply: "Oof. A rough shift can follow you home, especially after the serious accident you saw recently. You may not be able to shake it off on command; it might help more to give yourself a clear landing—food, a shower, clean clothes, and a little quiet before trying to be “fine.”\n\nWhat part is sticking with you most right now: something you saw, something you had to do, or the general strain of the shift?"
  },
  {
    name: "4. Vague structural gap",
    contextFacts: [...SELF_PROFILE_FACTS],
    userTurn: "Ran into someone from my old volunteer group today, was nice to catch up.",
    terraReply: "That’s a nice surprise. Was it someone you were especially close with back then, or more one of those “wow, it’s been ages” catch-ups?",
    lunaReply: "That kind of unexpected catch-up can be a nice little reminder of a chapter you once enjoyed. Did it leave you wanting to reconnect with anyone else from the group, or was it more of a pleasant one-off?"
  },
  {
    name: "5. Named-relationship context present",
    contextFacts: [...SELF_PROFILE_FACTS, "My brother Nate and I don't talk much anymore, we had a falling out a couple years back."],
    userTurn: "Saw a photo of Nate on social media today. Weird feeling.",
    terraReply: "Those unexpected glimpses can stir up more than you expect, especially with someone you’ve been distant from for a while. Did it bring up more missing him, anger, curiosity—or something harder to name?",
    lunaReply: "Seeing him unexpectedly can pull up more than one feeling at once, especially after a long stretch of distance. What part felt weirdest—the fact that he looked different, the memories it stirred up, or the reminder of where things stand between you?"
  }
];

const aggregate: Record<string, Record<string, number>> = {
  "gpt-5.6-luna": { ENTAILED: 0, USER_STATED: 0, ADDED: 0, SOFT_ADDED: 0 }
};

// KNOWN DESIGN LIMIT, not an oversight: FABRICATION_JUDGE_MODEL is fixed to
// gpt-5.6-terra, and the judge must never equal the model under evaluation
// (runFabricationCheck's own structural guard, verified in
// tests/fabricationCheck.test.ts). That means gpt-5.6-terra's OWN
// fabrication rate cannot be measured under this design -- terra can never
// judge itself. Only gpt-5.6-luna's replies get a real fabrication
// measurement below; terra's bucket stays at zero, labeled as unmeasured,
// not as "zero fabrication observed." A second, independent judge model
// would remove this gap but was not part of what was specified here.
describe("Fabrication Check baseline: gpt-5.6-terra vs gpt-5.6-luna", () => {
  it("gpt-5.6-terra's own fabrication rate is NOT measurable under this design (judge cannot equal subject) -- documents the limit rather than leaving 5 tests permanently red", async () => {
    const input: FabricationCheckInput = { contextFacts: SCENARIOS[0]!.contextFacts, userTurn: SCENARIOS[0]!.userTurn, reply: SCENARIOS[0]!.terraReply };
    await expect(runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-terra", input, { n: N })).rejects.toThrow(/must not equal/);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name} -- gpt-5.6-luna reply`, async () => {
      const input: FabricationCheckInput = { contextFacts: scenario.contextFacts, userTurn: scenario.userTurn, reply: scenario.lunaReply };
      const result = await runFabricationCheck(adapter, FABRICATION_JUDGE_MODEL, "gpt-5.6-luna", input, { n: N });
      printResult(`${scenario.name} [luna]`, input, result.details);
      for (const d of result.details) { const bucket = aggregate["gpt-5.6-luna"]!; bucket[d.label] = (bucket[d.label] ?? 0) + 1; }
      expect(result.details).toBeDefined();
    }, 300_000);
  }

  it("prints the baseline (gpt-5.6-terra unmeasured by design, see the guard test above)", () => {
    console.log(`\n=== FABRICATION BASELINE ===`);
    console.log(`gpt-5.6-terra: UNMEASURED (judge model fixed to gpt-5.6-terra; cannot judge itself). Raw replies, unaudited:`);
    for (const s of SCENARIOS) console.log(`  [${s.name}] ${s.terraReply}`);
    console.log(`gpt-5.6-luna:  ${JSON.stringify(aggregate["gpt-5.6-luna"])}`);
    console.log(`===============================\n`);
    expect(true).toBe(true);
  });
});
