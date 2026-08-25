import OpenAI from "openai";
import { classifyProviderError } from "../providers/errors.js";
import { REPORT_PROSE_JSON_SCHEMA, buildReportProseSystemPrompt } from "./reportProseSchema.js";
import type { ReportTopicCandidate } from "./reportTopics.js";

/**
 * Report page, part 2 (EN-120). Single-provider v1, deliberately — this is
 * an on-demand, one-shot, user-triggered page, not a per-turn hot path, so
 * EN-083's certified-tier-with-fallback discipline (built for gates that
 * fire silently, automatically, every turn) isn't the right bar yet. A
 * fallback tier is a real future addition, not built here — flagged
 * plainly rather than silently assumed. Same model/call shape as
 * routerAdapters.ts's OpenAI adapter (gpt-5.6-terra, structured JSON
 * output, strict schema).
 */
export const OPENAI_REPORT_PROSE_MODEL = "gpt-5.6-terra";

export interface ReportProsePassage {
  text: string;
  topicIds: string[];
}

export interface ReportProseResult {
  passages: ReportProsePassage[];
  provider: "openai";
  model: string;
}

export async function generateReportProseViaOpenAi(apiKey: string, topics: ReportTopicCandidate[], nowIso: string): Promise<ReportProseResult> {
  const client = new OpenAI({ apiKey });
  let response;
  try {
    response = await client.responses.create({
      model: OPENAI_REPORT_PROSE_MODEL,
      instructions: buildReportProseSystemPrompt(topics, nowIso),
      input: "Write the report.",
      text: {
        format: {
          type: "json_schema",
          name: "report_prose",
          schema: REPORT_PROSE_JSON_SCHEMA,
          strict: true
        }
      }
    });
  } catch (err) {
    throw classifyProviderError(err);
  }

  const parsed = JSON.parse(response.output_text) as { passages: ReportProsePassage[] };
  return { passages: parsed.passages, provider: "openai", model: OPENAI_REPORT_PROSE_MODEL };
}
