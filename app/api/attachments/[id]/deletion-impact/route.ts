import { NextResponse } from "next/server";
import { computeDeletionImpact } from "../../../../../src/attachments/uploadDeletion.js";
import { getStores } from "../../../../../lib/serverPipeline.js";
import { authErrorResponse, requireUserId } from "../../../../../lib/requireUser.js";

/**
 * EN-065's "informed" half: the dry-run preview the UI shows BEFORE the
 * user confirms deletion ("This will also remove 2 facts learned only
 * from this file... 3 facts will be preserved"). Calls the exact same
 * computeDeletionImpact the real deletion (DELETE on the sibling route)
 * calls — never a separate prediction that could drift from what
 * deletion actually does.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  let userId: string;
  try {
    userId = await requireUserId(request);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  const { eventLog, projectionsDb } = getStores(userId);

  try {
    const impact = computeDeletionImpact(eventLog, projectionsDb, userId, id);
    return NextResponse.json(impact);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}
