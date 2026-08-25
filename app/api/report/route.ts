import { NextResponse } from "next/server";
import { runReadOnlyUserSession, runUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { computeReport, hasAnyDisplayableData } from "../../../src/report/computeReport.js";

interface GenerateReportRequestBody {
  central?: string;
  recurring?: string;
  absent?: string;
  timezone?: string;
}

/**
 * Report page, Stage A (enso-report-methodology.md). Reached from the
 * chat header's kebab menu. Captures a prediction (methodology Section
 * 4.1) and generates the Stage A markers in one round trip.
 *
 * Uses runUserSession, not the read-only variant, ONLY because the
 * prediction needs to survive checkin (see reportPredictionStore.ts) —
 * inside `work` below, eventLog/projectionsDb are never called through
 * any mutating method, matching this batch's own instruction that the
 * report must never write to the event log or projections: the report
 * is not part of the corpus (methodology Section 6, Q2). The only write
 * that happens is reportPredictions.save(), a plain JSON file entirely
 * separate from both.
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
  const central = typeof body.central === "string" ? body.central : "";
  const recurring = typeof body.recurring === "string" ? body.recurring : "";
  const absent = typeof body.absent === "string" ? body.absent : "";
  const timezone = typeof body.timezone === "string" && body.timezone.trim() !== "" ? body.timezone : "UTC";

  const result = await runUserSession(userId, async ({ eventLog, projectionsDb, reportPredictions }) => {
    if (!hasAnyDisplayableData(eventLog, userId)) {
      return { displayable: false as const };
    }
    const prediction = reportPredictions.save({ central, recurring, absent });
    const report = computeReport(eventLog, projectionsDb, userId, timezone);
    return { displayable: true as const, prediction, report };
  });

  if (!result.displayable) {
    return NextResponse.json({ displayable: false });
  }
  return NextResponse.json({ displayable: true, prediction: result.prediction, report: result.report });
}

/** Past predictions only, for showing history in the UI — read-only, no new prediction captured. */
export async function GET(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const predictions = await runReadOnlyUserSession(userId, async ({ reportPredictions }) => reportPredictions.list());
  return NextResponse.json({ predictions });
}
