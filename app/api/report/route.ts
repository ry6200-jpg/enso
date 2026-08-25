import { NextResponse } from "next/server";
import { runReadOnlyUserSession } from "../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../lib/requireUser.js";
import { computeReport, hasAnyDisplayableData } from "../../../src/report/computeReport.js";

interface GenerateReportRequestBody {
  timezone?: string;
}

/**
 * Report page, Stage A (enso-report-methodology.md). Reached from the chat
 * header's kebab menu. Generates the Stage A markers.
 *
 * Read-only session — the report reads the event log and projections and
 * must never write to either (the report is not part of the corpus,
 * methodology Section 6 Q2). Previously used the write session only for
 * prediction capture (see the regression ledger / EN-119: prediction
 * capture removed, never asked for, came from the methodology doc rather
 * than a stated requirement); with that gone, nothing here writes anything
 * at all.
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
    return { displayable: true as const, report };
  });

  if (!result.displayable) {
    return NextResponse.json({ displayable: false });
  }
  return NextResponse.json({ displayable: true, report: result.report });
}
