import type { ReportResult } from "./computeReport.js";
import type { ReportWindowMessage } from "./reportWindows.js";

/**
 * Report page, part 2 (EN-120). The code-level candidate-selection layer
 * between computeReport's structured markers and the prose-generation
 * call — the same "the model only ever picks from candidates it was
 * handed, never invents its own" discipline this codebase already uses
 * for curiosity-turn/circle-back/ambient candidates (circleBack.ts,
 * ambientCandidates.ts). Confidence gating happens HERE, in code, not as
 * a prompt instruction the model might skip: "behaviors that must happen
 * reliably get explicit gates, not prompt paragraphs" (CLAUDE.md, EN-070).
 *
 * The numbers themselves — deviationInStdevs, HHI values, word counts,
 * every raw metric computeReport produces — are used ONLY to decide
 * whether a topic exists and how confidently, then discarded. Nothing
 * numeric is carried into a ReportTopicCandidate. This is a structural
 * guarantee the prose-generation model cannot narrate a marker back as a
 * number, because it is never given one — stronger than asking it not to
 * in a system prompt, which is exactly where the rejected version's
 * "numbers as content" failure lived.
 */

/** Below this many stdevs of deviation from the person's own prior windows, "nothing here differs from usual" is the honest read — not a passage. */
const MIN_DEVIATION_STDEVS = 1;
/** Word-class rates are noisier at this corpus's message length (methodology Section 2.1) — held to a stricter bar, and only ever attached as color to a topic that already exists on stronger grounds, never a topic of their own. */
const MIN_WORD_CLASS_DEVIATION_STDEVS = 1.5;

export type ReportTopicKind = "dormancy" | "networkActivityShift" | "mentionConcentrationShift" | "lexicalDiversityShift";

export interface ReportTopicCandidate {
  id: string;
  kind: ReportTopicKind;
  /** Plain qualitative direction only — never a magnitude. Null for dormancy, which isn't a directional trend. */
  direction: "up" | "down" | null;
  /** Set only for dormancy — the one topic kind about a specific person rather than a window of activity. */
  entityName: string | null;
  /** The real messages this topic is grounded in — the only place any number behind this topic lives, and the drill-down's own source material. */
  sourceMessages: ReportWindowMessage[];
  /** True when a word-class shift also cleared its (stricter) bar in the same window — may be mentioned as reinforcing color, never as the sole basis for writing about this window at all (see selectReportTopics: a word-class signal with no co-occurring topic here produces nothing). */
  hasSupportingWordClassSignal: boolean;
}

/** Plain data shape, not the full EntityRow — reportTopics.ts stays a pure function over already-computed data, no DB access, matching resolveAttribute/computeNetworkMarkers' own discipline. */
export interface ReportTopicEntityInput {
  id: string;
  name: string;
  sourceEventIds: string[];
}

function directionFromDeviation(deviationInStdevs: number | null): "up" | "down" | null {
  if (deviationInStdevs === null) return null;
  return deviationInStdevs > 0 ? "up" : "down";
}

export function selectReportTopics(report: ReportResult, entities: ReportTopicEntityInput[]): ReportTopicCandidate[] {
  const topics: ReportTopicCandidate[] = [];

  const allMessagesById = new Map<string, ReportWindowMessage>();
  for (const window of report.windows) for (const m of window.messages) allMessagesById.set(m.id, m);

  const entitiesById = new Map(entities.map((e) => [e.id, e]));

  // Dormancy: a direct elapsed-time fact, no baseline needed — the methodology's own
  // "one of the strongest candidates for a genuinely unnoticed observation."
  for (const d of report.network.dormancy) {
    if (!d.dormant) continue;
    const entity = entitiesById.get(d.entityId);
    const sourceMessages = entity ? entity.sourceEventIds.map((id) => allMessagesById.get(id)).filter((m): m is ReportWindowMessage => m !== undefined) : [];
    if (sourceMessages.length === 0) continue; // nothing to quote — no passage without real material
    topics.push({ id: `dormancy:${d.entityId}`, kind: "dormancy", direction: null, entityName: d.name, sourceMessages, hasSupportingWordClassSignal: false });
  }

  // Trend markers: gated on a real baseline existing (MIN_PRIOR_WINDOWS_FOR_BASELINE)
  // AND a real deviation (MIN_DEVIATION_STDEVS) — both computed here, in code, never
  // passed to the model as anything but "this window is worth writing about."
  for (const b of report.baselines) {
    const window = report.windows.find((w) => w.index === b.windowIndex);
    if (!window || window.messages.length === 0) continue;

    const wordClassSupport = b.wordClassRates.some(
      (wc) => wc.baseline.baseline !== null && wc.baseline.baseline.deviationInStdevs !== null && Math.abs(wc.baseline.baseline.deviationInStdevs) >= MIN_WORD_CLASS_DEVIATION_STDEVS
    );

    const trendChecks: { kind: ReportTopicKind; deviationInStdevs: number | null; hasBaseline: boolean }[] = [
      { kind: "networkActivityShift", deviationInStdevs: b.activeTieCount.baseline?.deviationInStdevs ?? null, hasBaseline: b.activeTieCount.baseline !== null },
      {
        kind: "mentionConcentrationShift",
        deviationInStdevs: b.mentionConcentrationHhi?.baseline?.deviationInStdevs ?? null,
        hasBaseline: b.mentionConcentrationHhi !== null && b.mentionConcentrationHhi.baseline !== null
      },
      { kind: "lexicalDiversityShift", deviationInStdevs: b.lexicalDiversityTypeTokenRatio.baseline?.deviationInStdevs ?? null, hasBaseline: b.lexicalDiversityTypeTokenRatio.baseline !== null }
    ];

    for (const check of trendChecks) {
      if (!check.hasBaseline) continue; // below MIN_PRIOR_WINDOWS_FOR_BASELINE — never written about, per instruction
      if (check.deviationInStdevs === null || Math.abs(check.deviationInStdevs) < MIN_DEVIATION_STDEVS) continue; // not different enough from this person's own usual to be worth a passage
      topics.push({
        id: `${check.kind}:${b.windowIndex}`,
        kind: check.kind,
        direction: directionFromDeviation(check.deviationInStdevs),
        entityName: null,
        sourceMessages: window.messages,
        hasSupportingWordClassSignal: wordClassSupport
      });
    }
  }

  return topics;
}
