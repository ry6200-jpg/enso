/**
 * Report page, Stage A (methodology Section 2.4: "Every marker gets a
 * personal baseline built from the user's own prior windows"). Idiographic
 * only (methodology Section 0, design commitment 1) — this never compares
 * against anyone but the same person's own history.
 *
 * The lagged cross-correlation analysis Section 2.4 also describes is
 * Stage C ("enough windows to be legitimate," Section 5's stage table) —
 * not built here. This module is the simpler, Stage A half: is THIS
 * window's value unusual relative to this same person's own prior
 * windows, with an explicit uncertainty interval rather than a bare
 * number, and a plain statement when there isn't enough history yet to
 * say.
 */

/** At least this many PRIOR windows (not counting the current one) must exist before a baseline is shown — one prior point alone is not a baseline, it's a single number pretending to be one. */
export const MIN_PRIOR_WINDOWS_FOR_BASELINE = 2;

export interface BaselineResult {
  currentValue: number;
  priorWindowCount: number;
  /** Present only when priorWindowCount >= MIN_PRIOR_WINDOWS_FOR_BASELINE. */
  baseline: { mean: number; stdev: number; deviationInStdevs: number | null } | null;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/**
 * `priorValues` is this same marker's value from every window strictly
 * before the current one, oldest-first-or-any-order (order doesn't
 * matter here). Returns null baseline (never a fabricated trend from too
 * few points) below MIN_PRIOR_WINDOWS_FOR_BASELINE — the caller is
 * expected to render "not enough historical data for a baseline yet"
 * plainly in that case, per the methodology's own "below threshold, say
 * so" principle.
 */
export function computeBaseline(currentValue: number, priorValues: number[]): BaselineResult {
  if (priorValues.length < MIN_PRIOR_WINDOWS_FOR_BASELINE) {
    return { currentValue, priorWindowCount: priorValues.length, baseline: null };
  }
  const m = mean(priorValues);
  const s = stdev(priorValues);
  return {
    currentValue,
    priorWindowCount: priorValues.length,
    baseline: { mean: m, stdev: s, deviationInStdevs: s > 0 ? (currentValue - m) / s : null }
  };
}
