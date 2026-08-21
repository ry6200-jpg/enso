/**
 * Phase 6 Part 4 — the N=20 validation bank (EN-075/CLAUDE.md testing
 * policy): every router flag and the attestation gate, N=20 runs per
 * case, ≥19 to pass, scored as per-flag confusion matrices. Also includes
 * (per this phase's explicit instruction) the assertion-guard cases
 * earmarked in tests/assertionGuard.live.test.ts's bottom comment — a
 * different model call (extraction, not routing) but the same kind of
 * stochastic LLM decision this bank exists to certify at real reliability
 * rather than a one-off 3x check.
 *
 * Real API calls; run with `npm run test:live`. Cost/call-count estimate
 * is computed and printed in beforeAll before anything runs (Part 4's
 * explicit instruction) — compare the ACTUAL total printed at the end.
 *
 * A failing case is reported with which specific runs failed and what the
 * model actually returned — never silently retried into passing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { extractMessageWithResilience, type MessageExtractionCompletedPayload } from "../src/extraction/resilientExtraction.js";
import { createDefaultRouter, type ExtractionRouter } from "../src/providers/router.js";
import { createDefaultIntentRouter } from "../src/conversation/router/intentRouter.js";
import type { RouterDecision, RouterRequest } from "../src/conversation/router/routerTypes.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run test:live with real API keys loaded.`);
  return value;
}

const N = 20;
const PASS_THRESHOLD = 19;
const ROUTER_CASE_COUNT = 6; // A1, A2, B1, B2, C1, C2
const EXTRACTION_CASE_COUNT = 8; // D1-D8

let costTracker: CostTracker;
let intentRouterInstance: ReturnType<typeof createDefaultIntentRouter>;
let extractionRouterInstance: ExtractionRouter;

beforeAll(() => {
  const openaiKey = requireEnv("OPENAI_API_KEY");
  const geminiKey = requireEnv("GEMINI_API_KEY");
  costTracker = new CostTracker();
  intentRouterInstance = createDefaultIntentRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);
  extractionRouterInstance = createDefaultRouter({ openai: openaiKey, gemini: geminiKey }, costTracker);

  const estimatedInputTokensPerRouterCall = 900;
  const estimatedOutputTokensPerRouterCall = 150;
  const estimatedInputTokensPerExtractionCall = 1600;
  const estimatedOutputTokensPerExtractionCall = 200;
  const routerCost = ROUTER_CASE_COUNT * N * ((estimatedInputTokensPerRouterCall / 1e6) * 2.0 + (estimatedOutputTokensPerRouterCall / 1e6) * 12.0);
  const extractionCost = EXTRACTION_CASE_COUNT * N * ((estimatedInputTokensPerExtractionCall / 1e6) * 2.0 + (estimatedOutputTokensPerExtractionCall / 1e6) * 12.0);
  const totalCalls = (ROUTER_CASE_COUNT + EXTRACTION_CASE_COUNT) * N;

  console.log(`\n=== VALIDATION BANK COST ESTIMATE ===`);
  console.log(`Router cases: ${ROUTER_CASE_COUNT} x N=${N} = ${ROUTER_CASE_COUNT * N} calls, est. $${routerCost.toFixed(3)}`);
  console.log(`Extraction (assertion-guard) cases: ${EXTRACTION_CASE_COUNT} x N=${N} = ${EXTRACTION_CASE_COUNT * N} calls, est. $${extractionCost.toFixed(3)}`);
  console.log(`TOTAL: ${totalCalls} calls, est. $${(routerCost + extractionCost).toFixed(3)}`);
  console.log(`======================================\n`);
});

afterAll(() => {
  const records = costTracker.all();
  console.log(`\n=== VALIDATION BANK ACTUAL SPEND ===`);
  console.log(`Actual calls recorded: ${records.length}`);
  console.log(`Actual total: $${costTracker.totalUsd().toFixed(4)}`);
  console.log(`======================================\n`);
});

async function runConcurrent<T>(n: number, concurrency: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(n);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results;
}

interface CaseOutcome {
  index: number;
  pass: boolean;
  detail: string;
}

function reportConfusionMatrix(caseName: string, outcomes: CaseOutcome[]): void {
  const passed = outcomes.filter((o) => o.pass).length;
  console.log(`\n--- ${caseName}: ${passed}/${N} ---`);
  if (passed < N) {
    for (const o of outcomes.filter((x) => !x.pass)) {
      console.log(`  FAIL run ${o.index}: ${o.detail}`);
    }
  }
}

async function routerDecisionFor(request: RouterRequest): Promise<RouterDecision> {
  const result = await intentRouterInstance.route(request);
  return result.decision;
}

describe("Validation bank — router flags (EN-075)", () => {
  it("A1 (positive): entity-mode resolves a kinship term to the sole matching known entity", async () => {
    const request: RouterRequest = {
      message: "How's my mom doing?",
      recentTurns: [],
      knownEntities: [{ entityId: "e-elena", name: "Elena" }],
      circleBackCandidates: [],
      recentAttributeClaims: []
    };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.retrieval.mode === "entity" && decision.retrieval.entityId === "e-elena";
      return { index: i, pass, detail: JSON.stringify(decision.retrieval) };
    });
    reportConfusionMatrix("A1 entity-mode positive", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);

  it("A2 (negative): with no known entities, never fabricates entity mode", async () => {
    const request: RouterRequest = { message: "How's my mom doing?", recentTurns: [], knownEntities: [], circleBackCandidates: [], recentAttributeClaims: [] };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.retrieval.mode !== "entity";
      return { index: i, pass, detail: JSON.stringify(decision.retrieval) };
    });
    reportConfusionMatrix("A2 entity-mode negative", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);

  it("B1 (positive): circle-back fires on a natural, casual moment with an eligible candidate", async () => {
    const request: RouterRequest = {
      message: "Just got back from grabbing coffee, nothing major today.",
      recentTurns: [],
      knownEntities: [],
      circleBackCandidates: [{ entityId: "c-marcus", name: "Marcus", attemptNumber: 1, mentionAgeLabel: "earlier today" }],
      recentAttributeClaims: []
    };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.circleBack.fire === true && decision.circleBack.entityId === "c-marcus";
      return { index: i, pass, detail: JSON.stringify(decision.circleBack) };
    });
    reportConfusionMatrix("B1 circle-back positive", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);

  it("B2 (negative, asymmetric — a false positive here is costly: interrupts a heavy moment): circle-back does not fire while the user is venting", async () => {
    const request: RouterRequest = {
      message: "I'm honestly feeling pretty overwhelmed right now and just need to vent for a second.",
      recentTurns: [],
      knownEntities: [],
      circleBackCandidates: [{ entityId: "c-marcus", name: "Marcus", attemptNumber: 1, mentionAgeLabel: "earlier today" }],
      recentAttributeClaims: []
    };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.circleBack.fire === false;
      return { index: i, pass, detail: JSON.stringify(decision.circleBack) };
    });
    reportConfusionMatrix("B2 circle-back negative (asymmetric: false positive is the costly error)", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);

  it("C1 (positive, asymmetric — a false positive here fabricates an authoritative fact_confirmed event): an explicit affirmation is recognized", async () => {
    const request: RouterRequest = {
      message: "Yes, that's right, she's in Seattle.",
      recentTurns: [{ role: "enso", text: "Last I heard, Elena was settling into Seattle." }],
      knownEntities: [{ entityId: "e-elena", name: "Elena" }],
      circleBackCandidates: [],
      recentAttributeClaims: [{ entityName: "Elena", attribute: "location", value: "Seattle", extractionEventId: "ext1" }]
    };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.attestation.isAffirmation === true && decision.attestation.entityName === "Elena" && decision.attestation.attribute === "location" && decision.attestation.value === "Seattle";
      return { index: i, pass, detail: JSON.stringify(decision.attestation) };
    });
    reportConfusionMatrix("C1 attestation positive", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);

  it("C2 (negative, asymmetric — the costly error): a bare continuer never counts as an affirmation", async () => {
    const request: RouterRequest = {
      message: "yeah",
      recentTurns: [{ role: "enso", text: "Last I heard, Elena was settling into Seattle." }],
      knownEntities: [{ entityId: "e-elena", name: "Elena" }],
      circleBackCandidates: [],
      recentAttributeClaims: [{ entityName: "Elena", attribute: "location", value: "Seattle", extractionEventId: "ext1" }]
    };
    const outcomes = await runConcurrent(N, 10, async (i) => {
      const decision = await routerDecisionFor(request);
      const pass = decision.attestation.isAffirmation === false;
      return { index: i, pass, detail: JSON.stringify(decision.attestation) };
    });
    reportConfusionMatrix("C2 attestation negative (asymmetric: false positive is the costly error)", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 180_000);
});

async function extractOnce(text: string, knownPeopleNames: string[] = []): Promise<MessageExtractionCompletedPayload> {
  const eventLog = new EventLog(":memory:");
  const messageEvent = eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
  const extractionEvent = await extractMessageWithResilience(eventLog, extractionRouterInstance, messageEvent, undefined, knownPeopleNames);
  eventLog.close();
  return extractionEvent.payload as MessageExtractionCompletedPayload;
}

function isEmptyExtraction(p: MessageExtractionCompletedPayload): boolean {
  return p.attributes.length === 0 && p.structuralAtoms.length === 0 && p.socialBonds.length === 0 && p.statedFeelings.length === 0;
}

describe("Validation bank — assertion guard (R23), earmarked from assertionGuard.live.test.ts", () => {
  it("D1: question embedding a location claim -> zero attributes", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Didn't Elena move to Portland last year?", ["Elena"]);
      const pass = p.attributes.length === 0;
      return { index: i, pass, detail: JSON.stringify(p.attributes) };
    });
    reportConfusionMatrix("D1 question -> no attribute", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D2 CONTROL: the equivalent declarative still extracts (proves no over-suppression)", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Elena moved to Portland last year.", ["Elena"]);
      const pass = p.attributes.some((a) => a.value.toLowerCase().includes("portland"));
      return { index: i, pass, detail: JSON.stringify(p.attributes) };
    });
    reportConfusionMatrix("D2 CONTROL declarative -> attribute extracted", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D3: hypothetical/conditional -> nothing", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("If Diego moved away, I'd miss him.", ["Diego"]);
      const pass = isEmptyExtraction(p);
      return { index: i, pass, detail: JSON.stringify(p) };
    });
    reportConfusionMatrix("D3 hypothetical -> nothing", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D4: question about whether a bond ended -> no closure", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Did Priya and I stop talking?", ["Priya"]);
      const pass = !p.socialBonds.some((b) => b.action === "close");
      return { index: i, pass, detail: JSON.stringify(p.socialBonds) };
    });
    reportConfusionMatrix("D4 bond-closure question -> no closure", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D5: kinship-term question (the exact dev-data regression) -> no structural atom", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("How's my mom doing these days?", ["Elena"]);
      const pass = p.structuralAtoms.length === 0;
      return { index: i, pass, detail: JSON.stringify(p.structuralAtoms) };
    });
    reportConfusionMatrix("D5 kinship-term question -> no structural atom", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D6: reported speech -> nothing extracted as the user's own assertion", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Marcus thinks Elena moved to Portland.", ["Elena", "Marcus"]);
      const pass = !p.attributes.some((a) => a.value.toLowerCase().includes("portland"));
      return { index: i, pass, detail: JSON.stringify(p.attributes) };
    });
    reportConfusionMatrix("D6 reported speech -> nothing", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D7 (new): negation -> a stated negative is not a stated location", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Elena didn't move to Portland.", ["Elena"]);
      const pass = !p.attributes.some((a) => a.value.toLowerCase().includes("portland"));
      return { index: i, pass, detail: JSON.stringify(p.attributes) };
    });
    reportConfusionMatrix("D7 negation -> nothing", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);

  it("D8 (new): a second, differently-worded reported-speech variant -> nothing extracted", async () => {
    const outcomes = await runConcurrent(N, 8, async (i) => {
      const p = await extractOnce("Christine mentioned that Elena might've moved to Portland.", ["Elena", "Christine"]);
      const pass = !p.attributes.some((a) => a.value.toLowerCase().includes("portland"));
      return { index: i, pass, detail: JSON.stringify(p.attributes) };
    });
    reportConfusionMatrix("D8 reported speech (variant) -> nothing", outcomes);
    expect(outcomes.filter((o) => o.pass).length).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  }, 300_000);
});
