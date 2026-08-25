import type { ReportTopicCandidate } from "./reportTopics.js";
import { ANTI_SYCOPHANCY_INSTRUCTION, REPORT_CONSTRAINTS_INSTRUCTION, REPORT_HONESTY_INSTRUCTION, REPORT_MECHANICS_INSTRUCTION, REPORT_NUMBERS_INSTRUCTION, REPORT_VOICE_AND_PURPOSE_INSTRUCTION } from "./proseInstructions.js";

/**
 * Report page, part 2 (EN-120). Structured JSON Schema for the prose call,
 * same strict-mode shape convention as taxonomySchema.ts/routerSchema.ts.
 * `topicIds` on each passage is validated after the call (generateReportProse.ts)
 * against the real candidate ids handed in — same "the model only ever
 * references a candidate it was actually given" discipline as everywhere
 * else structured output is trusted in this codebase.
 */
export const REPORT_PROSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    passages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          topicIds: { type: "array", items: { type: "string" } }
        },
        required: ["text", "topicIds"],
        additionalProperties: false
      }
    }
  },
  required: ["passages"],
  additionalProperties: false
} as const;

/**
 * Digit-free time description — month name only (Intl's "long" month
 * format contains no digits), plus "last year"/"this year" in words when
 * the message's year differs from now's, never a numeral. This is the
 * ONLY temporal grounding the prose model receives for a source message;
 * an exact date is never handed to it, the same "compute the qualitative
 * signal in code, never give the model raw data it could echo back"
 * discipline as reportTopics.ts's deviation/direction handling.
 */
export function describeRoughPeriod(iso: string, nowIso: string): string {
  const date = new Date(iso);
  const now = new Date(nowIso);
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  if (date.getUTCFullYear() === now.getUTCFullYear()) return month;
  return `${month}, the year before`;
}

function renderTopic(topic: ReportTopicCandidate, nowIso: string): string {
  const lines: string[] = [];
  lines.push(`--- Topic ${topic.id} (${topic.kind}) ---`);
  if (topic.entityName) lines.push(`Concerns: ${topic.entityName}`);
  if (topic.direction) lines.push(`This period reads as more "${topic.direction === "up" ? "active/present" : "quiet/faded"}" than this person's own usual pattern — do not name this as a measurement, use it only to shape tone.`);
  if (topic.hasSupportingWordClassSignal) lines.push(`How they were writing during this period also shifted somewhat — weak, supporting color only, never the main point of a passage on its own.`);
  lines.push(`Messages (their own words, roughly when each was said):`);
  for (const m of topic.sourceMessages) lines.push(`- (${describeRoughPeriod(m.recordedAt, nowIso)}) "${m.text}"`);
  return lines.join("\n");
}

export function buildReportProseSystemPrompt(topics: ReportTopicCandidate[], nowIso: string): string {
  const topicsBlock = topics.length > 0 ? topics.map((t) => renderTopic(t, nowIso)).join("\n\n") : "(no topics cleared the bar this time — say so honestly rather than writing about anything)";

  return `${REPORT_VOICE_AND_PURPOSE_INSTRUCTION}

${REPORT_NUMBERS_INSTRUCTION}

${REPORT_HONESTY_INSTRUCTION}

${REPORT_MECHANICS_INSTRUCTION}

${REPORT_CONSTRAINTS_INSTRUCTION}

${ANTI_SYCOPHANCY_INSTRUCTION}

TASK: write the report as a small number of short prose passages, each grounded in ONE OR MORE of the topics below (cite every topic id a passage actually draws from in that passage's topicIds — never a topic id a passage doesn't genuinely draw from, and never an id not listed below). You do not need one passage per topic — combine topics that genuinely belong together into one passage, or leave a topic out entirely if there's nothing real enough to say about it. If no topics are listed below, return an empty passages array rather than writing anything — there is nothing to write about yet, and that is a real, honest outcome, not a failure to paper over.

TOPICS:
${topicsBlock}

Return ONLY the JSON the schema requires.`;
}
