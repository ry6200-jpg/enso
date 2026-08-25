import { NextResponse } from "next/server";
import { runReadOnlyUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { computeReport, hasAnyDisplayableData } from "../../../src/report/computeReport.js";
import { generateReportProse } from "../../../src/report/generateReportProse.js";

interface GenerateReportRequestBody {
  timezone?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env before starting the web app.`);
  return value;
}

/**
 * Report page, Stage A + prose layer (enso-report-methodology.md, EN-120).
 * Reached from the chat header's kebab menu.
 *
 * Read-only session — the report reads the event log and projections and
 * must never write to either (the report is not part of the corpus,
 * methodology Section 6 Q2). The prose call happens INSIDE the read-only
 * session (same pattern /api/chat already uses for its own LLM calls
 * while holding the write session's lock) — computeReport's numbers never
 * leave this function as numbers; generateReportProse's own topic-
 * selection layer (reportTopics.ts) is what decides whether there's
 * anything worth writing about at all, and makes zero API calls when
 * there isn't (EN-120).
 */
export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  let body: GenerateReportRequestBody;
  try {
    body = (await request.json()) as GenerateReportRequestBody;
  } catch {
    body = {};
  }
  const timezone = typeof body.timezone === "string" && body.timezone.trim() !== "" ? body.timezone : "UTC";

  const result = await runReadOnlyUserSession(userId, async ({ eventLog, projectionsDb }) => {
    if (!hasAnyDisplayableData(eventLog, userId)) {
      return { displayable: false as const };
    }
    const report = computeReport(eventLog, projectionsDb, userId, timezone);
    const entities = projectionsDb.listEntities(userId).map((e) => ({ id: e.id, name: e.name, sourceEventIds: JSON.parse(e.source_event_ids) as string[] }));
    const prose = await generateReportProse(report, entities, requireEnv("OPENAI_API_KEY"));
    return { displayable: true as const, prose };
  });

  if (!result.displayable) {
    return NextResponse.json({ displayable: false });
  }
  return NextResponse.json({ displayable: true, prose: result.prose });
}
