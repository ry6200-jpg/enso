import { selectReportTopics, type ReportTopicCandidate, type ReportTopicEntityInput } from "./reportTopics.js";
import { generateReportProseViaOpenAi } from "./reportProseAdapter.js";
import type { ReportResult } from "./computeReport.js";

/**
 * Report page, part 2 (EN-120): the orchestrator. selectReportTopics
 * decides what's worth writing about, in code, before the model ever
 * runs; this function calls the model, then validates its own output
 * against the real candidate list — the same "never trust an id the
 * model echoes back without checking it against what was actually
 * offered" discipline as circleBack.ts/ambientCandidates.ts's router
 * validation. A passage citing zero valid topic ids after that check is
 * dropped entirely: every passage displayed must carry real, verified
 * drill-down material (its topics' own source messages), never bare
 * prose with nothing behind it.
 */
export interface ReportProsePassageResult {
  text: string;
  topics: ReportTopicCandidate[];
}

export interface GeneratedReportProse {
  passages: ReportProsePassageResult[];
  /** True when selectReportTopics found nothing eligible at all — the honest "not enough to say yet" case, distinct from a passage-generation failure. */
  noTopicsEligible: boolean;
}

export async function generateReportProse(report: ReportResult, entities: ReportTopicEntityInput[], apiKey: string, nowIso: string = new Date().toISOString()): Promise<GeneratedReportProse> {
  const topics = selectReportTopics(report, entities);
  if (topics.length === 0) {
    return { passages: [], noTopicsEligible: true };
  }

  const topicsById = new Map(topics.map((t) => [t.id, t]));
  const result = await generateReportProseViaOpenAi(apiKey, topics, nowIso);

  const passages: ReportProsePassageResult[] = [];
  for (const passage of result.passages) {
    const resolvedTopics = passage.topicIds.map((id) => topicsById.get(id)).filter((t): t is ReportTopicCandidate => t !== undefined);
    if (resolvedTopics.length === 0) continue; // model cited nothing real — never displayed
    if (!passage.text.trim()) continue;
    passages.push({ text: passage.text, topics: resolvedTopics });
  }

  return { passages, noTopicsEligible: false };
}
