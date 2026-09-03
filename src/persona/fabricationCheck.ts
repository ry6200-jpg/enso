/**
 * Fabrication Check (persona test suite). Fact-count budgets (ONE-FACT
 * BUDGET, PERSONA_INSTRUCTION) bound how many context facts a reply may
 * cite, but say nothing about whether a cited detail is actually supported
 * by a context fact -- a reply can stay within budget while adding a
 * specific (a location, a duration, an emotion attributed to a third
 * party) that no context fact or user turn supports. This module measures
 * that separately.
 *
 * Two-stage judge, run per reply:
 *   Stage 1 (decompose): extract every concrete detail the reply asserts
 *     about the user's world, history, or inner state, including details
 *     embedded inside a question. Generic statements naming no specific
 *     about this user are excluded. Run once, low temperature -- the
 *     detail LIST needs to be stable for per-detail voting below to mean
 *     anything; only classification (stage 2) is voted N times.
 *   Stage 2 (classify): for each extracted detail, classify it against the
 *     union of the context facts and the user's current-turn message:
 *       ENTAILED    - follows from a context fact with no addition
 *       USER_STATED - present in the user's message this turn
 *       ADDED       - a specific present in neither
 *       SOFT_ADDED  - added, but hedged or offered as a candidate
 *     Run N times (majority vote decides the final label; ties break
 *     toward the more severe label -- ADDED > SOFT_ADDED > USER_STATED >
 *     ENTAILED -- since a tied vote on whether something was invented
 *     should not default to clearing it).
 *
 * Judge model must differ from the model under evaluation -- a model
 * cannot be trusted to catch its own fabrication pattern. gpt-5.6-terra is
 * the fixed judge model for both the router and extraction adapters
 * already (EN-074/075), reused here rather than adding a fourth tier;
 * FABRICATION_JUDGE_MODEL asserts at call time that the model under test
 * is never passed in as the judge.
 *
 * GATING: any ADDED detail fails the case. SOFT_ADDED is recorded and
 * reported, never gated, until a baseline exists across models -- no
 * threshold is picked here.
 */

export const FABRICATION_JUDGE_MODEL = "gpt-5.6-terra";

export type FabricationLabel = "ENTAILED" | "USER_STATED" | "ADDED" | "SOFT_ADDED";

export interface ClassifiedDetail {
  span: string;
  label: FabricationLabel;
  /** One representative rationale from the majority-label votes (never synthesized -- an actual judge-returned rationale). */
  rationale: string;
  /** The offending span as the judge named it, for ADDED/SOFT_ADDED only (per the acceptance criteria: "a bare verdict is not sufficient"). Null for ENTAILED/USER_STATED. */
  offendingSpan: string | null;
  /** Raw vote tally across all N classify runs, for transparency -- majority label is votes with the highest count, ties broken toward severity. */
  votes: Record<FabricationLabel, number>;
}

export interface FabricationCheckResult {
  details: ClassifiedDetail[];
  /** true iff any detail's majority label is ADDED -- the one gated condition. */
  fails: boolean;
}

export interface FabricationCheckInput {
  /** The context fact list, verbatim -- whatever was actually available to the reply model (self-profile lines, retrieved-chunk text), never re-summarized. */
  contextFacts: string[];
  /** The user's current-turn message, verbatim. */
  userTurn: string;
  /** The reply being checked, verbatim. */
  reply: string;
}

interface SingleClassifyResult {
  label: FabricationLabel;
  rationale: string;
  offendingSpan: string | null;
}

/** Injectable so FAST tests can supply a deterministic mock judge (no network) -- same discipline as ProviderAdapter/RouterAdapter elsewhere in src/providers. */
export interface FabricationJudgeAdapter {
  decompose(input: FabricationCheckInput): Promise<string[]>;
  classify(input: FabricationCheckInput, detailSpan: string): Promise<SingleClassifyResult>;
}

const SEVERITY_ORDER: FabricationLabel[] = ["ADDED", "SOFT_ADDED", "USER_STATED", "ENTAILED"];

/** Majority vote across N classify runs for one detail; ties break toward the more severe label (ADDED first) rather than defaulting to cleared. */
export function majorityVote(results: SingleClassifyResult[]): { label: FabricationLabel; votes: Record<FabricationLabel, number> } {
  const votes: Record<FabricationLabel, number> = { ENTAILED: 0, USER_STATED: 0, ADDED: 0, SOFT_ADDED: 0 };
  for (const r of results) votes[r.label]++;

  let winner: FabricationLabel = "ENTAILED";
  let winnerCount = -1;
  for (const label of SEVERITY_ORDER) {
    const count = votes[label];
    if (count > winnerCount) {
      winner = label;
      winnerCount = count;
    }
  }
  return { label: winner, votes };
}

/** A representative rationale/offendingSpan from the runs that actually voted for the winning label -- never fabricated by this function, always a real judge output. */
function pickRepresentative(results: SingleClassifyResult[], label: FabricationLabel): { rationale: string; offendingSpan: string | null } {
  const matching = results.find((r) => r.label === label);
  return matching ? { rationale: matching.rationale, offendingSpan: matching.offendingSpan } : { rationale: "", offendingSpan: null };
}

export interface RunFabricationCheckOptions {
  n?: number;
  concurrency?: number;
}

/**
 * Orchestrates one full check: decompose once, then classify each
 * extracted detail N times (default 20, per EN-075's own N=20/majority
 * discipline) and majority-vote the result. Throws if judgeModel matches
 * modelUnderTest -- structural enforcement of "judge must differ from the
 * model under evaluation," never left to caller discipline alone.
 */
export async function runFabricationCheck(
  adapter: FabricationJudgeAdapter,
  judgeModel: string,
  modelUnderTest: string,
  input: FabricationCheckInput,
  options: RunFabricationCheckOptions = {}
): Promise<FabricationCheckResult> {
  if (judgeModel === modelUnderTest) {
    throw new Error(`Fabrication judge model "${judgeModel}" must not equal the model under evaluation "${modelUnderTest}".`);
  }
  const n = options.n ?? 20;
  const concurrency = options.concurrency ?? 10;

  const spans = await adapter.decompose(input);

  const details: ClassifiedDetail[] = [];
  for (const span of spans) {
    const results: SingleClassifyResult[] = new Array(n);
    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= n) return;
        results[i] = await adapter.classify(input, span);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));

    const { label, votes } = majorityVote(results);
    const { rationale, offendingSpan } = pickRepresentative(results, label);
    details.push({ span, label, rationale, offendingSpan, votes });
  }

  return { details, fails: details.some((d) => d.label === "ADDED") };
}
